import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { databaseFixture, seedInbox } from "./helpers/postgres.mjs";
import { api } from "../src/worker/api/index.ts";
import { receiveEmail } from "../src/worker/email/receive.ts";

// Local audit probes: external AI, email sending, and KV are all mocked.
async function fixture(t) {
  const db = await databaseFixture(t);
  const inbox = await seedInbox(db);
  const jobs = [], pending = [], sent = [];
  const env = {
    DB: db,
    DRAFT_QUEUE: { async send(job) { jobs.push(job); } },
    EMAIL: { async send(message) {
      sent.push(message);
      return { messageId: `outbound-${sent.length}@example.com` };
    } },
  };
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const app = new Hono().route("/api", api);
  const request = (path, method = "GET", body) => app.request(
    `https://mailroom.example/api${path}`,
    { method, headers: { Origin: "https://mailroom.example", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) }, env, ctx,
  );
  async function deliver(raw, to = inbox.address) {
    let rejection;
    await receiveEmail({ to, rawSize: Buffer.byteLength(raw), raw: new Response(raw).body,
      setReject(reason) { rejection = reason; } }, env, ctx);
    await Promise.all(pending.splice(0));
    assert.equal(rejection, undefined);
  }
  async function enableAi() {
    env.AI_API_KEY = "local-mock-key";
    await request("/settings/general", "PATCH", {
      ai_provider: "openai-compatible", ai_base_url: "https://ai.example/v1", ai_model: "mock-model",
    });
    await db.query("UPDATE mailboxes SET agent_mode = 'draft'");
  }
  return { db, inbox, jobs, sent, env, request, deliver, enableAi };
}

const mail = (id, { from = "customer@example.net", headers = "", body = "Question", subject = id } = {}) =>
  `From: ${from}\r\nTo: support@example.com\r\nMessage-ID: <${id}@example.net>\r\nSubject: ${subject}\r\n${headers}\r\n${body}`;

test("Web replies reject a stale recipient snapshot and require a snapshot", async (t) => {
  const f = await fixture(t);
  await f.deliver(mail("reviewed"));
  const original = await f.db.one("SELECT id, thread_id FROM messages");
  await f.deliver(mail("injected", { from: "attacker@example.org", headers: "In-Reply-To: <reviewed@example.net>\r\nReply-To: exfil@example.org\r\n" }));
  const payload = { attempt_id: "stale", text: "Private answer", inbound_message_id: original.id, expected_recipients: ["customer@example.net"] };
  assert.equal((await f.request(`/threads/${original.thread_id}/reply`, "POST", payload)).status, 409);
  delete payload.inbound_message_id;
  assert.equal((await f.request(`/threads/${original.thread_id}/reply`, "POST", payload)).status, 400);
  assert.equal(f.sent.length, 0);
});

test("Web replies validate text length before sending", async (t) => {
  const f = await fixture(t);
  await f.deliver(mail("long-reply"));
  const m = await f.db.one("SELECT id, thread_id FROM messages");
  for (const text of [42, "x".repeat(100001)]) {
    assert.equal((await f.request(`/threads/${m.thread_id}/reply`, "POST", {
      attempt_id: "large", text, inbound_message_id: m.id, expected_recipients: ["customer@example.net"],
    })).status, 400);
  }
  assert.equal(f.sent.length, 0);
});

test("Message-ID deduplication is scoped to the destination inbox", async (t) => {
  const f = await fixture(t);
  await f.db.query("INSERT INTO mailboxes (address, domain_id) VALUES ('help@example.com', $1)", [f.inbox.domain_id]);
  await f.deliver(mail("shared"));
  await f.deliver(mail("shared"), "help@example.com");
  await f.deliver(mail("shared"), "help@example.com");
  assert.equal((await f.db.one("SELECT count(*) AS n FROM messages")).n, 2);
});

test("Thread summaries omit large bodies and page older messages", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 25; i++) await f.deliver(mail(`page-${i}`, {
    headers: i ? "In-Reply-To: <page-0@example.net>\r\n" : "", body: "x".repeat(20000),
  }));
  const { id } = await f.db.one("SELECT id FROM threads");
  const body = await f.request(`/threads/${id}?summary=1`).then(r => r.text());
  const page = JSON.parse(body);
  assert.equal(page.messages.length, 20);
  assert.ok(Buffer.byteLength(body) < 60000);
  assert.ok(page.next_before);
  const older = await f.request(`/threads/${id}?summary=1&before=${page.next_before}`).then(r => r.json());
  assert.equal(older.messages.length, 5);
  assert.equal(older.next_before, null);
});

test("Anonymous dynamic registration is disabled", async () => {
  const source = await readFile(new URL("../src/mcp/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /clientRegistrationEndpoint:/);
  assert.match(source, /clientIdMetadataDocumentEnabled: false/);
});

test("Web reply rejects oversized multipart before reading attachments", async t => {
  const app = new Hono().route("/api", api);
  const body = new FormData();
  body.set("attachments", new File([new Uint8Array(4 * 1024 * 1024)], "large.bin"));
  const response = await app.request("https://mailroom.example/api/threads/1/reply", {
    method: "POST", headers: { Origin: "https://mailroom.example" }, body,
  }, { DB: { one() { assert.fail("Oversized request reached the database"); } } });
  assert.equal(response.status, 413);
});

test("classification, drafting, and manual revisions share the AI call budget", async t => {
  const f = await fixture(t);
  await f.enableAi();
  f.env.AI_DAILY_CALL_LIMIT = "3";
  await f.db.query("INSERT INTO labels (mailbox_id, name, condition) VALUES ($1, 'invoice', 'Invoice')", [f.inbox.id]);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    const content = body.messages[0].content.startsWith("Classify")
      ? JSON.stringify({ answers: { label_1: { noul: 0.9 } } }) : "PLAYBOOK: NONE\nREPLY:\nThanks.";
    return Response.json({ choices: [{ finish_reason: "stop", message: { content } }] });
  });
  await f.deliver(mail("budget-shared"));
  const { processDraftRun } = await import("../src/worker/agent/draft.ts");
  await processDraftRun(f.env, f.jobs[0].runId, f.jobs[0].dispatchId);
  const { id } = await f.db.one("SELECT id FROM threads");
  assert.equal((await f.request(`/threads/${id}/draft/revise`, "POST", { instruction: "Shorter" })).status, 200);
  assert.equal((await f.request(`/threads/${id}/draft/revise`, "POST", { instruction: "Again" })).status, 429);
  assert.equal(calls, 3);
});

test("message bodies are bounded and the complete inbound MIME remains downloadable", async t => {
  const f = await fixture(t);
  await f.deliver(mail("large-body", { body: "x".repeat(200000) }));
  const { id } = await f.db.one("SELECT id FROM messages");
  const body = await f.request(`/messages/${id}/body`).then(r => r.json());
  assert.equal(body.text_body.length, 128000);
  assert.equal(body.truncated, true);
  const original = await f.request(`/messages/${id}/download`);
  assert.equal(original.status, 200);
  assert.match(original.headers.get("Content-Disposition"), /^attachment/);
  assert.match(await original.text(), /x{200000}/);
});

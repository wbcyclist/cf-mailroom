import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { databaseFixture, seedInbox } from "./helpers/postgres.mjs";
import { api } from "../src/worker/api/index.ts";
import { receiveEmail } from "../src/worker/email/receive.ts";
import {
  searchConversations,
  getConversation,
  listInboxes,
} from "../src/worker/inbox/conversations.ts";
import { enqueueDraftRun } from "../src/worker/agent/runs.ts";
import { processDraftRun } from "../src/worker/agent/draft.ts";

async function fixture(t) {
  const db = await databaseFixture(t);
  const inbox = await seedInbox(db);
  const app = new Hono().route("/api", api);
  const jobs = [];
  const pending = [];
  const env = {
    DB: db,
    DRAFT_QUEUE: {
      async send(job) {
        jobs.push(job);
      },
    },
  };
  const ctx = {
    waitUntil(promise) {
      pending.push(promise);
    },
  };
  const request = (path, method = "GET", body) =>
    app.request(
      `https://mailroom.example/api${path}`,
      {
        method,
        headers: {
          Origin: "https://mailroom.example",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      env,
      ctx,
    );
  async function deliver(raw) {
    let rejection;
    await receiveEmail(
      {
        to: inbox.address,
        rawSize: Buffer.byteLength(raw),
        raw: new Response(raw).body,
        setReject(reason) {
          rejection = reason;
        },
      },
      env,
      ctx,
    );
    await Promise.all(pending.splice(0));
    assert.equal(rejection, undefined);
  }
  return { db, env, jobs, request, deliver, inbox };
}

const mail = (
  id,
  subject = "Invoice",
  headers = "",
  body = "Refund for invoice 42",
) =>
  `From: Customer <customer@example.net>\r\nTo: support@example.com\r\nMessage-ID: <${id}@example.net>\r\nSubject: ${subject}\r\n${headers}\r\n${body}`;

const externalAi = (provider = "openai-compatible") => ({
  ai_provider: provider, ai_base_url: "https://ai.example/v1", ai_model: "test-model",
});

test("AI is disabled by default; settings round-trip without exposing the secret", async (t) => {
  const f = await fixture(t);
  const initial = await f.request("/settings/general").then((r) => r.json());
  assert.equal(initial.ai_provider, "disabled");
  assert.equal(initial.ai_workers_available, false);
  assert.equal(initial.ai_external_available, false);
  f.env.AI_API_KEY = "secret-do-not-expose";
  for (const config of [
    externalAi(), externalAi("openai-responses"),
    { ai_provider: "workers-ai", ai_model: null, ai_base_url: null },
    { ai_provider: "disabled", ai_model: null, ai_base_url: null },
  ]) {
    const response = await f.request("/settings/general", "PATCH", config);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, ...config });
    const saved = await f.request("/settings/general").then((r) => r.json());
    for (const key of Object.keys(config)) assert.equal(saved[key], config[key]);
    assert.equal(saved.ai_external_available, true);
    assert.ok(!JSON.stringify(saved).includes(f.env.AI_API_KEY));
  }
  for (const config of [{}, { ai_provider: "other" }, { ...externalAi(), ai_base_url: "http://localhost" }]) {
    assert.equal((await f.request("/settings/general", "PATCH", config)).status, 400);
  }
  assert.equal((await f.db.one("SELECT ai_provider FROM global_settings")).ai_provider, "disabled");
});

test("disabled or unconfigured AI stores mail without calls or queued drafts", async (t) => {
  const f = await fixture(t);
  t.mock.method(globalThis, "fetch", () => assert.fail("Unexpected paid call"));
  await f.db.query("UPDATE mailboxes SET agent_mode = 'draft'");
  await f.db.query("INSERT INTO labels (mailbox_id, name, condition) VALUES ($1, 'invoice', 'Invoice request')", [f.inbox.id]);
  for (const [i, config] of [
    { ai_provider: "disabled" }, externalAi(), { ai_provider: "workers-ai" },
  ].entries()) {
    assert.equal((await f.request("/settings/general", "PATCH", config)).status, 200);
    await f.deliver(mail(`no-ai-${i}`, `Subject ${i}`));
    const msg = await f.db.one("SELECT thread_id FROM messages ORDER BY id DESC LIMIT 1");
    assert.equal((await f.request(`/threads/${msg.thread_id}/draft`, "POST")).status, 503);
    assert.equal((await f.request(`/threads/${msg.thread_id}/draft/revise`, "POST", { instruction: "Rewrite" })).status, 503);
  }
  assert.equal((await f.db.one("SELECT count(*) AS n FROM messages")).n, 3);
  assert.equal((await f.db.one("SELECT count(*) AS n FROM draft_runs")).n, 0);
  assert.deepEqual(f.jobs, []);
});

for (const provider of ["openai-compatible", "openai-responses"]) {
  test(`${provider} labels, drafts, and revises through PostgreSQL without Workers AI`, async (t) => {
    const f = await fixture(t);
    f.env.AI_API_KEY = "test-secret";
    await f.request("/settings/general", "PATCH", externalAi(provider));
    await f.db.query("UPDATE mailboxes SET agent_mode = 'draft'");
    const label = await f.db.one("INSERT INTO labels (mailbox_id, name, condition) VALUES ($1, 'invoice', 'Invoice request') RETURNING id", [f.inbox.id]);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.equal(body.model, "test-model");
      assert.equal(body.store, false);
      const instructions = provider === "openai-responses" ? body.instructions : body.messages[0].content;
      const text = instructions.startsWith("Classify")
        ? JSON.stringify({ answers: { [`label_${label.id}`]: { noul: 0.9 }, label_999: { noul: 1 } } })
        : "PLAYBOOK: NONE\nREPLY:\nPlease send your order number.";
      return Response.json(provider === "openai-responses"
        ? { status: "completed", output: [{ type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text }] }] }
        : { choices: [{ finish_reason: "stop", message: { content: text } }] });
    });
    await f.deliver(mail(`external-${provider}`));
    assert.equal(calls, 1);
    assert.equal(f.jobs.length, 1);
    assert.equal((await f.db.one("SELECT count(*) AS n FROM thread_labels")).n, 1);
    await processDraftRun(f.env, f.jobs[0].runId);
    assert.equal(calls, 2);
    const run = await f.db.one("SELECT * FROM draft_runs");
    assert.equal(run.status, "ready");
    const draft = await f.db.one("SELECT * FROM drafts WHERE id = $1", [run.draft_id]);
    assert.equal(draft.text_body, "Please send your order number.");
    assert.match(draft.agent_notes, /test-model/);
    await processDraftRun(f.env, run.id);
    assert.equal(calls, 2);
    assert.equal((await f.request(`/threads/${run.thread_id}/draft/revise`, "POST", { instruction: "Shorter" })).status, 200);
    assert.equal(calls, 3);
  });
}

test("draft revision exposes safe AI errors and preserves the pending draft", async (t) => {
  const f = await fixture(t);
  await f.deliver(mail("revision-error"));
  f.env.AI_API_KEY = "secret-do-not-expose";
  await f.request("/settings/general", "PATCH", externalAi("openai-responses"));
  const { thread_id: threadId } = await f.db.one("SELECT thread_id FROM messages");
  const draft = await f.db.one(
    "INSERT INTO drafts (thread_id, text_body, created_by, status) VALUES ($1, 'Keep this draft', 'agent', 'pending') RETURNING *",
    [threadId],
  );
  for (const [result, expected] of [
    [() => new Response("secret-do-not-expose private email", { status: 401 }), "AI request failed (HTTP 401)"],
    [() => Response.json({ status: "incomplete" }), "AI response did not complete"],
    [() => { throw new Error("secret-do-not-expose private email"); }, "AI request failed or timed out"],
  ]) {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return result(); });
    const response = await f.request(`/threads/${threadId}/draft/revise`, "POST", {
      instruction: "Shorter", current_text: draft.text_body,
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: expected });
    assert.equal(calls, 1);
    assert.deepEqual((await f.db.query("SELECT * FROM drafts")).rows, [draft]);
  }
});

test("provider failure is safe to redeliver; only an explicit retry can call AI again", async (t) => {
  const f = await fixture(t);
  f.env.AI_API_KEY = "secret-do-not-log";
  await f.request("/settings/general", "PATCH", externalAi());
  await f.db.query("UPDATE mailboxes SET agent_mode = 'draft'");
  await f.deliver(mail("failed-ai"));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("secret-do-not-log private email", { status: 401 });
  });
  const id = f.jobs[0].runId;
  await processDraftRun(f.env, id);
  await processDraftRun(f.env, id);
  assert.equal(calls, 1);
  const run = await f.db.one("SELECT * FROM draft_runs WHERE id = $1", [id]);
  assert.equal(run.status, "failed");
  assert.equal(run.error, "AI request failed (HTTP 401)");
  assert.equal((await f.db.one("SELECT count(*) AS n FROM drafts")).n, 0);
  await f.deliver(mail("failed-ai"));
  assert.equal(f.jobs.length, 1, "Duplicate mail must not retry a failed model call");
  assert.equal((await f.request(`/draft-runs/${id}/retry`, "POST")).status, 200);
  await processDraftRun(f.env, id);
  assert.equal(calls, 2);
  await f.request("/settings/general", "PATCH", { ai_provider: "disabled" });
  assert.equal((await f.request(`/draft-runs/${id}/retry`, "POST")).status, 503);
});

test("disabling AI stops already queued jobs without discarding manual email features", async (t) => {
  const f = await fixture(t);
  f.env.AI_API_KEY = "test-secret";
  await f.request("/settings/general", "PATCH", externalAi());
  await f.db.query("UPDATE mailboxes SET agent_mode = 'draft'");
  await f.deliver(mail("disable-queued"));
  await f.request("/settings/general", "PATCH", { ai_provider: "disabled" });
  t.mock.method(globalThis, "fetch", () => assert.fail("Unexpected paid call"));
  await processDraftRun(f.env, f.jobs[0].runId);
  const run = await f.db.one("SELECT * FROM draft_runs");
  assert.equal(run.status, "failed");
  assert.match(run.error, /AI is disabled/);
  assert.equal((await f.request(`/threads/${run.thread_id}`)).status, 200);
});

test("concurrent draft enqueue and delivery claim one paid request", async (t) => {
  const f = await fixture(t);
  await f.deliver(mail("concurrent-ai"));
  f.env.AI_API_KEY = "test-secret";
  await f.request("/settings/general", "PATCH", externalAi());
  await f.db.query("UPDATE mailboxes SET agent_mode = 'draft'");
  const msg = await f.db.one("SELECT id, thread_id FROM messages");
  const ids = await Promise.all(Array.from({ length: 8 }, () => enqueueDraftRun(f.env, msg.thread_id, msg.id)));
  assert.equal(new Set(ids).size, 1);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    // A duplicate arriving during generation must not reopen the claimed run.
    await enqueueDraftRun(f.env, msg.thread_id, msg.id, { retryFailed: true });
    assert.equal((await f.db.one("SELECT status FROM draft_runs")).status, "generating");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "PLAYBOOK: NONE\nREPLY:\nThanks." } }] });
  });
  await Promise.all(f.jobs.map((job) => processDraftRun(f.env, job.runId)));
  assert.equal(calls, 1);
  assert.equal((await f.db.one("SELECT count(*) AS n FROM drafts")).n, 1);
});

test("inbound MIME, attachments, deduplication, threading and downloads use PostgreSQL", async (t) => {
  const f = await fixture(t);
  const raw = await readFile(
    new URL("../scripts/test-email-attachment.eml", import.meta.url),
    "utf8",
  );
  await Promise.all([f.deliver(raw), f.deliver(raw)]);
  assert.equal((await f.db.one("SELECT count(*) AS n FROM messages")).n, 1);
  const files = (
    await f.db.query("SELECT content, content_type FROM stored_files")
  ).rows;
  assert.equal(
    files
      .find((row) => row.content_type === "message/rfc822")
      .content.toString(),
    raw,
  );
  const attachment = await f.db.one("SELECT * FROM attachments");
  const download = await f.request(`/attachments/${attachment.id}`);
  assert.equal(download.status, 200);
  const stored = await f.db.one(
    "SELECT content FROM stored_files WHERE key = $1",
    [attachment.file_key],
  );
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), stored.content);
  assert.equal(download.headers.get("X-Content-Type-Options"), "nosniff");
  const first = await f.db.one("SELECT * FROM messages");
  await f.deliver(
    mail(
      "reply",
      "Re: Invoice",
      `References: ${Array.from({ length: 110 }, (_, i) => `<old-${i}@x.test>`).join(" ")} ${first.message_id}\r\n`,
    ),
  );
  assert.equal((await f.db.one("SELECT count(*) AS n FROM threads")).n, 1);
  assert.equal(
    (await f.db.one("SELECT message_count FROM threads")).message_count,
    2,
  );
  assert.equal(
    (await f.request("/mailboxes").then((r) => r.json()))[0].has_received,
    true,
  );
  const detail = await f
    .request(`/threads/${first.thread_id}`)
    .then((r) => r.json());
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[0].attachments.length > 0, true);
});

test("inbound failure rolls back the conversation, raw MIME and attachment writes", async (t) => {
  const f = await fixture(t);
  await f.db
    .query(`CREATE FUNCTION reject_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected attachment failure'; END $$;
    CREATE TRIGGER reject_attachment BEFORE INSERT ON attachments FOR EACH ROW EXECUTE FUNCTION reject_attachment();`);
  const raw = await readFile(
    new URL("../scripts/test-email-attachment.eml", import.meta.url),
    "utf8",
  );
  await assert.rejects(f.deliver(raw), /injected attachment failure/);
  for (const table of ["threads", "messages", "stored_files", "attachments"]) {
    assert.equal((await f.db.one(`SELECT count(*) AS n FROM ${table}`)).n, 0);
  }
});

test("Web and MCP lists support PostgreSQL search, labels, pagination and bulk updates", async (t) => {
  const f = await fixture(t);
  await f.deliver(mail("one"));
  await f.deliver(
    mail("two", "Invoice update", "", "50% refund with underscore_code"),
  );
  const newest = await f.db.one(
    "SELECT * FROM threads ORDER BY last_message_at DESC, id DESC LIMIT 1",
  );
  let response = await f.request("/labels", "POST", {
    mailbox_id: f.inbox.id,
    name: "Refund",
    condition: "A refund request",
  });
  assert.equal(response.status, 201);
  const label = await response.json();
  await f.db.query(
    "INSERT INTO thread_labels (thread_id, label_id) VALUES ($1, $2)",
    [newest.id, label.id],
  );
  for (const path of [
    "/threads",
    `/threads?mailbox_id=${f.inbox.id}`,
    `/threads?label_id=${label.id}`,
    "/search?q=refund",
    "/search?q=%22invoice%22%20OR%20refund",
    `/search?q=refund&mailbox_id=${f.inbox.id}&label_id=${label.id}&unread=1`,
  ]) {
    response = await f.request(path);
    assert.equal(response.status, 200, path);
    assert.ok((await response.json()).length > 0, path);
  }
  const page = await f
    .request(
      `/threads?before_at=${encodeURIComponent(newest.last_message_at)}&before_id=${newest.id}`,
    )
    .then((r) => r.json());
  assert.equal(page.length, 1);
  const search = await searchConversations(f.env, {
    limit: 1,
    inboxId: f.inbox.id,
    unread: true,
    query: "refund",
  });
  assert.equal(search.conversations.length, 1);
  assert.ok(search.next_cursor);
  assert.equal(
    (
      await searchConversations(f.env, {
        limit: 1,
        inboxId: f.inbox.id,
        unread: true,
        query: "refund",
        cursor: search.next_cursor,
      })
    ).conversations.length,
    1,
  );
  assert.equal(
    (await searchConversations(f.env, { limit: 10, query: "50%" }))
      .conversations.length,
    1,
  );
  assert.equal((await listInboxes(f.env)).inboxes[0].unread_count, 2);
  assert.equal((await getConversation(f.env, newest.id, 1)).messages.length, 1);
  response = await f.request("/threads/bulk", "POST", {
    ids: [newest.id],
    action: "read",
  });
  assert.deepEqual(await response.json(), { ok: true, updated: 1 });
  assert.equal(
    (
      await f.request(`/labels/${label.id}`, "PATCH", {
        name: "Resolved",
        condition: "Resolved request",
      })
    ).status,
    200,
  );
  assert.equal((await f.request(`/labels/${label.id}`, "DELETE")).status, 200);
});

test("settings, domains, inboxes, playbooks and draft queues use native PostgreSQL queries", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/settings/general")).status, 200);
  assert.equal(
    (
      await f.request("/settings/general", "PATCH", {
        ai_provider: "workers-ai",
        ai_model: "openai/gpt-6-luna",
      })
    ).status,
    200,
  );
  const domain = await f
    .request("/domains", "POST", { name: "other.example" })
    .then((r) => r.json());
  assert.equal(
    (await f.request(`/domains/${domain.id}/activate`, "POST")).status,
    200,
  );
  const inbox = await f
    .request("/mailboxes", "POST", { domain_id: domain.id, local_part: "help" })
    .then((r) => r.json());
  assert.ok(inbox.id);
  assert.equal(
    (
      await f.request(`/mailboxes/${inbox.id}`, "PATCH", {
        agent_mode: "draft",
        agent_instructions: "Reply briefly",
      })
    ).status,
    200,
  );
  const playbook = await f
    .request("/playbooks", "POST", {
      mailbox_id: f.inbox.id,
      name: "Returns",
      when_to_use: "Refunds",
      instructions: "Ask for an order number",
    })
    .then((r) => r.json());
  assert.ok(playbook.id);
  assert.equal(
    (
      await f.request(`/playbooks/${playbook.id}`, "PATCH", {
        name: "Updated",
        enabled: false,
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request(`/playbooks?mailbox_id=${f.inbox.id}`)).status,
    200,
  );
  assert.equal(
    (await f.request(`/playbooks/${playbook.id}`, "DELETE")).status,
    200,
  );
  await f.deliver(
    mail("draft", "Automated", "Auto-Submitted: auto-generated\r\n"),
  );
  const msg = await f.db.one("SELECT id, thread_id FROM messages");
  f.env.AI = { run() { assert.fail("Unexpected paid call"); } };
  const run = await enqueueDraftRun(f.env, msg.thread_id, msg.id);
  assert.deepEqual(f.jobs.map(({ runId }) => ({ runId })), [{ runId: run }]);
  // An automated message must be rejected before invoking the paid model.
  await f.db.query("UPDATE mailboxes SET agent_mode = 'draft' WHERE id = $1", [
    f.inbox.id,
  ]);
  await processDraftRun(f.env, run);
  assert.equal(
    (await f.db.one("SELECT status FROM draft_runs WHERE id = $1", [run]))
      .status,
    "superseded",
  );
});

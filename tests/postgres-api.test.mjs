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
  const run = await enqueueDraftRun(f.env, msg.thread_id, msg.id);
  assert.deepEqual(f.jobs, [{ runId: run }]);
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

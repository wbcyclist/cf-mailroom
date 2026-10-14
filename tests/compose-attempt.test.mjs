import test from "node:test";
import assert from "node:assert/strict";
import {
  ComposeIntentError,
  sendNewEmailAttempt,
} from "../src/worker/email/compose.ts";

import { databaseFixture, seedInbox } from "./helpers/postgres.mjs";
async function makeFixture(t, { fail = false } = {}) {
  const db = await databaseFixture(t);
  await seedInbox(db);
  const sent = [];
  return {
    db,
    env: {
      DB: db,
      EMAIL: {
        async send(message) {
          sent.push(message);
          if (fail) throw new Error("provider unavailable");
          return { messageId: "outbound@example.com" };
        },
      },
    },
    sends: () => sent.length,
    sent: () => sent,
  };
}

const intent = {
  attemptId: "mcp_send_stable-key",
  mailboxId: 1,
  to: ["Customer@Example.com"],
  subject: "Hello",
  text: "A durable message",
  actorId: "owner@example.com",
  oauthClientId: "test-client",
};

test("a new-email Send Attempt is recorded in the inbox and sent once", async (t) => {
  const fixture = await makeFixture(t);

  const first = await sendNewEmailAttempt(fixture.env, intent);
  const replay = await sendNewEmailAttempt(fixture.env, intent);

  assert.equal(first.status, "sent");
  assert.deepEqual(replay, first);
  assert.equal(fixture.sends(), 1);
  assert.equal(
    (await fixture.db.one("SELECT count(*) AS n FROM messages")).n,
    1,
  );
  assert.equal(
    (await fixture.db.one("SELECT sent_by FROM messages")).sent_by,
    "agent",
  );
  assert.equal(fixture.sent()[0].headers["Auto-Submitted"], "auto-generated");
  assert.equal(
    (
      await fixture.db.one("SELECT message_count FROM threads WHERE id = $1", [
        first.conversation_id,
      ])
    ).message_count,
    1,
  );
});

test("a new-email idempotency key cannot be reused for different content", async (t) => {
  const fixture = await makeFixture(t);
  await sendNewEmailAttempt(fixture.env, intent);

  await assert.rejects(
    sendNewEmailAttempt(fixture.env, { ...intent, subject: "Different" }),
    (error) => error instanceof ComposeIntentError && error.status === 409,
  );
  assert.equal(fixture.sends(), 1);
});

test("a provider-accepted Send Attempt finalizes without sending again", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.db.query(
    "INSERT INTO threads (id, mailbox_id, last_message_at) VALUES (42, 1, now())",
  );
  await insertAttempt(fixture.db, {
    id: "mcp_send_recover",
    mailbox_id: 1,
    thread_id: 42,
    status: "sending",
    to_addresses: JSON.stringify(["Customer@example.com"]),
    subject: "Recover",
    text_body: "Already accepted",
    actor_id: "owner@example.com",
    oauth_client_id: null,
    message_id: "accepted@example.com",
    error: null,
  });

  const result = await sendNewEmailAttempt(fixture.env, {
    attemptId: "mcp_send_recover",
    mailboxId: 1,
    to: ["Customer@Example.com"],
    subject: "Recover",
    text: "Already accepted",
    actorId: "owner@example.com",
  });

  assert.equal(result.status, "sent");
  assert.equal(fixture.sends(), 0);
  assert.equal(
    (await fixture.db.one("SELECT count(*) AS n FROM messages")).n,
    1,
  );
});

test("a new email with attachments is staged, sent, and recorded", async (t) => {
  const fixture = await makeFixture(t);
  const withAttachment = {
    ...intent,
    attemptId: "mcp_send_attach",
    attachments: [
      {
        filename: "invoice.pdf",
        contentType: "application/pdf",
        content: new Uint8Array([37, 80]),
      },
    ],
  };

  const first = await sendNewEmailAttempt(fixture.env, withAttachment);
  const replay = await sendNewEmailAttempt(fixture.env, withAttachment);

  assert.equal(first.status, "sent");
  assert.deepEqual(replay, first);
  assert.equal(fixture.sends(), 1);
  assert.equal(fixture.sent()[0].attachments[0].filename, "invoice.pdf");
  assert.equal(
    (await fixture.db.one("SELECT count(*) AS n FROM attachments")).n,
    1,
  );
  assert.ok(
    (await fixture.db.one("SELECT key FROM stored_files")).key.startsWith(
      "attachments/1/outbound/mcp_send_attach/",
    ),
  );
});

test("a Send Attempt id cannot be reused with different attachments", async (t) => {
  const fixture = await makeFixture(t);
  await sendNewEmailAttempt(fixture.env, {
    ...intent,
    attemptId: "mcp_send_att_conflict",
    attachments: [
      { filename: "a.txt", contentType: "text/plain", content: "a" },
    ],
  });

  await assert.rejects(
    sendNewEmailAttempt(fixture.env, {
      ...intent,
      attemptId: "mcp_send_att_conflict",
      attachments: [
        { filename: "b.txt", contentType: "text/plain", content: "b" },
      ],
    }),
    (error) => error instanceof ComposeIntentError && error.status === 409,
  );
  assert.equal(fixture.sends(), 1);
});

async function insertAttempt(db, row) {
  const keys = Object.keys(row);
  await db.query(
    `INSERT INTO outbound_attempts (${keys.join(", ")}) VALUES (${keys.map((_, i) => "$" + (i + 1)).join(", ")})`,
    Object.values(row),
  );
}

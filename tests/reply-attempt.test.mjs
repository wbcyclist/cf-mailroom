import test from "node:test";
import assert from "node:assert/strict";
import {
  ReplyIntentError,
  sendReplyAttempt,
} from "../src/worker/email/reply.ts";

import { databaseFixture, seedInbox } from "./helpers/postgres.mjs";
async function makeFixture(t, { fail = false } = {}) {
  const db = await databaseFixture(t);
  await seedInbox(db);
  await db.query(`INSERT INTO threads (id, mailbox_id, subject, last_message_at) VALUES (1, 1, 'Help', now());
    INSERT INTO messages (id, thread_id, message_id, direction, from_address, reply_to_addresses)
    VALUES (9, 1, '<inbound@example.com>', 'inbound', 'form@example.com', '["customer@example.com"]');`);
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

test("replaying one Reply Attempt returns the stored result without sending twice", async (t) => {
  const fixture = await makeFixture(t);
  const intent = { attemptId: "attempt-1", threadId: 1, text: "Hello" };

  const first = await sendReplyAttempt(fixture.env, intent);
  const replay = await sendReplyAttempt(fixture.env, intent);

  assert.equal(first.status, "sent");
  assert.deepEqual(replay, first);
  assert.equal(fixture.sends(), 1);
});

test("a failed Reply Attempt is not automatically sent again", async (t) => {
  const fixture = await makeFixture(t, { fail: true });
  const intent = { attemptId: "attempt-2", threadId: 1, text: "Hello" };

  const first = await sendReplyAttempt(fixture.env, intent);
  const replay = await sendReplyAttempt(fixture.env, intent);

  assert.equal(first.status, "failed");
  assert.equal(replay.status, "failed");
  assert.equal(fixture.sends(), 1);
});

test("a Reply Attempt id cannot be reused for different content", async (t) => {
  const fixture = await makeFixture(t);
  await sendReplyAttempt(fixture.env, {
    attemptId: "attempt-3",
    threadId: 1,
    text: "First",
  });

  await assert.rejects(
    sendReplyAttempt(fixture.env, {
      attemptId: "attempt-3",
      threadId: 1,
      text: "Changed",
    }),
    (error) => error instanceof ReplyIntentError && error.status === 409,
  );
  assert.equal(fixture.sends(), 1);
});

test("a pending Reply Attempt resumes safely after an interrupted request", async (t) => {
  const fixture = await makeFixture(t);
  await insertAttempt(fixture.db, {
    id: "attempt-4",
    thread_id: 1,
    inbound_message_id: 9,
    draft_id: null,
    status: "pending",
    text_body: "Resume me",
    to_addresses: JSON.stringify(["customer@example.com"]),
    message_id: null,
    error: null,
  });

  const result = await sendReplyAttempt(fixture.env, {
    attemptId: "attempt-4",
    threadId: 1,
    text: "Resume me",
  });

  assert.equal(result.status, "sent");
  assert.equal(fixture.sends(), 1);
});

test("a provider-accepted Reply Attempt finalizes without sending again", async (t) => {
  const fixture = await makeFixture(t);
  await insertAttempt(fixture.db, {
    id: "attempt-5",
    thread_id: 1,
    inbound_message_id: 9,
    draft_id: null,
    status: "sending",
    text_body: "Already accepted",
    to_addresses: JSON.stringify(["customer@example.com"]),
    message_id: "outbound@example.com",
    error: null,
    sent_by: "human",
    actor_id: null,
    oauth_client_id: null,
  });

  const result = await sendReplyAttempt(fixture.env, {
    attemptId: "attempt-5",
    threadId: 1,
    text: "Already accepted",
  });

  assert.equal(result.status, "sent");
  assert.equal(fixture.sends(), 0);
});

test("replying to a stale inbound Message requires rereading the Conversation", async (t) => {
  const fixture = await makeFixture(t);

  await assert.rejects(
    sendReplyAttempt(fixture.env, {
      attemptId: "attempt-6",
      threadId: 1,
      inboundMessageId: 8,
      expectedRecipients: ["customer@example.com"],
      text: "Stale reply",
    }),
    (error) => error instanceof ReplyIntentError && error.status === 409,
  );
  assert.equal(fixture.sends(), 0);
});

test("reply recipients must match the target that the caller reviewed", async (t) => {
  const fixture = await makeFixture(t);

  await assert.rejects(
    sendReplyAttempt(fixture.env, {
      attemptId: "attempt-7",
      threadId: 1,
      inboundMessageId: 9,
      expectedRecipients: ["victim@example.com"],
      text: "Wrong target",
    }),
    (error) => error instanceof ReplyIntentError && error.status === 409,
  );
  assert.equal(fixture.sends(), 0);
});

test("the daily send budget blocks an agent before provider delivery", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.db.query(
    "INSERT INTO mcp_send_budget (actor_id, budget_date, send_count) VALUES ($1, $2, 100)",
    ["owner-subject", new Date().toISOString().slice(0, 10)],
  );

  await assert.rejects(
    sendReplyAttempt(fixture.env, {
      attemptId: "attempt-8",
      threadId: 1,
      inboundMessageId: 9,
      expectedRecipients: ["customer@example.com"],
      text: "Over budget",
      actorId: "owner-subject",
      dailySendLimit: 100,
    }),
    (error) => error instanceof ReplyIntentError && error.status === 429,
  );
  assert.equal(fixture.sends(), 0);
});

test("a reply with attachments is stored in PostgreSQL, sent, and recorded once", async (t) => {
  const fixture = await makeFixture(t);
  const intent = {
    attemptId: "attempt-att",
    threadId: 1,
    text: "See attached",
    attachments: [
      { filename: "log.txt", contentType: "text/plain", content: "hello" },
    ],
  };

  const first = await sendReplyAttempt(fixture.env, intent);
  const replay = await sendReplyAttempt(fixture.env, intent);

  assert.equal(first.status, "sent");
  assert.deepEqual(replay, first);
  assert.equal(fixture.sends(), 1);
  assert.equal(fixture.sent()[0].attachments.length, 1);
  assert.equal(fixture.sent()[0].attachments[0].filename, "log.txt");
  assert.equal(fixture.sent()[0].attachments[0].type, "text/plain");
  assert.equal(
    (await fixture.db.one("SELECT count(*) AS n FROM attachments")).n,
    1,
  );
  assert.equal(
    (await fixture.db.one("SELECT filename FROM attachments")).filename,
    "log.txt",
  );
  const { key: fileKey } = await fixture.db.one("SELECT key FROM stored_files");
  assert.ok(fileKey.startsWith("attachments/1/outbound/attempt-att/"));
  assert.equal(
    (await fixture.db.one("SELECT file_key FROM attachments")).file_key,
    fileKey,
  );
});

test("an attachment-only reply sends without text", async (t) => {
  const fixture = await makeFixture(t);
  const result = await sendReplyAttempt(fixture.env, {
    attemptId: "attempt-file-only",
    threadId: 1,
    text: "",
    attachments: [
      {
        filename: "doc.pdf",
        contentType: "application/pdf",
        content: new Uint8Array([1, 2]),
      },
    ],
  });
  assert.equal(result.status, "sent");
  assert.equal(fixture.sends(), 1);
});

test("an attempt id cannot be reused with different attachments", async (t) => {
  const fixture = await makeFixture(t);
  await sendReplyAttempt(fixture.env, {
    attemptId: "attempt-att-2",
    threadId: 1,
    text: "Here",
    attachments: [
      { filename: "a.txt", contentType: "text/plain", content: "a" },
    ],
  });

  await assert.rejects(
    sendReplyAttempt(fixture.env, {
      attemptId: "attempt-att-2",
      threadId: 1,
      text: "Here",
      attachments: [
        { filename: "b.txt", contentType: "text/plain", content: "b" },
      ],
    }),
    (error) => error instanceof ReplyIntentError && error.status === 409,
  );
  assert.equal(fixture.sends(), 1);
});

async function insertAttempt(db, row) {
  const keys = Object.keys(row);
  await db.query(
    `INSERT INTO reply_attempts (${keys.join(", ")}) VALUES (${keys.map((_, i) => "$" + (i + 1)).join(", ")})`,
    Object.values(row),
  );
}

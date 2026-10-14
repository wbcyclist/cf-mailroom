import test from "node:test";
import assert from "node:assert/strict";
import { databaseFixture } from "./helpers/postgres.mjs";
import { deleteInbox, InboxDeletionError } from "../src/worker/inbox/delete.ts";

async function makeFixture(t) {
  const database = await databaseFixture(t);
  await database.query(`
    INSERT INTO domains (id, name, status) VALUES (1, 'example.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES
      (1, 'support@example.com', 1),
      (2, 'sales@example.com', 1);
    INSERT INTO threads
      (id, mailbox_id, subject, normalized_subject, snippet, message_count, last_message_at)
    VALUES
      (10, 1, 'Target', 'target', 'target', 1, '2026-09-01T00:00:00.000Z'),
      (20, 2, 'Sibling', 'sibling', 'sibling', 1, '2026-09-01T00:00:00.000Z');
    INSERT INTO stored_files (key, mailbox_id, content, content_type) VALUES
      ('raw/1/target.eml', 1, decode('00ff', 'hex'), 'message/rfc822'),
      ('attachments/1/100/file', 1, decode('00ff', 'hex'), 'text/plain'),
      ('raw/2/sibling.eml', 2, decode('00ff', 'hex'), 'message/rfc822');
    INSERT INTO messages
      (id, thread_id, message_id, direction, from_address, subject, text_body, raw_key)
    VALUES
      (100, 10, '<target@example.com>', 'inbound', 'customer@example.net', 'Target', 'Target body', 'raw/1/target.eml'),
      (200, 20, '<sibling@example.com>', 'inbound', 'customer@example.net', 'Sibling', 'Sibling body', 'raw/2/sibling.eml');
    INSERT INTO attachments (id, message_id, content_type, size, file_key)
    VALUES (1000, 100, 'text/plain', 6, 'attachments/1/100/file');
    INSERT INTO playbooks (id, mailbox_id, name, when_to_use, instructions)
    VALUES (1000, 1, 'Returns', 'A return request', 'Reply carefully');
    INSERT INTO drafts
      (id, thread_id, text_body, created_by, playbook_id, source_inbound_message_id)
    VALUES (1000, 10, 'Draft', 'agent', 1000, 100);
    INSERT INTO draft_runs
      (id, thread_id, inbound_message_id, status, draft_id)
    VALUES (1000, 10, 100, 'ready', 1000);
    INSERT INTO reply_attempts
      (id, thread_id, inbound_message_id, draft_id, status, text_body, to_addresses)
    VALUES ('reply-sent', 10, 100, 1000, 'sent', 'Reply', '["customer@example.net"]');
    INSERT INTO outbound_attempts
      (id, mailbox_id, thread_id, status, to_addresses, subject, text_body)
    VALUES ('outbound-sent', 1, 10, 'sent', '["customer@example.net"]', 'Target', 'Sent');
    INSERT INTO labels (id, mailbox_id, name, condition)
    VALUES (500, 1, 'guest-post', 'A guest post pitch');
    INSERT INTO thread_labels (thread_id, label_id) VALUES (10, 500);
  `);

  return { database, DB: database };
}

async function count(database, table, where = "1 = 1") {
  return (
    await database.one(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
  ).count;
}

test("deleting an inbox removes its data and objects but keeps its domain and siblings", async (t) => {
  const fixture = await makeFixture(t);
  const deleted = await deleteInbox(fixture, {
    id: 1,
    confirmAddress: "support@example.com",
  });

  assert.deepEqual(deleted, {
    id: 1,
    address: "support@example.com",
    domainId: 1,
  });
  assert.equal(await count(fixture.database, "mailboxes", "id = 1"), 0);
  assert.equal(await count(fixture.database, "mailboxes", "id = 2"), 1);
  assert.equal(await count(fixture.database, "domains", "id = 1"), 1);
  for (const table of [
    "threads",
    "messages",
    "attachments",
    "drafts",
    "draft_runs",
    "reply_attempts",
    "outbound_attempts",
    "playbooks",
    "labels",
    "thread_labels",
  ]) {
    assert.equal(
      await count(fixture.database, table),
      table === "threads" || table === "messages" ? 1 : 0,
    );
  }
  assert.deepEqual(
    (await fixture.database.query("SELECT key FROM stored_files")).rows,
    [{ key: "raw/2/sibling.eml" }],
  );
});

test("an unknown inbox returns 404 without deleting data or objects", async (t) => {
  const fixture = await makeFixture(t);

  await assert.rejects(
    deleteInbox(fixture, { id: 999, confirmAddress: "missing@example.com" }),
    (error) => error instanceof InboxDeletionError && error.status === 404,
  );
  assert.equal(await count(fixture.database, "mailboxes"), 2);
  assert.equal(await count(fixture.database, "stored_files"), 3);
});

test("the exact inbox address is required before deletion", async (t) => {
  const fixture = await makeFixture(t);

  await assert.rejects(
    deleteInbox(fixture, { id: 1, confirmAddress: "sales@example.com" }),
    (error) => error instanceof InboxDeletionError && error.status === 400,
  );
  assert.equal(await count(fixture.database, "mailboxes"), 2);
  assert.equal(await count(fixture.database, "stored_files"), 3);
});

test("an active send blocks inbox deletion", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.database.query(
    "UPDATE reply_attempts SET status = 'sending' WHERE id = 'reply-sent'",
  );

  await assert.rejects(
    deleteInbox(fixture, { id: 1, confirmAddress: "support@example.com" }),
    (error) => error instanceof InboxDeletionError && error.status === 409,
  );
  assert.equal(await count(fixture.database, "mailboxes", "id = 1"), 1);
  assert.equal(await count(fixture.database, "stored_files"), 3);
});

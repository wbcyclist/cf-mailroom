import test from "node:test";
import assert from "node:assert/strict";
import { databaseFixture, seedInbox } from "./helpers/postgres.mjs";
import { putFile, getFile } from "../src/worker/files.ts";
import { claimDailySendBudget } from "../src/worker/email/send-budget.ts";

test("PostgreSQL rolls back metadata and binary files together", async (t) => {
  const db = await databaseFixture(t);
  const inbox = await seedInbox(db);
  await assert.rejects(
    db.transaction(async (tx) => {
      await putFile(
        tx,
        inbox.id,
        "rollback",
        new Uint8Array([0, 255, 128]),
        "application/octet-stream",
      );
      await tx.query(
        "INSERT INTO threads (mailbox_id, last_message_at) VALUES ($1, now())",
        [inbox.id],
      );
      throw new Error("injected failure");
    }),
    /injected failure/,
  );
  assert.equal(await getFile(db, "rollback"), null);
  assert.equal(
    (await db.one("SELECT count(*) AS count FROM threads")).count,
    0,
  );
  await putFile(
    db,
    inbox.id,
    "binary",
    new Uint8Array([0, 255, 128]),
    "application/octet-stream",
  );
  assert.deepEqual(await getFile(db, "binary"), new Uint8Array([0, 255, 128]));
});

test("PostgreSQL enforces the send budget under concurrency", async (t) => {
  const db = await databaseFixture(t);
  const claims = await Promise.all(
    Array.from({ length: 12 }, () =>
      claimDailySendBudget({ DB: db }, "owner", 3),
    ),
  );
  assert.equal(claims.filter(Boolean).length, 3);
  assert.equal(
    (await db.one("SELECT send_count FROM mcp_send_budget")).send_count,
    3,
  );
});

test("send attempt, files and budget roll back together on a budget failure", async (t) => {
  const { sendNewEmailAttempt } = await import("../src/worker/email/compose.ts");
  const db = await databaseFixture(t);
  const inbox = await seedInbox(db);
  let sends = 0;
  const env = { DB: db, EMAIL: { async send() { sends++; return { messageId: crypto.randomUUID() }; } } };
  const intent = { attemptId: "budget-denied", mailboxId: inbox.id, to: ["customer@example.net"], subject: "Invoice", text: "See attached", attachments: [{ filename: "a.bin", content: new Uint8Array([0, 255]) }], actorId: "owner", dailySendLimit: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(sendNewEmailAttempt(env, intent), (error) => error.status === 429);
  }
  assert.equal(sends, 0);
  for (const table of ["outbound_attempts", "stored_files", "mcp_send_budget"]) {
    assert.equal((await db.one(`SELECT count(*) AS n FROM ${table}`)).n, 0);
  }
  await db.query(`CREATE FUNCTION fail_budget() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'budget database failure'; END $$;
    CREATE TRIGGER fail_budget BEFORE INSERT ON mcp_send_budget FOR EACH ROW EXECUTE FUNCTION fail_budget();`);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(sendNewEmailAttempt(env, { ...intent, dailySendLimit: 1 }), /budget database failure/);
  }
  assert.equal(sends, 0);
  assert.equal((await db.one("SELECT count(*) AS n FROM outbound_attempts")).n, 0);
  assert.equal((await db.one("SELECT count(*) AS n FROM stored_files")).n, 0);
});

test("concurrent sends enforce one daily budget and do not leak staged files", async (t) => {
  const { sendNewEmailAttempt } = await import("../src/worker/email/compose.ts");
  const db = await databaseFixture(t);
  const inbox = await seedInbox(db);
  let sends = 0;
  const env = { DB: db, EMAIL: { async send() { sends++; return { messageId: crypto.randomUUID() }; } } };
  const intent = { mailboxId: inbox.id, to: ["customer@example.net"], subject: "Invoice", text: "See attached", attachments: [{ filename: "a.bin", content: new Uint8Array([0, 255]) }], actorId: "owner", dailySendLimit: 2 };
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => sendNewEmailAttempt(env, { ...intent, attemptId: `send-${i}` })));
  assert.equal(results.filter((result) => result.status === "fulfilled" && result.value.status === "sent").length, 2);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.status === 429).length, 6);
  assert.equal(sends, 2);
  assert.equal((await db.one("SELECT count(*) AS n FROM stored_files")).n, 2);
});

test("concurrent retries finalize a provider checkpoint once", async (t) => {
  const { sendReplyAttempt } = await import("../src/worker/email/reply.ts");
  const db = await databaseFixture(t);
  const inbox = await seedInbox(db);
  const thread = await db.one("INSERT INTO threads (mailbox_id, last_message_at, message_count) VALUES ($1, now(), 1) RETURNING id", [inbox.id]);
  const msg = await db.one("INSERT INTO messages (thread_id, message_id, direction, from_address) VALUES ($1, 'inbound', 'inbound', 'customer@example.net') RETURNING id", [thread.id]);
  await db.query(`INSERT INTO reply_attempts (id, thread_id, inbound_message_id, status, text_body, to_addresses, message_id)
    VALUES ('recover', $1, $2, 'sending', 'Hello', '["customer@example.net"]', 'accepted')`, [thread.id, msg.id]);
  let sends = 0;
  const env = { DB: db, EMAIL: { async send() { sends++; throw new Error("unexpected provider call"); } } };
  const results = await Promise.all(Array.from({ length: 3 }, () => sendReplyAttempt(env, { attemptId: "recover", threadId: thread.id, text: "Hello" })));
  assert.ok(results.every((result) => result.status === "sent"));
  assert.equal(sends, 0);
  assert.equal((await db.one("SELECT message_count FROM threads")).message_count, 2);
  assert.equal((await db.one("SELECT count(*) AS n FROM messages WHERE direction = 'outbound'")).n, 1);
});

test("migration replay is idempotent and rejects edited migration history", async (t) => {
  const pg = (await import("pg")).default;
  const { migrate, LOCAL_DATABASE_URL } = await import("../scripts/database.mjs");
  const db = await databaseFixture(t);
  const { name } = await db.one("SELECT current_schema() AS name");
  assert.match(name, /^test_[0-9a-f]+$/);
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL, options: `-c search_path=${name}` });
  await client.connect();
  t.after(() => client.end());
  await migrate(client, () => {});
  assert.equal((await db.one("SELECT count(*) AS n FROM schema_migrations")).n, 3);
  await db.query("UPDATE schema_migrations SET checksum = 'changed' WHERE name = '0001_initial.sql'");
  await assert.rejects(migrate(client, () => {}), /Applied migration changed/);
  assert.equal((await db.one("SELECT count(*) AS n FROM global_settings")).n, 1);
});

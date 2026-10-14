import test from "node:test";
import assert from "node:assert/strict";
import { databaseFixture, seedInbox } from "./helpers/postgres.mjs";
import { claimUsageBudget, claimQueueBudget, UsageLimitError } from "../src/worker/usage-budget.ts";
import { enqueueDraftRun, expireDraftRuns, resumeDeferredDraftRuns } from "../src/worker/agent/runs.ts";
import { processDraftRun } from "../src/worker/agent/draft.ts";

async function fixture(t, options = {}) {
  const db = await databaseFixture(t);
  await seedInbox(db);
  await db.query(`UPDATE mailboxes SET agent_mode = 'draft';
    UPDATE global_settings SET ai_provider = 'openai-compatible', ai_base_url = 'https://ai.example/v1', ai_model = 'mock';
    INSERT INTO threads (id, mailbox_id, subject, last_message_at) VALUES (1, 1, 'Help', now());
    INSERT INTO messages (id, thread_id, message_id, direction, from_address, text_body) VALUES (1, 1, '<first@example.net>', 'inbound', 'customer@example.net', 'Help');`);
  const jobs = [];
  const env = { DB: db, AI_API_KEY: "mock", DRAFT_QUEUE: { async send(job) { jobs.push(job); } }, ...options };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "PLAYBOOK: NONE\nREPLY:\nThanks." } }] });
  });
  return { db, env, jobs, calls: () => calls };
}

test("concurrent budget claims cannot cross the daily limit", async t => {
  const db = await databaseFixture(t);
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => claimUsageBudget(db, "queue", 10, 50, 500)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 5);
  assert.ok(results.filter(r => r.status === "rejected").every(r => r.reason instanceof UsageLimitError));
  assert.equal((await db.one("SELECT max(used) AS n FROM usage_budgets")).n, 50);
});

test("UTC midnight resets daily usage but keeps monthly usage; month rollover resets both", async t => {
  const db = await databaseFixture(t);
  await claimUsageBudget(db, "queue", 10, 10, 20, new Date("2026-01-30T23:59:59.999Z"));
  await assert.rejects(claimUsageBudget(db, "queue", 10, 10, 20, new Date("2026-01-30T23:59:59.999Z")), e => e.retryAfter === "2026-01-31T00:00:00.000Z");
  await claimUsageBudget(db, "queue", 10, 10, 20, new Date("2026-01-31T00:00:00Z"));
  await assert.rejects(claimUsageBudget(db, "queue", 10, 10, 20, new Date("2026-01-31T23:59:59Z")), e => e.retryAfter === "2026-02-01T00:00:00.000Z");
  await claimUsageBudget(db, "queue", 10, 10, 20, new Date("2026-02-01T00:00:00Z"));
});

test("zero and invalid configured limits fail closed", async t => {
  const db = await databaseFixture(t);
  for (const value of ["0", "bad", "-1", "1.5"]) await assert.rejects(claimQueueBudget({ DB: db, QUEUE_DAILY_OPERATION_LIMIT: value }), UsageLimitError);
  assert.equal((await db.one("SELECT count(*) AS n FROM usage_budgets")).n, 0);
});

test("concurrent enqueue claims one dispatch and one reservation", async t => {
  const f = await fixture(t);
  const ids = await Promise.all(Array.from({ length: 12 }, () => enqueueDraftRun(f.env, 1, 1)));
  assert.equal(new Set(ids).size, 1);
  assert.equal(f.jobs.length, 1);
  assert.equal((await f.db.one("SELECT max(used) AS n FROM usage_budgets WHERE resource = 'queue'")).n, 10);
});

test("queue exhaustion defers without sending and a later eligible recovery pass resumes once", async t => {
  const f = await fixture(t, { QUEUE_DAILY_OPERATION_LIMIT: "0" });
  const id = await enqueueDraftRun(f.env, 1, 1);
  assert.equal(f.jobs.length, 0);
  assert.equal((await f.db.one("SELECT status FROM draft_runs")).status, "deferred");
  await resumeDeferredDraftRuns(f.env);
  assert.equal(f.jobs.length, 0);
  f.env.QUEUE_DAILY_OPERATION_LIMIT = "10";
  await f.db.query("UPDATE draft_runs SET retry_after = now() - interval '1 second'");
  await resumeDeferredDraftRuns(f.env);
  await resumeDeferredDraftRuns(f.env);
  assert.equal(f.jobs.length, 1);
  await processDraftRun(f.env, id, f.jobs[0].dispatchId);
  assert.equal(f.calls(), 1);
});

test("AI exhaustion defers a consumer without a paid call or queue retry", async t => {
  const f = await fixture(t, { AI_DAILY_CALL_LIMIT: "0" });
  const id = await enqueueDraftRun(f.env, 1, 1);
  await processDraftRun(f.env, id, f.jobs[0].dispatchId);
  await processDraftRun(f.env, id, f.jobs[0].dispatchId);
  assert.equal(f.calls(), 0);
  assert.equal((await f.db.one("SELECT status FROM draft_runs")).status, "deferred");
});

test("failed queue sends keep reservations; old deliveries cannot execute a new attempt", async t => {
  const f = await fixture(t);
  f.env.DRAFT_QUEUE.send = async job => { f.jobs.push(job); throw new Error("Ambiguous send"); };
  const id = await enqueueDraftRun(f.env, 1, 1);
  assert.equal((await f.db.one("SELECT status FROM draft_runs")).status, "failed");
  f.env.DRAFT_QUEUE.send = async job => { f.jobs.push(job); };
  await enqueueDraftRun(f.env, 1, 1, { retryFailed: true });
  await processDraftRun(f.env, id, f.jobs[0].dispatchId);
  assert.equal(f.calls(), 0);
  await processDraftRun(f.env, id, f.jobs[1].dispatchId);
  assert.equal(f.calls(), 1);
  assert.equal((await f.db.one("SELECT max(used) AS n FROM usage_budgets WHERE resource = 'queue'")).n, 20);
});

test("expired generating jobs stop processing and require explicit retry", async t => {
  const f = await fixture(t);
  const id = await enqueueDraftRun(f.env, 1, 1);
  await f.db.query("UPDATE draft_runs SET status = 'generating', started_at = now() - interval '6 minutes'");
  await expireDraftRuns(f.env);
  await processDraftRun(f.env, id, f.jobs[0].dispatchId);
  assert.equal(f.calls(), 0);
  assert.equal((await f.db.one("SELECT status FROM draft_runs")).status, "failed");
  await enqueueDraftRun(f.env, 1, 1, { retryFailed: true });
  assert.equal(f.jobs.length, 2);
});

test("a late model response cannot replace a retry after its claim expired", async t => {
  const f = await fixture(t);
  const id = await enqueueDraftRun(f.env, 1, 1);
  t.mock.method(globalThis, "fetch", async () => {
    await f.db.query("UPDATE draft_runs SET started_at = now() - interval '6 minutes'");
    await expireDraftRuns(f.env);
    await enqueueDraftRun(f.env, 1, 1, { retryFailed: true });
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "PLAYBOOK: NONE\nREPLY:\nOld answer." } }] });
  });
  await processDraftRun(f.env, id, f.jobs[0].dispatchId);
  assert.equal((await f.db.one("SELECT status FROM draft_runs")).status, "queued");
  assert.equal((await f.db.one("SELECT count(*) AS n FROM drafts")).n, 0);
});

test("a recovery pass sends at most 100 deferred jobs", async t => {
  const f = await fixture(t);
  await f.db.query(`INSERT INTO threads (id, mailbox_id, subject, last_message_at)
      SELECT i, 1, 'Deferred', now() FROM generate_series(2, 106) i;
    INSERT INTO messages (id, thread_id, message_id, direction, from_address, text_body)
      SELECT i, i, '<deferred-' || i || '@example.net>', 'inbound', 'customer@example.net', 'Question' FROM generate_series(2, 106) i;
    INSERT INTO draft_runs (thread_id, inbound_message_id, status, retry_after)
      SELECT i, i, 'deferred', now() - interval '1 second' FROM generate_series(2, 106) i;`);
  await resumeDeferredDraftRuns(f.env);
  assert.equal(f.jobs.length, 100);
  assert.equal((await f.db.one("SELECT count(*) AS n FROM draft_runs WHERE status = 'deferred'")).n, 5);
});

test("database failures prevent queue dispatch", async t => {
  const f = await fixture(t);
  t.mock.method(f.db, "transaction", async () => { throw new Error("Database unavailable"); });
  await assert.rejects(enqueueDraftRun(f.env, 1, 1), /Database unavailable/);
  assert.equal(f.jobs.length, 0);
});

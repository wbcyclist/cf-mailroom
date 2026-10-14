import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseFixture, seedInbox } from './helpers/postgres.mjs';
import { processDraftRun } from '../src/worker/agent/draft.ts';

test('draft SQL bounds large bodies before transfer and model admission', async t => {
  const db = await databaseFixture(t);
  const inbox = await seedInbox(db);
  await db.query("UPDATE mailboxes SET agent_mode='draft'; UPDATE global_settings SET ai_provider='openai-compatible', ai_base_url='https://ai.example/v1', ai_model='mock'");
  const thread = await db.one("INSERT INTO threads(mailbox_id, subject, last_message_at) VALUES($1, 'Large context', now()) RETURNING id", [inbox.id]);
  await db.query(`INSERT INTO messages(thread_id,message_id,direction,from_address,text_body)
    SELECT $1, '<large-' || n || '@example.net>', 'inbound', 'customer@example.net', repeat('x',1048576)
    FROM generate_series(1,12) n`, [thread.id]);
  const latest = await db.one('SELECT max(id) AS id FROM messages');
  const run = await db.one("INSERT INTO draft_runs(thread_id,inbound_message_id,dispatch_id) VALUES($1,$2,'review') RETURNING id", [thread.id,latest.id]);
  let receivedBytes = 0;
  const scoped = new Proxy(db, {get(target,key) {
    if (key === 'query') return async (...args) => {
      const result = await target.query(...args);
      if (args[0].includes('SELECT id, direction, sent_by')) receivedBytes = result.rows.reduce((n,row) => n + Buffer.byteLength(row.text_body ?? ''),0);
      return result;
    };
    const value=Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value;
  }});
  t.mock.method(globalThis,'fetch',() => assert.fail('Unexpected provider call'));
  await processDraftRun({DB:scoped, AI_API_KEY:'local-mock', AI_DAILY_CALL_LIMIT:'0'},run.id,'review');
  const final=await db.one('SELECT status,error FROM draft_runs WHERE id=$1',[run.id]);
  assert.ok(receivedBytes <= 12 * 24000);
  assert.equal(final.status, 'deferred');
});

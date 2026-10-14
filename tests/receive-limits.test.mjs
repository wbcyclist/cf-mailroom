import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseFixture, seedInbox } from './helpers/postgres.mjs';
import { receiveEmail } from '../src/worker/email/receive.ts';
import { claimInboundBudget, InboundLimitError } from '../src/worker/email/receive-budget.ts';
import { deleteInbox } from '../src/worker/inbox/delete.ts';
import PostalMime from 'postal-mime';

const raw = id => `From: customer@example.net\r\nTo: support@example.com\r\nMessage-ID: <${id}@example.net>\r\nSubject: Help\r\n\r\nHello`;
async function fixture(t, limits = {}) {
  const db = await databaseFixture(t), inbox = await seedInbox(db), pending = [];
  const env = { DB: db, ...limits };
  async function deliver(id, options = {}) {
    const content = raw(id);
    let rejected;
    await receiveEmail({ to: inbox.address, rawSize: Buffer.byteLength(content), raw: new Response(content).body,
      setReject(reason) { rejected = reason; }, ...options }, env, { waitUntil(p) { pending.push(p); } });
    await Promise.all(pending.splice(0));
    return rejected;
  }
  return { db, inbox, env, deliver };
}

test('disabled or exhausted inbound budgets reject before reading MIME', async t => {
  const f = await fixture(t);
  for (const variable of ['INBOUND_MINUTE_MESSAGE_LIMIT', 'INBOUND_DAILY_MESSAGE_LIMIT', 'INBOUND_DAILY_BYTE_LIMIT', 'MAIL_STORAGE_LIMIT_BYTES']) {
    for (const value of ['0', 'invalid']) {
      let rejected;
      await receiveEmail({ to: f.inbox.address, rawSize: 100,
        get raw() { assert.fail('Rejected delivery read its body'); },
        setReject(reason) { rejected = reason; },
      }, { ...f.env, [variable]: value }, {});
      assert.ok(rejected);
    }
  }
  assert.equal((await f.db.one('SELECT count(*) AS n FROM messages')).n, 0);
});

test('concurrent deliveries share a global count and byte budget', async t => {
  const f = await fixture(t, { INBOUND_DAILY_MESSAGE_LIMIT: '3' });
  const rejected = await Promise.all(Array.from({ length: 12 }, (_, i) => f.deliver(`unique-${i}`)));
  assert.equal(rejected.filter(reason => !reason).length, 3);
  assert.equal((await f.db.one('SELECT count(*) AS n FROM messages')).n, 3);
  assert.equal((await f.db.one('SELECT max(message_count) AS n FROM inbound_usage')).n, 3);
});

test('inbound minute and day limits recover at UTC boundaries', async t => {
  const f = await fixture(t, { INBOUND_MINUTE_MESSAGE_LIMIT: '1', INBOUND_DAILY_BYTE_LIMIT: '200' });
  await claimInboundBudget(f.env, 100, new Date('2026-01-31T23:58:59Z'));
  await assert.rejects(claimInboundBudget(f.env, 100, new Date('2026-01-31T23:58:59Z')), /rate limit/);
  await claimInboundBudget(f.env, 100, new Date('2026-01-31T23:59:00Z'));
  await assert.rejects(claimInboundBudget(f.env, 1, new Date('2026-01-31T23:59:59Z')), InboundLimitError);
  await claimInboundBudget(f.env, 100, new Date('2026-02-01T00:00:00Z'));
});

test('concurrent storage admission counts raw MIME and decoded bodies', async t => {
  const size = Buffer.byteLength(raw('00')) + Buffer.byteLength((await PostalMime.parse(raw('00'))).text);
  const f = await fixture(t, { MAIL_STORAGE_LIMIT_BYTES: String(size * 2) });
  const rejected = await Promise.all(Array.from({ length: 8 }, (_, i) => f.deliver(`0${i}`)));
  assert.equal(rejected.filter(reason => !reason).length, 2);
  assert.equal((await f.db.one('SELECT used_bytes FROM mail_storage_usage')).used_bytes, size * 2);
  assert.equal((await f.db.one('SELECT count(*) AS n FROM messages')).n, 2);
});

test('storage accounting follows edits, rollbacks, and inbox deletion', async t => {
  const f = await fixture(t);
  assert.equal(await f.deliver('storage'), undefined);
  const initial = (await f.db.one('SELECT used_bytes FROM mail_storage_usage')).used_bytes;
  const oldBodyBytes = (await f.db.one('SELECT octet_length(text_body) AS n FROM messages')).n;
  await assert.rejects(f.db.transaction(async db => {
    await db.query("UPDATE messages SET text_body = 'changed'");
    throw new Error('Rollback fixture');
  }), /Rollback fixture/);
  assert.equal((await f.db.one('SELECT used_bytes FROM mail_storage_usage')).used_bytes, initial);
  await f.db.query("UPDATE messages SET text_body = 'Longer reply'");
  assert.equal((await f.db.one('SELECT used_bytes FROM mail_storage_usage')).used_bytes, initial + Buffer.byteLength('Longer reply') - oldBodyBytes);
  await deleteInbox(f.env, { id: f.inbox.id, confirmAddress: f.inbox.address });
  assert.equal((await f.db.one('SELECT used_bytes FROM mail_storage_usage')).used_bytes, 0);
});

test('underreported MIME sizes cannot bypass byte admission', async t => {
  const f = await fixture(t);
  assert.match(await f.deliver('oversized', { rawSize: 8 }), /size limit/);
  assert.equal((await f.db.one('SELECT used_bytes FROM mail_storage_usage')).used_bytes, 0);
  assert.equal((await f.db.one('SELECT count(*) AS n FROM messages')).n, 0);
});

test('duplicates consume processing budget but do not consume storage twice', async t => {
  const f = await fixture(t);
  await f.deliver('same');
  const initial = (await f.db.one('SELECT used_bytes FROM mail_storage_usage')).used_bytes;
  await f.deliver('same');
  assert.equal((await f.db.one('SELECT used_bytes FROM mail_storage_usage')).used_bytes, initial);
  assert.equal((await f.db.one('SELECT max(message_count) AS n FROM inbound_usage')).n, 2);
});

test('a missing storage ledger stops delivery before reading MIME', async t => {
  const f = await fixture(t);
  await f.db.query('DELETE FROM mail_storage_usage');
  await assert.rejects(receiveEmail({ to: f.inbox.address, rawSize: 100,
    get raw() { assert.fail('Delivery read MIME without storage accounting'); },
  }, f.env, {}), /accounting is unavailable/);
});

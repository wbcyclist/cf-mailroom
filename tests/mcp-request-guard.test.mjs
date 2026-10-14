import test from 'node:test';
import assert from 'node:assert/strict';
import { guardMcpRequest, limitMcpResourceBody } from '../src/mcp/request-guard.ts';
import { databaseFixture } from './helpers/postgres.mjs';

const limiter = { async limit() { return { success: true }; } };
const request = (body = 'client_id=approved&grant_type=authorization_code&code=invalid') => new Request('https://internal.example/mcp/oauth/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
});

test('missing or failed edge protection denies access before PostgreSQL', async () => {
  const DB = { transaction() { assert.fail('Unexpected database access'); } };
  assert.equal((await guardMcpRequest(request(), { DB })).status, 503);
  assert.equal((await guardMcpRequest(request(), { DB, MCP_RATE_LIMITER: { async limit() { throw new Error('Unavailable'); } } })).status, 503);
  const response = await guardMcpRequest(request(), { DB, MCP_RATE_LIMITER: { async limit() { return { success: false }; } } });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
});

test('chunked OAuth uploads are cancelled at the body limit before database access', async () => {
  let consumed = 0, cancelled = false;
  const stream = new ReadableStream({ pull(controller) { consumed += 1024; controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } });
  const input = new Request('https://internal.example/mcp/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: stream, duplex: 'half' });
  const result = await guardMcpRequest(input, { MCP_RATE_LIMITER: limiter, DB: { transaction() { assert.fail('Oversized body reached the database'); } } });
  assert.equal(result.status, 413);
  assert.equal(cancelled, true);
  assert.ok(consumed <= 18 * 1024);
});

test('many OAuth fields are rejected before provider parsing', async () => {
  const body = new URLSearchParams(Array.from({ length: 20 }, (_, i) => [`key${i}`, 'value']));
  assert.equal((await guardMcpRequest(request(body), { MCP_RATE_LIMITER: limiter, DB: { transaction() { assert.fail('Unexpected database access'); } } })).status, 400);
});

test('concurrent MCP admissions share a persistent global budget', async t => {
  const db = await databaseFixture(t);
  const env = { DB: db, MCP_RATE_LIMITER: limiter, MCP_DAILY_REQUEST_LIMIT: '3' };
  const results = await Promise.all(Array.from({ length: 12 }, () => guardMcpRequest(request(), env)));
  assert.equal(results.filter(r => r instanceof Request).length, 3);
  assert.equal(results.filter(r => r instanceof Response && r.status === 429).length, 9);
  const accepted = results.find(r => r instanceof Request);
  assert.equal(await accepted.text(), 'client_id=approved&grant_type=authorization_code&code=invalid');
  assert.equal((await db.one("SELECT max(used) AS n FROM usage_budgets WHERE resource='mcp'")).n, 3);
});

test('a database error fails closed without admitting a provider request', async () => {
  const env = { MCP_RATE_LIMITER: limiter, DB: { async transaction() { throw new Error('Database offline'); } } };
  assert.equal((await guardMcpRequest(request(), env)).status, 503);
});

test('resource admission leaves the body unread until authentication', async t => {
  const DB = await databaseFixture(t);
  const input = new Request('https://internal.example/mcp', { method: 'POST', body: '{"method":"initialize"}' });
  assert.equal(await guardMcpRequest(input, { DB, MCP_RATE_LIMITER: limiter }), input);
  assert.equal(input.bodyUsed, false);
  const limited = await limitMcpResourceBody(input);
  assert.equal(await limited.text(), '{"method":"initialize"}');
});

test('authenticated chunked MCP uploads stop at five MiB', async () => {
  let consumed = 0, cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { consumed += 65536; controller.enqueue(new Uint8Array(65536)); },
    cancel() { cancelled = true; },
  });
  const input = new Request('https://internal.example/mcp', { method: 'POST', body: stream, duplex: 'half' });
  assert.equal((await limitMcpResourceBody(input)).status, 413);
  assert.equal(cancelled, true);
  assert.ok(consumed <= 5 * 1024 * 1024 + 2 * 65536);
});

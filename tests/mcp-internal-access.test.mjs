import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class WorkerEntrypoint {}", shortCircuit: true };
  if (specifier === "agents/mcp/server") return { url: "data:text/javascript,export function createMcpHandler() { throw new Error('Not part of this OAuth route test'); }", shortCircuit: true };
  return next(specifier, context);
} });
const { withMcp } = await import("../src/mcp/index.ts");
const handler = withMcp({ fetch() { return new Response("Not found", { status: 404 }); } });

test("public registration is rejected before any KV write", async t => {
  const env = { OAUTH_KV: { async put() { assert.fail("Unexpected KV write"); } } };
  const response = await handler(new Request("https://internal.example/mcp/oauth/register", {
    method: "POST", body: JSON.stringify({ redirect_uris: ["http://localhost:5000/callback"] }),
  }), env, {});
  assert.equal(response.status, 404);
});

test("OAuth discovery advertises no dynamic registration", async () => {
  const response = await handler(new Request("https://internal.example/.well-known/oauth-authorization-server"), {}, {});
  const metadata = await response.json();
  assert.equal(response.status, 200);
  assert.equal(metadata.registration_endpoint, undefined);
  assert.notEqual(metadata.client_id_metadata_document_supported, true);
});

test("URL client IDs cannot cause metadata fetches or KV writes", async t => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Unregistered client triggered a metadata fetch"));
  const env = {
    MCP_RATE_LIMITER: { async limit() { return { success: true }; } },
    DB: { async transaction(work) { return work({ async query() { return { rows: [] }; } }); } },
    OAUTH_KV: { async get() { return null; }, async put() { assert.fail("Unexpected registration"); } },
  };
  const response = await handler(new Request("https://internal.example/mcp/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: "https://attacker.example/client.json", grant_type: "authorization_code", code: "invalid" }),
  }), env, {});
  assert.equal(response.status, 401);
});

test.after(() => hook.deregister());

test("OAuth rejects an oversized body before reading it or using KV", async () => {
  let read = false;
  const request = new Request('https://internal.example/mcp/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '5242880' },
    body: 'client_id=unknown',
  });
  request.formData = async () => { read = true; return new FormData(); };
  const response = await handler(request, { OAUTH_KV: { get() { assert.fail('Unexpected KV read'); } } }, {});
  assert.equal(response.status, 413);
  assert.equal(read, false);
});

test("unauthenticated MCP uploads are cancelled without body reads or error logs", async t => {
  t.mock.method(console, 'warn', () => assert.fail('Invalid credentials produced a warning'));
  let pulls = 0, cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const env = {
    MCP_RATE_LIMITER: { async limit() { return { success: true }; } },
    DB: { async transaction(work) { return work({ async query() { return { rows: [] }; } }); } },
    OAUTH_KV: { async get() { return null; } },
  };
  const response = await handler(new Request('https://internal.example/mcp', {
    method: 'POST', body: stream, duplex: 'half',
  }), env, {});
  assert.equal(response.status, 401);
  assert.equal(pulls, 0);
  assert.equal(cancelled, true);
});

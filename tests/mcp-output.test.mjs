import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailroomServer } from '../src/mcp/server.ts';

for (const status of ['queued', 'generating', 'ready', 'failed', 'superseded', 'deferred']) {
  test(`MCP output accepts the ${status} draft state`, async () => {
    const row = { id: 1, mailbox_id: 1, mailbox_address: 'support@example.com', subject: 'Help', snippet: 'Help', status: 'open', is_read: 0, message_count: 0, last_message_at: new Date().toISOString(), last_direction: 'inbound', correspondent: 'customer@example.net', pending_draft_count: 0, draft_run_status: status };
    const env = { DB: {
      async query(sql) { return { rows: sql.includes('FROM threads t') ? [row] : [] }; },
      async one(sql) { return sql.includes('FROM draft_runs') ? { status, error: null, started_at: null, finished_at: null } : row; },
    } };
    const server = createMailroomServer(env, { email: 'staff@example.com', sub: 'staff', clientId: 'approved', canSend: false });
    for (const [name, args] of [['search_conversations', { status: 'open', limit: 25 }], ['get_conversation', { conversation_id: 'conversation_1', message_limit: 30 }]]) {
      const tool = server._registeredTools[name];
      const result = await tool.handler(args, {});
      assert.notEqual(result.isError, true);
      await server.validateToolOutput(tool, result, name);
    }
  });
}

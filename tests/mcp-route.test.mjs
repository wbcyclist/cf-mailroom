import assert from "node:assert/strict";
import test from "node:test";
import {
  isRejectedMcpRouteLookalike,
  MCP_ROUTE,
} from "../src/mcp/route.ts";

test("the only MCP endpoint is the slashless /mcp path", () => {
  assert.equal(MCP_ROUTE, "/mcp");
  assert.equal(isRejectedMcpRouteLookalike("/mcp"), false);
});

test("trailing-slash and prefix lookalikes are rejected", () => {
  for (const path of ["/mcp/", "/mcpx", "/mcp-foo", "/mcp/tools", "/mcp/oauth", "/mcp/oauth/", "/mcp/oauth/token/", "/mcp/oauth/revoke", "/mcp/oauth/register"]) {
    assert.equal(isRejectedMcpRouteLookalike(path), true, path);
  }
  for (const path of ["/mcp/oauth/token", "/api/mcp", "/inbox", "/.well-known/oauth-protected-resource/mcp"]) {
    assert.equal(isRejectedMcpRouteLookalike(path), false);
  }
});

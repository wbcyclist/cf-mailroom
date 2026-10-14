export const MCP_ROUTE = "/mcp";

// Under /mcp so one Access Bypass path covers the resource and token endpoint.
export const MCP_TOKEN_ENDPOINT = "/mcp/oauth/token";

/**
 * OAuthProvider uses prefix matching for API routes. Keep the public endpoint
 * exact so `/mcp/`, `/mcpx`, and `/mcp/tools` cannot be mistaken for this MCP
 * resource. The token endpoint is the only other path allowed under it.
 */
export function isRejectedMcpRouteLookalike(pathname: string): boolean {
  return (
    pathname.startsWith(MCP_ROUTE) &&
    pathname !== MCP_ROUTE &&
    pathname !== MCP_TOKEN_ENDPOINT
  );
}

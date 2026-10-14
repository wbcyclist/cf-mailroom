import { BodyLimitError, readLimitedStream } from "../shared/stream-limit.ts";
import { claimUsageBudget, usageLimit, UsageLimitError } from "../worker/usage-budget.ts";
import type { Database } from "../worker/database.ts";
import { MCP_TOKEN_ENDPOINT } from "./route.ts";

export interface McpRequestEnv {
  DB: Database;
  MCP_RATE_LIMITER?: RateLimit;
  MCP_DAILY_REQUEST_LIMIT?: string;
  MCP_MONTHLY_REQUEST_LIMIT?: string;
}

export async function guardMcpRequest(request: Request, env: McpRequestEnv): Promise<Request | Response> {
  if (request.method === "OPTIONS") return request;
  const token = new URL(request.url).pathname === MCP_TOKEN_ENDPOINT;
  if (token && request.method !== "POST") return rejection(405, "Method not allowed");
  const maxBytes = token ? 16 * 1024 : 5 * 1024 * 1024;
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    return rejection(413, "Request body exceeds the size limit");
  }
  if (token && request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    return rejection(415, "Use application/x-www-form-urlencoded");
  }
  try {
    if (!env.MCP_RATE_LIMITER) return rejection(503, "MCP request protection is not configured");
    const { success } = await env.MCP_RATE_LIMITER.limit({ key: `mcp:${request.headers.get("CF-Connecting-IP") ?? "unknown"}` });
    if (!success) return rejection(429, "Too many requests", 60);
    if (token && request.body) {
      const bytes = await readLimitedStream(request.body, maxBytes);
      const form = new URLSearchParams(new TextDecoder().decode(bytes));
      if ([...form].length > 16) return rejection(400, "Too many OAuth parameters");
      request = new Request(request, { body: bytes });
    }
    // The edge limiter is per location. This ledger bounds admitted requests globally.
    await claimUsageBudget(env.DB, "mcp", 1,
      usageLimit(env.MCP_DAILY_REQUEST_LIMIT, 5_000),
      usageLimit(env.MCP_MONTHLY_REQUEST_LIMIT, 100_000));
    return request;
  } catch (error) {
    if (error instanceof BodyLimitError) return rejection(413, error.message);
    if (error instanceof UsageLimitError) return rejection(429, "MCP request budget exhausted",
      Math.max(1, Math.ceil((Date.parse(error.retryAfter) - Date.now()) / 1000)));
    return rejection(503, "MCP request protection is unavailable");
  }
}

/** Resource uploads are read only after OAuth has verified the bearer token. */
export async function limitMcpResourceBody(request: Request): Promise<Request | Response> {
  if (!request.body) return request;
  try {
    return new Request(request, { body: await readLimitedStream(request.body, 5 * 1024 * 1024) });
  } catch (error) {
    return rejection(error instanceof BodyLimitError ? 413 : 400, "Invalid or oversized MCP request body");
  }
}

function rejection(status: number, error: string, retryAfter?: number) {
  return Response.json({ error }, { status, headers: {
    "Cache-Control": "no-store",
    ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
  } });
}

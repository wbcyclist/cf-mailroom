import { withDatabase } from "./runtime.ts";
import { Hono } from "hono";
import { withMcp } from "../mcp/index.ts";
import { api } from "./api/index.ts";
import worker from "./index.ts";

// Only wrangler.dev.jsonc selects this entrypoint. Production has no auth bypass.
// MCP consent at /authorize still requires Access, so it is unavailable locally.
const app = new Hono<{ Bindings: Env }>();
app.route("/api", api);

const fetch = withMcp(app);
export default {
  ...worker,
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    return withDatabase(env, ctx, (scopedEnv, scopedCtx) =>
      fetch(request, scopedEnv, scopedCtx),
    );
  },
};

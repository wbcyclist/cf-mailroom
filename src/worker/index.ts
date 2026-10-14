import { withDatabase } from "./runtime.ts";
import { Hono } from "hono";
import { withMcp } from "../mcp/index.ts";
import { api } from "./api/index.ts";
import { requireWebAccess } from "./api/access.ts";
import { processDraftRun } from "./agent/draft.ts";
import { receiveEmail } from "./email/receive.ts";

const app = new Hono<{ Bindings: Env }>();
app.use("/api/*", requireWebAccess);
app.route("/api", api);

const fetch = withMcp(app);

export default {
  fetch(request, env, ctx) {
    return withDatabase(env, ctx, (scopedEnv, scopedCtx) =>
      fetch(request, scopedEnv, scopedCtx),
    );
  },
  email(message, env, ctx) {
    return withDatabase(env, ctx, (scopedEnv, scopedCtx) =>
      receiveEmail(message, scopedEnv, scopedCtx),
    );
  },
  async queue(
    batch: MessageBatch<{ runId: number }>,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    await withDatabase(env, ctx, async (scopedEnv) =>
      Promise.all(
        batch.messages.map(async (message) => {
          try {
            await processDraftRun(scopedEnv, message.body.runId);
            message.ack();
          } catch {
            message.retry({
              delaySeconds: Math.min(300, 15 * 2 ** message.attempts),
            });
          }
        }),
      ),
    );
  },
} satisfies ExportedHandler<WorkerEnv, { runId: number }>;

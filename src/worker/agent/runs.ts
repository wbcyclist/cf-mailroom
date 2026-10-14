import { requireAiSettings } from "../ai-model.ts";

export async function enqueueDraftRun(
  env: Env,
  threadId: number,
  inboundMessageId: number,
  options: { retryFailed?: boolean } = {},
): Promise<number> {
  await requireAiSettings(env);
  const run = await env.DB.one<{ id: number }>(
    `INSERT INTO draft_runs (thread_id, inbound_message_id)
     VALUES ($1, $2)
     ON CONFLICT (inbound_message_id) DO UPDATE
     SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL
     WHERE draft_runs.status = 'failed' AND $3::boolean
     RETURNING id`,
    [threadId, inboundMessageId, options.retryFailed ?? false],
  );
  if (run) {
    await env.DRAFT_QUEUE.send({ runId: run.id });
    return run.id;
  }

  const existing = await env.DB.one<{ id: number; status: string }>(
    "SELECT id, status FROM draft_runs WHERE inbound_message_id = $1",
    [inboundMessageId],
  );
  if (!existing) throw new Error("Could not create draft run");
  // Recover a failed queue send without resetting a run that another delivery
  // has claimed. Only the explicit retry action can reopen a failed run.
  if (existing.status === "queued") {
    await env.DRAFT_QUEUE.send({ runId: existing.id });
  }
  return existing.id;
}

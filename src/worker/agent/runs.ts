export async function enqueueDraftRun(
  env: Env,
  threadId: number,
  inboundMessageId: number,
): Promise<number> {
  const existing = await env.DB.one<{
    id: number;
    status: "queued" | "generating" | "ready" | "failed" | "superseded";
  }>("SELECT id, status FROM draft_runs WHERE inbound_message_id = $1", [
    inboundMessageId,
  ]);

  if (
    existing?.status === "ready" ||
    existing?.status === "generating" ||
    existing?.status === "superseded"
  )
    return existing.id;

  const run = existing
    ? await env.DB.one<{ id: number }>(
        `UPDATE draft_runs
         SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL
         WHERE id = $1 RETURNING id`,
        [existing.id],
      )
    : await env.DB.one<{ id: number }>(
        `INSERT INTO draft_runs (thread_id, inbound_message_id)
         VALUES ($1, $2) RETURNING id`,
        [threadId, inboundMessageId],
      );

  if (!run) throw new Error("Could not create draft run");
  await env.DRAFT_QUEUE.send({ runId: run.id });
  return run.id;
}

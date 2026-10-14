import { requireAiSettings } from "../ai-model.ts";
import { claimQueueBudget, UsageLimitError } from "../usage-budget.ts";

/** Expired claims are terminal: their paid request may already have completed. */
export async function expireDraftRuns(env: Env) {
  await env.DB.query(
    `UPDATE draft_runs SET status = 'failed', finished_at = now(),
       error = 'Draft task expired. Review the conversation before retrying.'
     WHERE (status = 'generating' AND started_at < now() - interval '5 minutes')
        OR (status = 'queued' AND COALESCE(queued_at, created_at) < now() - interval '1 hour')`,
  );
}

export async function enqueueDraftRun(
  env: Env,
  threadId: number,
  inboundMessageId: number,
  options: { retryFailed?: boolean } = {},
): Promise<number> {
  await requireAiSettings(env);
  const result = await env.DB.transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`draft:${inboundMessageId}`]);
    let run = await db.one<{ id: number; status: string; dispatch_id: string | null; retry_after: string | null }>(
      "SELECT id, status, dispatch_id, retry_after FROM draft_runs WHERE inbound_message_id = $1 FOR UPDATE", [inboundMessageId],
    );
    if (run && !(run.status === "failed" && options.retryFailed) &&
        !(run.status === "queued" && !run.dispatch_id) &&
        !(run.status === "deferred" && (!run.retry_after || Date.parse(run.retry_after) <= Date.now()))) {
      return { id: run.id, dispatchId: null };
    }
    if (!run) {
      run = await db.one(
        "INSERT INTO draft_runs (thread_id, inbound_message_id) VALUES ($1, $2) RETURNING id, status, dispatch_id, retry_after",
        [threadId, inboundMessageId],
      );
    }
    if (!run) throw new Error("Could not create draft run");
    try {
      await claimQueueBudget({ ...env, DB: db });
    } catch (error) {
      if (!(error instanceof UsageLimitError)) throw error;
      await db.query("UPDATE draft_runs SET status = 'deferred', error = $2, retry_after = $3 WHERE id = $1",
        [run.id, error.message, error.retryAfter]);
      return { id: run.id, dispatchId: null };
    }
    const dispatchId = crypto.randomUUID();
    await db.query(
      `UPDATE draft_runs SET status = 'queued', dispatch_id = $2, queued_at = now(),
       error = NULL, retry_after = NULL, started_at = NULL, finished_at = NULL WHERE id = $1`,
      [run.id, dispatchId],
    );
    return { id: run.id, dispatchId };
  });
  const dispatch = result.dispatchId;
  if (!dispatch) return result.id;
  try {
    await env.DRAFT_QUEUE.send({ runId: result.id, dispatchId: dispatch });
  } catch {
    // The provider may have accepted the message. Revoke this dispatch token;
    // a later explicit retry gets a new token and a new budget reservation.
    await env.DB.query(
      `UPDATE draft_runs SET status = 'failed', error = 'Queue send failed. Retry explicitly.', finished_at = now()
       WHERE id = $1 AND dispatch_id = $2 AND status = 'queued'`, [result.id, dispatch],
    );
  }
  return result.id;
}

/** One bounded recovery pass. No queue retry is used to wait for a new day. */
export async function resumeDeferredDraftRuns(env: Env) {
  await env.DB.query(
    `DELETE FROM inbound_usage WHERE period IN (
       SELECT period FROM inbound_usage WHERE period < to_char(now() AT TIME ZONE 'UTC' - interval '2 days', 'YYYY-MM-DD')
       ORDER BY period LIMIT 200
     )`,
  );
  await expireDraftRuns(env);
  const { rows } = await env.DB.query<{ thread_id: number; inbound_message_id: number }>(
    `SELECT dr.thread_id, dr.inbound_message_id FROM draft_runs dr
     JOIN threads t ON t.id = dr.thread_id JOIN mailboxes m ON m.id = t.mailbox_id
     WHERE dr.status = 'deferred' AND dr.retry_after <= now() AND m.agent_mode = 'draft'
       AND dr.inbound_message_id = (SELECT id FROM messages WHERE thread_id = t.id AND direction = 'inbound'
         ORDER BY created_at DESC, id DESC LIMIT 1)
     ORDER BY dr.retry_after, dr.id LIMIT 100`,
  );
  for (const run of rows) await enqueueDraftRun(env, run.thread_id, run.inbound_message_id);
}

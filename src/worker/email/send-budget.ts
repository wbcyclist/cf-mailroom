import { type Database } from "../database.ts";
export interface SendBudgetEnv {
  DB: Database;
}

export async function claimDailySendBudget(
  env: SendBudgetEnv,
  actorId: string,
  limit: number,
): Promise<boolean> {
  if (!Number.isInteger(limit) || limit <= 0) return false;
  const day = new Date().toISOString().slice(0, 10);
  const claimed = await env.DB.one<{ send_count: number }>(
    `INSERT INTO mcp_send_budget (actor_id, budget_date, send_count)
     VALUES ($1, $2, 1)
     ON CONFLICT(actor_id, budget_date) DO UPDATE SET
       send_count = mcp_send_budget.send_count + 1,
       updated_at = now()
     WHERE mcp_send_budget.send_count < $3
     RETURNING send_count`,
    [actorId, day, limit],
  );
  return Boolean(claimed);
}

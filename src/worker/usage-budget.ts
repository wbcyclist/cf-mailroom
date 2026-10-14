import type { Database } from "./database.ts";

// A small queue message normally costs three operations. Reserve additional
// reads, DLQ writes/deletes, and headroom for the configured three retries.
export const QUEUE_OPERATIONS_PER_JOB = 10;

export class UsageLimitError extends Error {
  retryAfter: string;
  constructor(resource: string, retryAfter: string) {
    super(`${resource} usage limit reached. Resumes after ${retryAfter}.`);
    this.name = "UsageLimitError";
    this.retryAfter = retryAfter;
  }
}

export function usageLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  // Invalid settings stop dispatch instead of silently removing a cost guard.
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function claimUsageBudget(
  db: Database,
  resource: "queue" | "ai" | "mcp",
  amount: number,
  dailyLimit: number,
  monthlyLimit: number,
  now = new Date(),
): Promise<void> {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Invalid usage reservation");
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`usage:${resource}`]);
    const { rows } = await tx.query<{ period: string; used: number }>(
      "SELECT period, used FROM usage_budgets WHERE resource = $1 AND period = ANY($2::text[])",
      [resource, [day, month]],
    );
    const used = new Map(rows.map(row => [row.period, row.used]));
    if ((used.get(month) ?? 0) + amount > monthlyLimit) throw new UsageLimitError(resource, nextMonth);
    if ((used.get(day) ?? 0) + amount > dailyLimit) throw new UsageLimitError(resource, tomorrow);
    await tx.query(
      `INSERT INTO usage_budgets (resource, period, used) VALUES ($1, $2, $4), ($1, $3, $4)
       ON CONFLICT (resource, period) DO UPDATE SET used = usage_budgets.used + EXCLUDED.used`,
      [resource, day, month, amount],
    );
  });
}

export function claimQueueBudget(env: Env) {
  return claimUsageBudget(env.DB, "queue", QUEUE_OPERATIONS_PER_JOB,
    usageLimit(env.QUEUE_DAILY_OPERATION_LIMIT, 10_000),
    usageLimit(env.QUEUE_MONTHLY_OPERATION_LIMIT, 900_000));
}

export function claimAiBudget(env: Env) {
  return claimUsageBudget(env.DB, "ai", 1,
    usageLimit(env.AI_DAILY_CALL_LIMIT, 100), usageLimit(env.AI_MONTHLY_CALL_LIMIT, 1_000));
}

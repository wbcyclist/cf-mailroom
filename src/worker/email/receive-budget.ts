import type { Database } from "../database.ts";
import { usageLimit } from "../usage-budget.ts";

export class InboundLimitError extends Error {}

function storageLimit(env: Env) {
  return usageLimit(env.MAIL_STORAGE_LIMIT_BYTES, 1024 * 1024 * 1024);
}

/** Count attempted deliveries before reading MIME. Failures and duplicates are not refunded. */
export async function claimInboundBudget(env: Env, rawBytes: number, now = new Date()) {
  if (!Number.isSafeInteger(rawBytes) || rawBytes <= 0) throw new InboundLimitError("Invalid message size");
  const minute = now.toISOString().slice(0, 16);
  const day = minute.slice(0, 10);
  await env.DB.transaction(async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('inbound-usage', 0))");
    const storage = await db.one<{ used_bytes: number }>("SELECT used_bytes FROM mail_storage_usage WHERE id = 1");
    if (!storage) throw new Error("Mail storage accounting is unavailable");
    if (storage.used_bytes + rawBytes > storageLimit(env)) throw new InboundLimitError("Mailbox storage limit reached. Contact the administrator.");
    const { rows } = await db.query<{ period: string; message_count: number; raw_bytes: number }>(
      "SELECT period, message_count, raw_bytes FROM inbound_usage WHERE period = ANY($1::text[])", [[minute, day]],
    );
    const periods = new Map(rows.map(row => [row.period, row]));
    if ((periods.get(minute)?.message_count ?? 0) + 1 > usageLimit(env.INBOUND_MINUTE_MESSAGE_LIMIT, 30)) {
      throw new InboundLimitError("Inbound rate limit reached. Send again after the next UTC minute.");
    }
    if ((periods.get(day)?.message_count ?? 0) + 1 > usageLimit(env.INBOUND_DAILY_MESSAGE_LIMIT, 500) ||
        (periods.get(day)?.raw_bytes ?? 0) + rawBytes > usageLimit(env.INBOUND_DAILY_BYTE_LIMIT, 100 * 1024 * 1024)) {
      throw new InboundLimitError("Daily inbound limit reached. Send again after 00:00 UTC.");
    }
    await db.query(
      `INSERT INTO inbound_usage (period, message_count, raw_bytes) VALUES ($1, 1, $3), ($2, 1, $3)
       ON CONFLICT (period) DO UPDATE SET message_count = inbound_usage.message_count + 1,
         raw_bytes = inbound_usage.raw_bytes + EXCLUDED.raw_bytes`, [minute, day, rawBytes],
    );
  });
}

/** Hold this row lock through all file and body writes in the delivery transaction. */
export async function checkInboundStorage(db: Database, env: Env, addedBytes: number) {
  const storage = await db.one<{ used_bytes: number }>("SELECT used_bytes FROM mail_storage_usage WHERE id = 1 FOR UPDATE");
  if (!storage) throw new Error("Mail storage accounting is unavailable");
  if (storage.used_bytes + addedBytes > storageLimit(env)) {
    throw new InboundLimitError("Mailbox storage limit reached. Contact the administrator.");
  }
}

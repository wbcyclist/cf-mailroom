import { type Database, statement } from "../database.ts";
import { normalizeSubject } from "./rules.ts";
import type { ComposeAttemptResult } from "../../shared/types.ts";
export type { ComposeAttemptResult } from "../../shared/types.ts";
import {
  attachmentFingerprint,
  normalizeAttachments,
  parseStagedAttachments,
  recordAttachmentStatements,
  sendableAttachments,
  stageAttachments,
  type NormalizedAttachment,
  type OutboundAttachmentInput,
  type StagedAttachment,
} from "./attachments.ts";
import { sendEmail, type SendEmailEnv } from "./send.ts";
import { claimDailySendBudget } from "./send-budget.ts";

export interface ComposeEnv extends SendEmailEnv {
  DB: Database;
}

export interface ComposeIntent {
  attemptId: string;
  mailboxId: number;
  to: string[];
  subject: string;
  text: string;
  attachments?: OutboundAttachmentInput[];
  actorId?: string;
  oauthClientId?: string;
  dailySendLimit?: number;
  sentBy?: "human" | "agent";
}

export type ComposeAttemptStatus = "pending" | "sending" | "sent" | "failed";

interface StoredAttempt {
  id: string;
  mailbox_id: number;
  thread_id: number | null;
  status: ComposeAttemptStatus;
  to_addresses: string;
  subject: string;
  text_body: string;
  attachments: string;
  message_id: string | null;
  actor_id: string | null;
  oauth_client_id: string | null;
  error: string | null;
  sent_by: "human" | "agent";
}

export async function sendNewEmailAttempt(
  env: ComposeEnv,
  intent: ComposeIntent,
): Promise<ComposeAttemptResult> {
  const normalized = normalizeIntent(intent);
  const attachments = normalizeAttachments(intent.attachments ?? []);
  if (normalized.to.length !== 1 || !normalized.to[0]) {
    throw new ComposeIntentError(
      "New email requires exactly one recipient",
      400,
    );
  }
  if (!normalized.subject)
    throw new ComposeIntentError("Subject is required", 400);
  if (!normalized.text && attachments.length === 0) {
    throw new ComposeIntentError("Message text is required", 400);
  }
  const existing = await getAttempt(env, normalized.attemptId);
  if (existing) {
    existingResult(existing, normalized, attachments);
    if (existing.status === "sent" || existing.status === "failed") {
      return existingResult(existing, normalized, attachments);
    }
    if (
      existing.status === "sending" &&
      (!existing.message_id || !existing.thread_id)
    ) {
      return existingResult(existing, normalized, attachments);
    }
  }

  const inbox = await env.DB.one<{
    id: number;
    address: string;
    domain_status: "pending" | "active" | null;
  }>(
    `SELECT m.id, m.address, d.status AS domain_status
     FROM mailboxes m LEFT JOIN domains d ON d.id = m.domain_id
     WHERE m.id = $1`,
    [normalized.mailboxId],
  );
  if (!inbox) throw new ComposeIntentError("Inbox not found", 404);
  if (inbox.domain_status !== "active") {
    throw new ComposeIntentError(
      "Inbox domain is not ready for outbound sending",
      409,
    );
  }

  let staged: StagedAttachment[] = existing
    ? parseStagedAttachments(existing.attachments)
    : [];

  if (!existing) {
    try {
      await env.DB.transaction(async (db) => {
        await db.query("SELECT id FROM mailboxes WHERE id = $1 FOR UPDATE", [
          normalized.mailboxId,
        ]);
        staged = await stageAttachments(
          db,
          normalized.mailboxId,
          normalized.attemptId,
          attachments,
        );
        await db.query(
          `INSERT INTO outbound_attempts
           (id, mailbox_id, status, to_addresses, subject, text_body, attachments,
            actor_id, oauth_client_id, sent_by)
         VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9)`,
          [
            normalized.attemptId,
            normalized.mailboxId,
            JSON.stringify(normalized.to),
            normalized.subject,
            normalized.text,
            JSON.stringify(staged),
            normalized.actorId ?? null,
            normalized.oauthClientId ?? null,
            normalized.sentBy ?? "agent",
          ],
        );
        if (
          normalized.actorId &&
          normalized.dailySendLimit !== undefined &&
          !(await claimDailySendBudget(
            { DB: db },
            normalized.actorId,
            normalized.dailySendLimit,
          ))
        ) {
          throw new ComposeIntentError("Daily MCP send limit reached", 429);
        }
      });
    } catch (error) {
      if (error instanceof ComposeIntentError) throw error;
      const raced = await getAttempt(env, normalized.attemptId);
      if (raced) return existingResult(raced, normalized, attachments);
      throw error;
    }
  }

  if (!existing || existing.status === "pending") {
    const claimed = await env.DB.one<{ id: string }>(
      `UPDATE outbound_attempts
       SET status = 'sending', updated_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING id`,
      [normalized.attemptId],
    );
    if (!claimed) {
      const raced = await getAttempt(env, normalized.attemptId);
      if (!raced) throw new ComposeIntentError("Send Attempt disappeared", 500);
      return existingResult(raced, normalized, attachments);
    }
  }

  const now = new Date().toISOString();
  let conversationId = existing?.thread_id ?? null;
  if (conversationId === null) {
    try {
      conversationId = await env.DB.transaction(async (db) => {
        const thread = await db.one<{ id: number }>(
          `INSERT INTO threads (mailbox_id, subject, normalized_subject, snippet, status, is_read, message_count, last_message_at)
           VALUES ($1, $2, $3, $4, 'open', 1, 0, $5) RETURNING id`,
          [
            normalized.mailboxId,
            normalized.subject,
            normalizeSubject(normalized.subject),
            snippet(normalized.text),
            now,
          ],
        );
        if (!thread) throw new Error("Conversation was not created");
        await db.query(
          "UPDATE outbound_attempts SET thread_id = $1, updated_at = $2 WHERE id = $3",
          [thread.id, now, normalized.attemptId],
        );
        return thread.id;
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not create Conversation";
      await markFailed(env, normalized.attemptId, message);
      return failedResult(normalized.attemptId, null, message);
    }
  }

  let messageId = existing?.message_id ?? null;
  if (!messageId) {
    try {
      ({ messageId } = await sendEmail(env, {
        from: { address: inbox.address },
        to: normalized.to,
        subject: normalized.subject,
        text: normalized.text,
        attachments: sendableAttachments(attachments),
        autoSubmitted:
          normalized.sentBy === "human" ? undefined : "auto-generated",
        attemptId: normalized.attemptId,
      }));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Email provider rejected the message";
      await env.DB.batch([
        statement(
          `UPDATE outbound_attempts
           SET status = 'failed', thread_id = NULL, error = $1,
               updated_at = now()
           WHERE id = $2`,
          [message.slice(0, 2000), normalized.attemptId],
        ),
        statement("DELETE FROM threads WHERE id = $1 AND message_count = 0", [
          conversationId,
        ]),
      ]);
      return failedResult(normalized.attemptId, null, message);
    }
    try {
      await env.DB.query(
        `UPDATE outbound_attempts
         SET message_id = $1, updated_at = now()
         WHERE id = $2 AND status = 'sending'`,
        [messageId, normalized.attemptId],
      );
    } catch {
      console.error("Could not checkpoint provider result for Send Attempt", {
        attemptId: normalized.attemptId,
      });
    }
  }

  await env.DB.transaction(async (db) => {
    const attempt = await db.one<{ status: string }>(
      "SELECT status FROM outbound_attempts WHERE id = $1 FOR UPDATE", [normalized.attemptId],
    );
    if (!attempt) throw new ComposeIntentError("Send Attempt disappeared", 500);
    if (attempt.status === "sent") return;
  await db.batch([
    statement(
      `INSERT INTO messages
         (thread_id, message_id, references_ids, direction, sent_by,
          from_address, from_name, to_addresses, reply_to_addresses,
          subject, text_body, created_at)
       VALUES ($1, $2, '[]', 'outbound', $3, $4, NULL, $5, '[]', $6, $7, $8)`,
      [
        conversationId,
        messageId,
        normalized.sentBy ?? "agent",
        inbox.address,
        JSON.stringify(normalized.to),
        normalized.subject,
        normalized.text,
        now,
      ],
    ),
    ...recordAttachmentStatements(staged, messageId),
    statement(
      `UPDATE threads
       SET message_count = 1, snippet = $1, last_message_at = $2, is_read = 1
       WHERE id = $3`,
      [
        snippet(normalized.text) ||
          staged
            .map((attachment) => attachment.filename ?? "attachment")
            .join(", ")
            .slice(0, 140),
        now,
        conversationId,
      ],
    ),
    statement(
      `UPDATE outbound_attempts
       SET status = 'sent', message_id = $1, error = NULL, updated_at = $2
       WHERE id = $3`,
      [messageId, now, normalized.attemptId],
    ),
  ]);
  });

  return {
    ok: true,
    attempt_id: normalized.attemptId,
    status: "sent",
    conversation_id: conversationId,
    message_id: messageId,
  };
}

async function getAttempt(
  env: ComposeEnv,
  id: string,
): Promise<StoredAttempt | null> {
  return env.DB.one<StoredAttempt>(
    "SELECT * FROM outbound_attempts WHERE id = $1",
    [id],
  );
}

async function markFailed(
  env: ComposeEnv,
  id: string,
  error: string,
): Promise<void> {
  await env.DB.query(
    `UPDATE outbound_attempts
     SET status = 'failed', error = $1, updated_at = now()
     WHERE id = $2`,
    [error.slice(0, 2000), id],
  );
}

function existingResult(
  existing: StoredAttempt,
  intent: NormalizedIntent,
  attachments: NormalizedAttachment[],
): ComposeAttemptResult {
  if (
    existing.mailbox_id !== intent.mailboxId ||
    existing.to_addresses !== JSON.stringify(intent.to) ||
    existing.subject !== intent.subject ||
    existing.text_body !== intent.text ||
    attachmentFingerprint(parseStagedAttachments(existing.attachments)) !==
      attachmentFingerprint(attachments) ||
    existing.actor_id !== (intent.actorId ?? null) ||
    existing.oauth_client_id !== (intent.oauthClientId ?? null) ||
    (existing.sent_by ?? "agent") !== (intent.sentBy ?? "agent")
  ) {
    throw new ComposeIntentError(
      "Send Attempt id was already used for different content",
      409,
    );
  }
  return {
    ok: existing.status === "sent",
    attempt_id: existing.id,
    status: existing.status,
    conversation_id: existing.thread_id,
    message_id: existing.message_id,
    ...(existing.error ? { error: existing.error } : {}),
  };
}

function failedResult(
  id: string,
  conversationId: number | null,
  error: string,
): ComposeAttemptResult {
  return {
    ok: false,
    attempt_id: id,
    status: "failed",
    conversation_id: conversationId,
    message_id: null,
    error,
  };
}

interface NormalizedIntent extends Omit<
  ComposeIntent,
  "to" | "subject" | "text"
> {
  to: string[];
  subject: string;
  text: string;
}

function normalizeIntent(intent: ComposeIntent): NormalizedIntent {
  return {
    ...intent,
    to: [
      ...new Map(
        intent.to.map((address) => {
          const normalized = normalizeEmailAddress(address);
          return [normalized.toLowerCase(), normalized] as const;
        }),
      ).values(),
    ],
    subject: intent.subject.trim(),
    text: intent.text.trim(),
  };
}

function normalizeEmailAddress(address: string): string {
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;
  return `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
}

function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

export class ComposeIntentError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

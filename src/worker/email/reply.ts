import { type Database, type SqlStatement, statement } from "../database.ts";
import type { ReplyAttemptResult } from "../../shared/types.ts";
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
import { MAX_MESSAGE_CHARS } from "../../shared/email-limits.ts";

export interface ReplyEnv extends SendEmailEnv {
  DB: Database;
}

export interface ReplyIntent {
  attemptId: string;
  threadId: number;
  text: string;
  attachments?: OutboundAttachmentInput[];
  draftId?: number;
  sentBy?: "human" | "agent";
  actorId?: string;
  oauthClientId?: string;
  inboundMessageId?: number;
  expectedRecipients?: string[];
  dailySendLimit?: number;
}

interface StoredAttempt {
  id: string;
  thread_id: number;
  inbound_message_id: number;
  draft_id: number | null;
  status: "pending" | "sending" | "sent" | "failed";
  text_body: string;
  to_addresses: string;
  attachments: string;
  message_id: string | null;
  error: string | null;
  sent_by?: "human" | "agent";
  actor_id?: string | null;
  oauth_client_id?: string | null;
}

export async function sendReplyAttempt(
  env: ReplyEnv,
  intent: ReplyIntent,
): Promise<ReplyAttemptResult> {
  if (typeof intent.text !== "string" || intent.text.length > MAX_MESSAGE_CHARS)
    throw new ReplyIntentError("Reply text exceeds the message limit", 400);
  const attachments = normalizeAttachments(intent.attachments ?? []);
  if (!intent.text.trim() && attachments.length === 0) {
    throw new ReplyIntentError("Reply text is required", 400);
  }
  const existing = await getAttempt(env, intent.attemptId);
  if (existing) {
    existingResult(existing, intent, attachments);
    if (existing.status === "sent" || existing.status === "failed") {
      return existingResult(existing, intent, attachments);
    }
    if (existing.status === "sending" && !existing.message_id) {
      return existingResult(existing, intent, attachments);
    }
  }

  const thread = await env.DB.one<{
    id: number;
    mailbox_id: number;
    subject: string;
    mailbox_address: string;
  }>(
    `SELECT t.id, t.mailbox_id, t.subject, m.address AS mailbox_address
     FROM threads t JOIN mailboxes m ON m.id = t.mailbox_id WHERE t.id = $1`,
    [intent.threadId],
  );
  if (!thread) throw new ReplyIntentError("Conversation not found", 404);

  const lastInbound = await env.DB.one<{
    id: number;
    message_id: string;
    from_address: string;
    reply_to_addresses: string;
    references_ids: string;
  }>(
    `SELECT id, message_id, from_address, reply_to_addresses, references_ids
     FROM messages
     WHERE thread_id = $1 AND direction = 'inbound'
       AND ($2 = 0 OR id = $3)
       AND ($4 = 0 OR id = (
         SELECT latest.id FROM messages latest
         WHERE latest.thread_id = $5 AND latest.direction = 'inbound'
         ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
       ))
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [
      intent.threadId,
      existing?.inbound_message_id ?? intent.inboundMessageId ?? 0,
      existing?.inbound_message_id ?? intent.inboundMessageId ?? 0,
      existing ? 0 : (intent.inboundMessageId ?? 0),
      intent.threadId,
    ],
  );
  if (!lastInbound) {
    if (!existing && intent.inboundMessageId !== undefined) {
      throw new ReplyIntentError(
        "Conversation advanced after it was read; read it again before replying",
        409,
      );
    }
    throw new ReplyIntentError("No inbound message to reply to", 400);
  }

  const recipients = parseAddresses(lastInbound.reply_to_addresses);
  if (recipients.length === 0) recipients.push(lastInbound.from_address);
  if (recipients.length > 20) {
    throw new ReplyIntentError("Reply has too many recipients", 400);
  }
  if (
    intent.expectedRecipients &&
    !sameAddresses(recipients, intent.expectedRecipients)
  ) {
    throw new ReplyIntentError(
      "Reply recipient changed after it was reviewed; read the Conversation again",
      409,
    );
  }

  if (!existing && intent.draftId !== undefined) {
    const draft = await env.DB.one(
      `SELECT id FROM drafts WHERE id = $1 AND thread_id = $2
       AND source_inbound_message_id = $3 AND status = 'pending'`,
      [intent.draftId, intent.threadId, lastInbound.id],
    );
    if (!draft) throw new ReplyIntentError("Draft no longer matches the reply target", 409);
  }

  let staged: StagedAttachment[] = existing
    ? parseStagedAttachments(existing.attachments)
    : [];

  if (!existing) {
    try {
      await env.DB.transaction(async (db) => {
        await db.query("SELECT id FROM mailboxes WHERE id = $1 FOR UPDATE", [
          thread.mailbox_id,
        ]);
        staged = await stageAttachments(
          db,
          thread.mailbox_id,
          intent.attemptId,
          attachments,
        );
        await db.query(
          `INSERT INTO reply_attempts
           (id, thread_id, inbound_message_id, draft_id, status, text_body, to_addresses,
            attachments, sent_by, actor_id, oauth_client_id)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10)`,
          [
            intent.attemptId,
            intent.threadId,
            lastInbound.id,
            intent.draftId ?? null,
            intent.text.trim(),
            JSON.stringify(recipients),
            JSON.stringify(staged),
            intent.sentBy ?? (intent.draftId ? "agent" : "human"),
            intent.actorId ?? null,
            intent.oauthClientId ?? null,
          ],
        );
        if (
          intent.actorId &&
          intent.dailySendLimit !== undefined &&
          !(await claimDailySendBudget(
            { DB: db },
            intent.actorId,
            intent.dailySendLimit,
          ))
        ) {
          throw new ReplyIntentError("Daily MCP send limit reached", 429);
        }
      });
    } catch (error) {
      if (error instanceof ReplyIntentError) throw error;
      const raced = await getAttempt(env, intent.attemptId);
      if (raced) return existingResult(raced, intent, attachments);
      throw error;
    }
  }

  if (!existing || existing.status === "pending") {
    const claimed = await env.DB.one<{ id: string }>(
      `UPDATE reply_attempts
       SET status = 'sending', updated_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING id`,
      [intent.attemptId],
    );
    if (!claimed) {
      const raced = await getAttempt(env, intent.attemptId);
      if (!raced) throw new ReplyIntentError("Reply Attempt disappeared", 500);
      return existingResult(raced, intent, attachments);
    }
  }

  const references = boundedReferences([
    ...parseAddresses(lastInbound.references_ids),
    lastInbound.message_id,
  ]);
  const subject = /^re:/i.test(thread.subject)
    ? thread.subject
    : `Re: ${thread.subject}`;

  let messageId = existing?.message_id ?? null;
  if (!messageId) {
    try {
      ({ messageId } = await sendEmail(env, {
        from: { address: thread.mailbox_address },
        to: recipients,
        subject,
        text: intent.text.trim(),
        attachments: sendableAttachments(attachments),
        inReplyTo: lastInbound.message_id,
        references,
        autoSubmitted:
          (intent.sentBy ?? (intent.draftId ? "agent" : "human")) === "agent"
            ? "auto-replied"
            : undefined,
        attemptId: intent.attemptId,
      }));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Email provider rejected the reply";
      await env.DB.query(
        `UPDATE reply_attempts
         SET status = 'failed', error = $1, updated_at = now()
         WHERE id = $2`,
        [message.slice(0, 2000), intent.attemptId],
      );
      return {
        ok: false,
        attempt_id: intent.attemptId,
        status: "failed",
        message_id: null,
        error: message,
      };
    }
    try {
      await env.DB.query(
        `UPDATE reply_attempts
         SET message_id = $1, updated_at = now()
         WHERE id = $2 AND status = 'sending'`,
        [messageId, intent.attemptId],
      );
    } catch {
      console.error("Could not checkpoint provider result for Reply Attempt", {
        attemptId: intent.attemptId,
      });
    }
  }

  const now = new Date().toISOString();
  const snippet =
    intent.text.replace(/\s+/g, " ").trim().slice(0, 140) ||
    staged
      .map((attachment) => attachment.filename ?? "attachment")
      .join(", ")
      .slice(0, 140);
  const statements: SqlStatement[] = [
    statement(
      `INSERT INTO messages
         (thread_id, message_id, in_reply_to, references_ids, direction, sent_by,
          from_address, from_name, to_addresses, reply_to_addresses,
          subject, text_body, created_at)
       VALUES ($1, $2, $3, $4, 'outbound', $5, $6, $7, $8, '[]', $9, $10, $11)`,
      [
        intent.threadId,
        messageId,
        lastInbound.message_id,
        JSON.stringify(references),
        intent.sentBy ?? (intent.draftId ? "agent" : "human"),
        thread.mailbox_address,
        null,
        JSON.stringify(recipients),
        subject,
        intent.text.trim(),
        now,
      ],
    ),
    ...recordAttachmentStatements(staged, messageId, intent.threadId),
    statement(
      `UPDATE threads
       SET snippet = $1, message_count = message_count + 1, last_message_at = $2, is_read = 1
       WHERE id = $3`,
      [snippet, now, intent.threadId],
    ),
    statement(
      `UPDATE reply_attempts
       SET status = 'sent', message_id = $1, error = NULL, updated_at = $2
       WHERE id = $3`,
      [messageId, now, intent.attemptId],
    ),
  ];
  if (intent.draftId) {
    statements.push(
      statement(
        "UPDATE drafts SET status = 'sent' WHERE id = $1 AND thread_id = $2",
        [intent.draftId, intent.threadId],
      ),
    );
  }
  await env.DB.transaction(async (db) => {
    const attempt = await db.one<{ status: string }>(
      "SELECT status FROM reply_attempts WHERE id = $1 FOR UPDATE", [intent.attemptId],
    );
    if (!attempt) throw new ReplyIntentError("Reply Attempt disappeared", 500);
    if (attempt.status !== "sent") await db.batch(statements);
  });

  return {
    ok: true,
    attempt_id: intent.attemptId,
    status: "sent",
    message_id: messageId,
  };
}

async function getAttempt(
  env: ReplyEnv,
  id: string,
): Promise<StoredAttempt | null> {
  return env.DB.one<StoredAttempt>(
    "SELECT * FROM reply_attempts WHERE id = $1",
    [id],
  );
}

function existingResult(
  existing: StoredAttempt,
  intent: ReplyIntent,
  attachments: NormalizedAttachment[],
): ReplyAttemptResult {
  const sentBy = intent.sentBy ?? (intent.draftId ? "agent" : "human");
  if (
    existing.thread_id !== intent.threadId ||
    existing.text_body !== intent.text.trim() ||
    existing.draft_id !== (intent.draftId ?? null) ||
    attachmentFingerprint(parseStagedAttachments(existing.attachments)) !==
      attachmentFingerprint(attachments) ||
    (intent.inboundMessageId !== undefined &&
      existing.inbound_message_id !== intent.inboundMessageId) ||
    (intent.expectedRecipients !== undefined &&
      !sameAddresses(
        parseAddresses(existing.to_addresses),
        intent.expectedRecipients,
      )) ||
    (existing.sent_by ?? "human") !== sentBy ||
    (existing.actor_id ?? null) !== (intent.actorId ?? null) ||
    (existing.oauth_client_id ?? null) !== (intent.oauthClientId ?? null)
  ) {
    throw new ReplyIntentError(
      "Reply Attempt id was already used for different content",
      409,
    );
  }
  return {
    ok: existing.status === "sent",
    attempt_id: existing.id,
    status: existing.status,
    message_id: existing.message_id,
    ...(existing.error ? { error: existing.error } : {}),
  };
}

function parseAddresses(raw: string): string[] {
  try {
    const values = JSON.parse(raw) as unknown;
    return Array.isArray(values)
      ? [
          ...new Set(
            values.filter(
              (value): value is string =>
                typeof value === "string" && value.length > 0,
            ),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

function sameAddresses(actual: string[], expected: string[]): boolean {
  const normalize = (values: string[]) =>
    [
      ...new Set(
        values.map((value) => value.trim().toLowerCase()).filter(Boolean),
      ),
    ].sort();
  const left = normalize(actual);
  const right = normalize(expected);
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function boundedReferences(values: string[]): string[] {
  const unique = [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ];
  const kept: string[] = [];
  let bytes = 0;
  for (const value of unique.reverse()) {
    const size =
      new TextEncoder().encode(value).byteLength + (kept.length ? 1 : 0);
    if (size > 1900) continue;
    if (bytes + size > 1900 || kept.length >= 40) break;
    kept.unshift(value);
    bytes += size;
  }
  return kept;
}

export class ReplyIntentError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

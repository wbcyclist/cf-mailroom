import { UsageLimitError } from "../usage-budget.ts";
import { putFile } from "../files.ts";
import { type SqlStatement, statement } from "../database.ts";
import PostalMime, { type Attachment, type Email } from "postal-mime";
import { enqueueDraftRun } from "../agent/runs.ts";
import { AiConfigurationError } from "../ai-model.ts";
import { splitQuotedTail } from "../../shared/quote.ts";
import { labelNewThread } from "./label.ts";
import { notifyNewEmail } from "../notifications/push.ts";
import {
  addressOf,
  addressesOf,
  attachmentBytes,
  hasReplyPrefix,
  isAutoSubmitted,
  normalizeSubject,
  rawFingerprint,
} from "./rules.ts";

export async function receiveEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const mailbox = await findMailbox(env, message.to.trim().toLowerCase());
  if (!mailbox) {
    message.setReject("Inbox not configured");
    return;
  }

  if (message.rawSize > 25 * 1024 * 1024) {
    message.setReject("Message exceeds the 25 MiB storage limit");
    return;
  }
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const fingerprint = await rawFingerprint(rawBuffer);
  const parsed = await PostalMime.parse(rawBuffer);
  const messageId = parsed.messageId ?? `<raw-${fingerprint}@mailroom.invalid>`;

  const subject = parsed.subject ?? "";
  const textBody = parsed.text ?? htmlToText(parsed.html ?? "");
  const sender = addressOf(parsed.from);
  const rawKey = `raw/${mailbox.id}/${fingerprint}.eml`;
  const now = new Date().toISOString();
  const snippet = splitQuotedTail(textBody)
    .main.replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  const stored = await env.DB.transaction(async (db) => {
    // Serialize delivery to this inbox with deletion and other inbound messages.
    const locked = await db.one(
      "SELECT id FROM mailboxes WHERE id = $1 FOR UPDATE",
      [mailbox.id],
    );
    if (!locked) throw new Error("Inbox was deleted during delivery");
    const duplicate = await db.one<{ id: number; thread_id: number }>(
      `SELECT msg.id, msg.thread_id FROM messages msg JOIN threads t ON t.id = msg.thread_id
       WHERE msg.message_id = $1 AND t.mailbox_id = $2`,
      [messageId, mailbox.id],
    );
    if (duplicate)
      return {
        threadId: duplicate.thread_id,
        messageId: duplicate.id,
        duplicate: true,
        newThread: false,
      };
    const txEnv = { ...env, DB: db };
    const existingThreadId = await resolveThread(
      txEnv,
      mailbox.id,
      subject,
      extractMessageIds(parsed),
      sender,
    );
    await putFile(db, mailbox.id, rawKey, rawBuffer, "message/rfc822");
    const args = { messageId, parsed, subject, textBody, rawKey, snippet, now };
    const result =
      existingThreadId === null
        ? await storeNewConversation(txEnv, { ...args, mailboxId: mailbox.id })
        : await appendToConversation(txEnv, {
            ...args,
            threadId: existingThreadId,
          });
    await storeAttachments(
      txEnv,
      mailbox.id,
      result.messageId,
      parsed.attachments,
    );
    return {
      ...result,
      duplicate: false,
      newThread: existingThreadId === null,
    };
  });
  if (stored.duplicate) {
    if (mailbox.agent_mode !== "off" && !isAutoSubmitted(parsed)) {
      await enqueueIfExternal(env, stored.threadId, stored.messageId, parsed);
    }
    return;
  }

  if (stored.newThread) {
    ctx.waitUntil(
      labelNewThread(env, stored.threadId, stored.messageId).catch((error) => {
        if (error instanceof UsageLimitError) return;
        console.error("Auto-label task failed", {
          threadId: stored.threadId,
          messageId: stored.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  }

  ctx.waitUntil(
    notifyNewEmail(env, {
      threadId: stored.threadId,
      senderName:
        parsed.from && "name" in parsed.from ? parsed.from.name : null,
      senderAddress: sender || "unknown",
      subject,
    }).catch((error) =>
      console.error("Browser notification task failed", error),
    ),
  );

  if (mailbox.agent_mode !== "off" && !isAutoSubmitted(parsed)) {
    await enqueueIfExternal(env, stored.threadId, stored.messageId, parsed);
  }
}

async function enqueueIfExternal(
  env: Env,
  threadId: number,
  inboundMessageId: number,
  parsed: Email,
): Promise<void> {
  const sender = addressOf(parsed.from);
  if (!sender) return;
  const fromOurAddress = await env.DB.one(
    "SELECT id FROM mailboxes WHERE address = $1",
    [sender],
  );
  if (!fromOurAddress) {
    try {
      await enqueueDraftRun(env, threadId, inboundMessageId);
    } catch (error) {
      if (!(error instanceof AiConfigurationError)) throw error;
    }
  }
}

async function findMailbox(
  env: Env,
  address: string,
): Promise<{ id: number; agent_mode: string } | null> {
  return env.DB.one<{ id: number; agent_mode: string }>(
    "SELECT id, agent_mode FROM mailboxes WHERE address = $1",
    [address],
  );
}

async function resolveThread(
  env: Env,
  mailboxId: number,
  subject: string,
  referencesIds: string[],
  sender: string,
): Promise<number | null> {
  if (referencesIds.length > 0) {
    const byHeader = await env.DB.one<{ id: number }>(
      `SELECT msg.thread_id AS id FROM messages msg
       JOIN threads t ON t.id = msg.thread_id
       WHERE t.mailbox_id = $1 AND msg.message_id = ANY($2::text[])
       ORDER BY msg.created_at DESC LIMIT 1`,
      [mailboxId, referencesIds],
    );
    if (byHeader) return byHeader.id;
  }

  const normalized = normalizeSubject(subject);
  if (!normalized || !sender || !hasReplyPrefix(subject)) return null;
  const bySubjectAndSender = await env.DB.one<{ id: number }>(
    `SELECT t.id FROM threads t
     WHERE t.mailbox_id = $1 AND t.normalized_subject = $2
       AND t.last_message_at > now() - interval '2 days'
       AND EXISTS (
         SELECT 1 FROM messages msg
         WHERE msg.thread_id = t.id AND msg.direction = 'inbound'
           AND lower(msg.from_address) = $3
       )
     ORDER BY t.last_message_at DESC LIMIT 1`,
    [mailboxId, normalized, sender],
  );
  return bySubjectAndSender?.id ?? null;
}

async function appendToConversation(
  env: Env,
  args: StoredMessageInput & { threadId: number; snippet: string },
): Promise<{ threadId: number; messageId: number }> {
  const results = await env.DB.batch([
    insertMessage(env, args.threadId, args),
    statement(
      `UPDATE threads
       SET snippet = $1, status = 'open', is_read = 0,
           message_count = message_count + 1, last_message_at = $2
       WHERE id = $3`,
      [args.snippet, args.now, args.threadId],
    ),
  ]);
  const messageId = Number(results[0].rows[0]?.id);
  if (!messageId) throw new Error("Inbound message was not stored");
  return { threadId: args.threadId, messageId };
}

async function storeNewConversation(
  env: Env,
  args: StoredMessageInput & { mailboxId: number; snippet: string },
): Promise<{ threadId: number; messageId: number }> {
  const thread = await env.DB.one<{ id: number }>(
    `INSERT INTO threads (mailbox_id, subject, normalized_subject, snippet, message_count, last_message_at)
     VALUES ($1, $2, $3, $4, 1, $5) RETURNING id`,
    [
      args.mailboxId,
      args.subject,
      normalizeSubject(args.subject),
      args.snippet,
      args.now,
    ],
  );
  if (!thread) throw new Error("Conversation was not created");

  const item = insertMessage(env, thread.id, args);
  const message = await env.DB.one<{ id: number }>(item.text, item.values);
  if (!message) throw new Error("Inbound message was not stored");
  return { threadId: thread.id, messageId: message.id };
}

interface StoredMessageInput {
  messageId: string;
  parsed: Email;
  subject: string;
  textBody: string;
  rawKey: string;
  now: string;
}

function insertMessage(env: Env, threadId: number, args: StoredMessageInput) {
  const { parsed } = args;
  const fromName =
    parsed.from && "name" in parsed.from ? parsed.from.name : null;
  return statement(
    `INSERT INTO messages
       (thread_id, message_id, in_reply_to, references_ids, direction, sent_by,
        from_address, from_name, to_addresses, cc_addresses, reply_to_addresses,
        subject, text_body, html_body, raw_key, is_auto_submitted, created_at)
     VALUES ($1, $2, $3, $4, 'inbound', 'external', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
    [
      threadId,
      args.messageId,
      parsed.inReplyTo ?? null,
      JSON.stringify(extractMessageIds(parsed)),
      addressOf(parsed.from) || "unknown",
      fromName,
      JSON.stringify(addressesOf(parsed.to)),
      JSON.stringify(addressesOf(parsed.cc)),
      JSON.stringify(addressesOf(parsed.replyTo)),
      args.subject,
      args.textBody,
      parsed.html ?? null,
      args.rawKey,
      isAutoSubmitted(parsed) ? 1 : 0,
      args.now,
    ],
  );
}

async function storeAttachments(
  env: Env,
  mailboxId: number,
  messageId: number,
  attachments: Attachment[],
): Promise<void> {
  if (attachments.length === 0) return;
  const statements: SqlStatement[] = [];

  for (const [index, attachment] of attachments.entries()) {
    const bytes = attachmentBytes(attachment.content);
    const fileKey = `attachments/${mailboxId}/${messageId}/${index}-${crypto.randomUUID()}`;
    await putFile(
      env.DB,
      mailboxId,
      fileKey,
      bytes,
      attachment.mimeType || "application/octet-stream",
    );
    statements.push(
      statement(
        `INSERT INTO attachments
           (message_id, filename, content_type, size, disposition, content_id, file_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          messageId,
          attachment.filename,
          attachment.mimeType || "application/octet-stream",
          bytes.byteLength,
          attachment.disposition,
          attachment.contentId ?? null,
          fileKey,
        ],
      ),
    );
  }

  await env.DB.batch(statements);
}

function extractMessageIds(parsed: Email): string[] {
  const raw = `${parsed.inReplyTo ?? ""} ${parsed.references ?? ""}`;
  return [...new Set(raw.match(/<[^<>\s]+>/g) ?? [])].slice(-100);
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export { normalizeSubject } from "./rules.ts";

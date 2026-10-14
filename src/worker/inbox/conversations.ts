import { type Database } from "../database.ts";
import {
  decodeCursor,
  encodeCursor,
  entityId,
} from "../../shared/entity-ids.ts";

export interface InboxDataEnv {
  DB: Database;
  WEB_APP_URL?: string;
}

export interface SearchConversationInput {
  inboxId?: number;
  status?: "open" | "archived" | "needs_human";
  unread?: boolean;
  query?: string;
  cursor?: string;
  limit: number;
}

interface ConversationRow {
  id: number;
  mailbox_id: number;
  mailbox_address: string;
  subject: string;
  snippet: string;
  status: "open" | "archived" | "needs_human";
  is_read: number;
  message_count: number;
  last_message_at: string;
  last_direction: "inbound" | "outbound" | null;
  correspondent: string | null;
  pending_draft_count: number;
  draft_run_status: string | null;
}

export async function listInboxes(env: InboxDataEnv) {
  const { rows: results } = await env.DB.query<{
    id: number;
    address: string;
    agent_mode: "off" | "draft" | "auto";
    can_send: number;
    unread_count: number;
  }>(`SELECT m.id, m.address, m.agent_mode,
       CASE WHEN d.status = 'active' THEN 1 ELSE 0 END AS can_send,
       (SELECT COUNT(*) FROM threads t
        WHERE t.mailbox_id = m.id AND t.is_read = 0 AND t.status != 'archived') AS unread_count
     FROM mailboxes m LEFT JOIN domains d ON d.id = m.domain_id
     ORDER BY m.address`);

  return {
    inboxes: results.map((inbox) => ({
      id: entityId("inbox", inbox.id),
      address: inbox.address,
      unread_count: inbox.unread_count,
      ai_drafting: inbox.agent_mode !== "off",
      can_send: inbox.can_send === 1,
    })),
  };
}

export async function searchConversations(
  env: InboxDataEnv,
  input: SearchConversationInput,
) {
  const conditions = ["t.status = $1"];
  const values: unknown[] = [input.status ?? "open"];

  if (input.inboxId !== undefined) {
    conditions.push(`t.mailbox_id = $${values.length + 1}`);
    values.push(input.inboxId);
  }
  if (input.unread !== undefined) {
    conditions.push(`t.is_read = $${values.length + 1}`);
    values.push(input.unread ? 0 : 1);
  }
  const query = input.query?.trim().toLowerCase();
  if (query) {
    const escaped = escapeLike(query);
    if (new TextEncoder().encode(escaped).byteLength > 46) {
      throw new ConversationInputError(
        "Search query is too long; use fewer or shorter terms",
      );
    }
    const pattern = `%${escaped}%`;
    conditions.push(
      `(lower(t.subject) LIKE $${values.length + 1} ESCAPE '\\' OR lower(t.snippet) LIKE $${values.length + 1} ESCAPE '\\' OR EXISTS (
         SELECT 1 FROM messages qm
         WHERE qm.thread_id = t.id
           AND (lower(substr(COALESCE(qm.text_body, ''), 1, 20000)) LIKE $${values.length + 1} ESCAPE '\\'
             OR lower(qm.from_address) LIKE $${values.length + 1} ESCAPE '\\')
       ))`,
    );
    values.push(pattern);
  }
  const cursor = decodeCursor(input.cursor);
  if (input.cursor && !cursor)
    throw new ConversationInputError("Invalid cursor");
  if (cursor) {
    conditions.push(
      `(t.last_message_at < $${values.length + 1} OR (t.last_message_at = $${values.length + 1} AND t.id < $${values.length + 2}))`,
    );
    values.push(cursor.lastMessageAt, cursor.id);
  }

  const { rows: results } = await env.DB.query<ConversationRow>(
    `SELECT t.id, t.mailbox_id, m.address AS mailbox_address,
       t.subject, t.snippet, t.status, t.is_read, t.message_count, t.last_message_at,
       latest_message.direction AS last_direction,
       CASE
         WHEN latest_message.direction = 'outbound'
           THEN 'To: ' || COALESCE((latest_message.to_addresses::jsonb ->> 0), '')
         ELSE COALESCE(latest_message.from_name, latest_message.from_address)
       END AS correspondent,
       (SELECT COUNT(*) FROM drafts d
        WHERE d.thread_id = t.id AND d.status = 'pending'
          AND d.source_inbound_message_id = (
            SELECT li.id FROM messages li
            WHERE li.thread_id = t.id AND li.direction = 'inbound'
            ORDER BY li.created_at DESC, li.id DESC LIMIT 1
          )) AS pending_draft_count,
       (SELECT dr.status FROM draft_runs dr
        WHERE dr.inbound_message_id = (
          SELECT li.id FROM messages li
          WHERE li.thread_id = t.id AND li.direction = 'inbound'
          ORDER BY li.created_at DESC, li.id DESC LIMIT 1
        ) ORDER BY dr.created_at DESC, dr.id DESC LIMIT 1) AS draft_run_status
     FROM threads t
     JOIN mailboxes m ON m.id = t.mailbox_id
     LEFT JOIN messages latest_message ON latest_message.id = (
       SELECT lm.id FROM messages lm WHERE lm.thread_id = t.id
       ORDER BY lm.created_at DESC, lm.id DESC LIMIT 1
     )
     WHERE ${conditions.join(" AND ")}
     ORDER BY t.last_message_at DESC, t.id DESC
     LIMIT $${values.length + 1}`,
    [...values, input.limit + 1],
  );

  const hasMore = results.length > input.limit;
  const page = results.slice(0, input.limit);
  const last = page.at(-1);
  return {
    conversations: page.map((conversation) => ({
      id: entityId("conversation", conversation.id),
      inbox_id: entityId("inbox", conversation.mailbox_id),
      inbox_address: conversation.mailbox_address,
      subject: conversation.subject,
      snippet: conversation.snippet,
      correspondent: conversation.correspondent,
      status: conversation.status,
      unread: conversation.is_read === 0,
      message_count: conversation.message_count,
      has_pending_draft: conversation.pending_draft_count > 0,
      ai_status: conversation.draft_run_status,
      last_message_direction: conversation.last_direction,
      last_message_at: conversation.last_message_at,
    })),
    next_cursor:
      hasMore && last
        ? encodeCursor({ lastMessageAt: last.last_message_at, id: last.id })
        : null,
  };
}

export async function getConversation(
  env: InboxDataEnv,
  id: number,
  limit: number,
) {
  const thread = await env.DB.one<{
    id: number;
    mailbox_id: number;
    mailbox_address: string;
    subject: string;
    status: "open" | "archived" | "needs_human";
    is_read: number;
    message_count: number;
    last_message_at: string;
  }>(
    `SELECT t.id, t.mailbox_id, m.address AS mailbox_address, t.subject,
       t.status, t.is_read, t.message_count, t.last_message_at
     FROM threads t JOIN mailboxes m ON m.id = t.mailbox_id
     WHERE t.id = $1`,
    [id],
  );
  if (!thread) return null;

  const [messageResult, draftResult, draftRun] = await Promise.all([
    env.DB.query<{
      id: number;
      direction: "inbound" | "outbound";
      sent_by: "external" | "human" | "agent";
      from_address: string;
      from_name: string | null;
      to_addresses: string;
      subject: string;
      reply_to_addresses: string;
      text_body: string | null;
      text_truncated: boolean;
      created_at: string;
    }>(
      `SELECT * FROM (
         SELECT id, direction, sent_by, from_address, from_name, to_addresses,
           subject, reply_to_addresses,
           substr(COALESCE(text_body, ''), 1, 20000) AS text_body,
           length(COALESCE(text_body, '')) > 20000 AS text_truncated, created_at
         FROM messages WHERE thread_id = $1
         ORDER BY created_at DESC, id DESC LIMIT $2
       ) recent ORDER BY created_at, id`,
      [id, limit],
    ),
    env.DB.query<{
      id: number;
      text_body: string;
      text_truncated: boolean;
      created_by: "human" | "agent";
      agent_notes: string | null;
      status: "pending";
      created_at: string;
    }>(
      `SELECT id, substr(text_body, 1, 20000) AS text_body,
         length(text_body) > 20000 AS text_truncated,
         created_by, agent_notes, status, created_at
       FROM drafts WHERE thread_id = $1 AND status = 'pending'
       ORDER BY created_at, id`,
      [id],
    ),
    env.DB.one<{
      status: string;
      error: string | null;
      started_at: string | null;
      finished_at: string | null;
    }>(
      `SELECT status, error, started_at, finished_at
       FROM draft_runs WHERE thread_id = $1
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [id],
    ),
  ]);

  const messageIds = messageResult.rows.map((message) => message.id);
  const attachmentsByMessage = new Map<
    number,
    Array<Record<string, unknown>>
  >();
  if (messageIds.length > 0) {
    const { rows: results } = await env.DB.query<{
      id: number;
      message_id: number;
      filename: string | null;
      content_type: string;
      size: number;
      disposition: string | null;
    }>(
      `SELECT id, message_id, filename, content_type, size, disposition
       FROM attachments WHERE message_id = ANY($1::bigint[]) ORDER BY id`,
      [messageIds],
    );
    for (const attachment of results) {
      const list = attachmentsByMessage.get(attachment.message_id) ?? [];
      list.push({
        id: `attachment_${attachment.id}`,
        filename: attachment.filename,
        content_type: attachment.content_type,
        size: attachment.size,
        disposition: attachment.disposition,
      });
      attachmentsByMessage.set(attachment.message_id, list);
    }
  }

  const webOrigin = (env.WEB_APP_URL ?? "https://mailroom.example.com").replace(
    /\/$/,
    "",
  );
  return {
    conversation: {
      id: entityId("conversation", thread.id),
      inbox_id: entityId("inbox", thread.mailbox_id),
      inbox_address: thread.mailbox_address,
      subject: thread.subject,
      status: thread.status,
      unread: thread.is_read === 0,
      message_count: thread.message_count,
      last_message_at: thread.last_message_at,
      web_url: `${webOrigin}/inbox/${thread.id}`,
    },
    messages: messageResult.rows.map((message) => ({
      id: entityId("message", message.id),
      direction: message.direction,
      sent_by: message.sent_by,
      from: {
        address: message.from_address,
        name: message.from_name,
      },
      to: parseAddressList(message.to_addresses),
      reply_target:
        message.direction === "inbound"
          ? resolvedReplyTarget(
              message.reply_to_addresses,
              message.from_address,
            )
          : [],
      subject: message.subject,
      text: message.text_body ?? "",
      text_truncated: message.text_truncated,
      attachments: attachmentsByMessage.get(message.id) ?? [],
      created_at: message.created_at,
    })),
    pending_drafts: draftResult.rows.map((draft) => ({
      id: entityId("draft", draft.id),
      text: draft.text_body,
      text_truncated: draft.text_truncated,
      created_by: draft.created_by,
      agent_notes: draft.agent_notes,
      created_at: draft.created_at,
    })),
    ai_drafting: draftRun ?? null,
    messages_truncated: thread.message_count > messageResult.rows.length,
  };
}

function parseAddressList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function resolvedReplyTarget(raw: string, from: string): string[] {
  const replyTo = parseAddressList(raw);
  return replyTo.length > 0 ? replyTo : [from];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export class ConversationInputError extends Error {}

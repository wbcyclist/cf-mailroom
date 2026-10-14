import type { AiSettings } from "./ai-model";

export interface Mailbox {
  id: number;
  address: string;
  color: string;
  agent_mode: "off" | "draft" | "auto";
  agent_instructions: string | null;
  unread_count: number;
  /** True once any inbound message has arrived, i.e. routing is known to work. */
  has_received: boolean;
}

export interface Domain {
  id: number;
  name: string;
  status: "pending" | "active";
  inbox_count: number;
  created_at: string;
  activated_at: string | null;
}

export interface GeneralSettings extends AiSettings {
  browser_notifications_enabled: boolean;
  browser_notifications_configured: boolean;
  push_subscription_count: number;
  vapid_public_key: string | null;
  ai_workers_available: boolean;
  ai_external_available: boolean;
}

export interface BrowserPushSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface Playbook {
  id: number;
  mailbox_id: number;
  name: string;
  when_to_use: string;
  instructions: string;
  example_reply: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface PlaybookInput {
  mailbox_id: number;
  name: string;
  when_to_use: string;
  instructions: string;
  example_reply?: string | null;
  enabled?: boolean;
}

export interface Label {
  id: number;
  mailbox_id: number;
  name: string;
  condition: string;
  created_at: string;
  updated_at: string;
}

export interface LabelInput {
  mailbox_id: number;
  name: string;
  condition: string;
}

export interface ThreadLabel {
  id: number;
  name: string;
}

export interface ThreadSummary {
  id: number;
  mailbox_id: number;
  mailbox_address: string;
  mailbox_color: string;
  mailbox_agent_mode: Mailbox["agent_mode"];
  subject: string;
  snippet: string;
  status: "open" | "archived" | "needs_human";
  is_read: number;
  message_count: number;
  pending_draft_count: number;
  draft_run_status: DraftRunStatus | null;
  draft_run_error: string | null;
  latest_inbound_is_auto_submitted: number;
  last_message_direction: "inbound" | "outbound";
  last_message_at: string;
  last_from: string | null;
  last_from_address: string | null;
  labels: ThreadLabel[];
}

export interface Attachment {
  id: number;
  message_id: number;
  filename: string | null;
  content_type: string;
  size: number;
  disposition: "attachment" | "inline" | null;
  content_id: string | null;
}

export interface Message {
  id: number;
  thread_id: number;
  direction: "inbound" | "outbound";
  sent_by: "external" | "human" | "agent";
  from_address: string;
  from_name: string | null;
  to_addresses: string;
  reply_to_addresses: string;
  subject: string;
  text_body: string | null;
  html_body: string | null;
  is_auto_submitted: number;
  created_at: string;
  attachments: Attachment[];
}

export interface Draft {
  id: number;
  thread_id: number;
  text_body: string;
  created_by: "human" | "agent";
  agent_notes: string | null;
  playbook_id: number | null;
  playbook_name: string | null;
  status: "pending" | "sent" | "discarded";
  created_at: string;
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: Message[];
  drafts: Draft[];
  draft_run: DraftRun | null;
}

export type DraftRunStatus = "queued" | "generating" | "ready" | "failed" | "superseded";

export interface DraftRun {
  id: number;
  thread_id: number;
  inbound_message_id: number;
  status: DraftRunStatus;
  attempt_count: number;
  draft_id: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export type ReplyAttemptStatus = "pending" | "sending" | "sent" | "failed";

export interface ReplyAttemptResult {
  ok: boolean;
  attempt_id: string;
  status: ReplyAttemptStatus;
  message_id: string | null;
  error?: string;
}

export interface ComposeAttemptResult extends ReplyAttemptResult {
  conversation_id: number | null;
}

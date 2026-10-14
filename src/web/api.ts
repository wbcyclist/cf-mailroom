import type { AiSettings } from "../shared/ai-model";

import type {
  BrowserPushSubscription,
  ComposeAttemptResult,
  Domain,
  Draft,
  GeneralSettings,
  Label,
  LabelInput,
  Mailbox,
  Playbook,
  PlaybookInput,
  ReplyAttemptResult,
  ReplyTarget,
  ThreadSummary,
  ThreadDetail,
} from "../shared/types";

export interface AccessHint {
  team_domain: string;
  aud: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly hint?: AccessHint,
  ) {
    super(message);
  }
}

const ACCESS_SETUP_CODES = ["access_not_configured", "access_missing", "access_invalid"];

/** The API rejected the request because Cloudflare Access is not set up correctly. */
export function accessSetupError(error: unknown): ApiError | null {
  return error instanceof ApiError && error.code && ACCESS_SETUP_CODES.includes(error.code)
    ? error
    : null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let body: { error?: string; code?: string; hint?: AccessHint } = {};
    try {
      body = await res.json();
      if (body.error) message = body.error;
    } catch {
      // Keep the status-based fallback for non-JSON responses.
    }
    throw new ApiError(message, res.status, body.code, body.hint);
  }
  return res.json() as Promise<T>;
}

export const fetchMailboxes = () => request<Mailbox[]>("/mailboxes");

export class ComposeRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function composeEmail(input: {
  mailboxId: number;
  to: string;
  subject: string;
  text: string;
  files: File[];
  attemptId: string;
}): Promise<ComposeAttemptResult> {
  const form = new FormData();
  form.set("mailbox_id", String(input.mailboxId));
  form.set("to", input.to);
  form.set("subject", input.subject);
  form.set("text", input.text);
  form.set("attempt_id", input.attemptId);
  for (const file of input.files) form.append("attachments", file, file.name);
  const response = await fetch("/api/compose", { method: "POST", body: form });
  const body = await response.json() as ComposeAttemptResult & { error?: string };
  // Provider failures are terminal send results, distinct from an uncertain
  // network/server failure where the same attempt must be checked again.
  if (["sent", "failed", "pending", "sending"].includes(body.status)) return body;
  throw new ComposeRequestError(body.error ?? `Could not send (${response.status})`, response.status);
}

export const fetchGeneralSettings = () =>
  request<GeneralSettings>("/settings/general");

export const updateAiSettings = (settings: AiSettings) =>
  request<{ ok: true } & AiSettings>("/settings/general", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });

export const enableBrowserNotifications = (subscription: BrowserPushSubscription) =>
  request<{ ok: true }>("/settings/browser-notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription),
  });

export const disableBrowserNotifications = () =>
  request<{ ok: true }>("/settings/browser-notifications", { method: "DELETE" });

export const fetchDomains = () => request<Domain[]>("/domains");

export const createDomain = (input: { name: string }) =>
  request<Domain>("/domains", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const activateDomain = (id: number) =>
  request<Domain>(`/domains/${id}/activate`, { method: "POST" });

export const createMailbox = (input: { local_part: string; domain_id: number }) =>
  request<Mailbox>("/mailboxes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const updateMailbox = (
  id: number,
  input: Partial<Pick<Mailbox, "agent_mode" | "agent_instructions">>,
) =>
  request<{ ok: true }>(`/mailboxes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const deleteMailbox = (id: number, confirmAddress: string) =>
  request<{ ok: true; deleted_id: number; domain_id: number | null }>(`/mailboxes/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm_address: confirmAddress }),
  });

export const fetchPlaybooks = (mailboxId: number) =>
  request<Playbook[]>(`/playbooks?mailbox_id=${mailboxId}`);

export const createPlaybook = (input: PlaybookInput) =>
  request<Playbook>("/playbooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const updatePlaybook = (id: number, input: Partial<PlaybookInput>) =>
  request<Playbook>(`/playbooks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const deletePlaybook = (id: number) =>
  request<{ ok: true }>(`/playbooks/${id}`, { method: "DELETE" });

export const fetchLabels = (mailboxId?: number | null) =>
  request<Label[]>(`/labels${mailboxId ? `?mailbox_id=${mailboxId}` : ""}`);

export const createLabel = (input: LabelInput) =>
  request<Label>("/labels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const updateLabel = (id: number, input: Partial<LabelInput>) =>
  request<Label>(`/labels/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

export const deleteLabel = (id: number) =>
  request<{ ok: true }>(`/labels/${id}`, { method: "DELETE" });

export const THREAD_PAGE_SIZE = 50;

export interface ThreadQuery {
  mailboxId: number | null;
  labelId: number | null;
  status: ThreadSummary["status"];
  unread: boolean;
}

export interface ThreadCursor {
  at: string;
  id: number;
}

function threadScopeParams(query: Omit<ThreadQuery, "status">) {
  const params = new URLSearchParams();
  if (query.mailboxId !== null) params.set("mailbox_id", String(query.mailboxId));
  if (query.labelId !== null) params.set("label_id", String(query.labelId));
  if (query.unread) params.set("unread", "1");
  return params;
}

export const fetchThreads = (query: ThreadQuery, cursor: ThreadCursor | null = null) => {
  const params = threadScopeParams(query);
  if (query.status !== "open") params.set("status", query.status);
  if (cursor) {
    params.set("before_at", cursor.at);
    params.set("before_id", String(cursor.id));
  }
  const search = params.toString();
  return request<ThreadSummary[]>(`/threads${search ? `?${search}` : ""}`);
};

export const fetchThread = (id: number, before: number | null = null) =>
  request<ThreadDetail>(`/threads/${id}${before === null ? "" : `?before=${before}`}`);

export const fetchMessageBody = (id: number) =>
  request<{ text_body: string | null; html_body: string | null; truncated: boolean; downloadable: boolean }>(`/messages/${id}/body`);

export const searchThreads = (q: string, query: Omit<ThreadQuery, "status">) => {
  const params = threadScopeParams(query);
  params.set("q", q);
  return request<ThreadSummary[]>(`/search?${params}`);
};

export type BulkThreadAction = "read" | "unread" | "archive" | "unarchive";

const pendingReadRequests = new Map<number, Promise<unknown>>();

export const bulkUpdateThreads = async (ids: number[], action: BulkThreadAction) => {
  // Finish automatic reads first so a late response cannot undo an explicit unread action.
  if (action === "unread") {
    await Promise.allSettled(ids.map((id) => pendingReadRequests.get(id)));
  }
  return request<{ ok: true; updated: number }>("/threads/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, action }),
  });
};

export const markRead = (id: number) => {
  const pending = pendingReadRequests.get(id);
  if (pending) return pending;
  const result = request(`/threads/${id}/read`, { method: "POST" })
    .finally(() => pendingReadRequests.delete(id));
  pendingReadRequests.set(id, result);
  return result;
};

export const archiveThread = (id: number) => request(`/threads/${id}/archive`, { method: "POST" });

export const unarchiveThread = (id: number) =>
  request(`/threads/${id}/unarchive`, { method: "POST" });

export const sendReply = (
  id: number,
  text: string,
  attemptId: string,
  target: ReplyTarget,
  draftId?: number,
  attachments: File[] = [],
) => {
  const form = new FormData();
  form.set("text", text);
  form.set("attempt_id", attemptId);
  form.set("inbound_message_id", String(target.inbound_message_id));
  form.set("expected_recipients", JSON.stringify(target.expected_recipients));
  if (draftId !== undefined) form.set("draft_id", String(draftId));
  for (const file of attachments) form.append("attachments", file, file.name);
  return request<ReplyAttemptResult>(`/threads/${id}/reply`, {
    method: "POST",
    body: form,
  });
};

export const discardDraft = (id: number) => request(`/drafts/${id}/discard`, { method: "POST" });

export const reviseDraft = (threadId: number, instruction: string, currentText: string) =>
  request<Draft>(`/threads/${threadId}/draft/revise`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction, current_text: currentText }),
  });

import type { DraftRunStatus, Mailbox } from "./types";

export type AgentDraftStatus =
  | "none"
  | "processing"
  | "draft_ready"
  | "failed"
  | "deferred"
  | "skipped"
  | "off"
  | "not_processed"
  | "processed";

export interface AgentDraftStatusInput {
  pendingDraftCount: number;
  runStatus: DraftRunStatus | null;
  agentMode: Mailbox["agent_mode"];
  latestInboundIsAutomated: boolean;
  lastMessageDirection: "inbound" | "outbound";
}

export function deriveAgentDraftStatus(input: AgentDraftStatusInput): AgentDraftStatus {
  if (input.lastMessageDirection !== "inbound") return "none";
  if (input.pendingDraftCount > 0) return "draft_ready";

  if (input.runStatus === "queued" || input.runStatus === "generating") {
    return "processing";
  }
  if (input.runStatus === "deferred") return "deferred";
  if (input.runStatus === "failed") return "failed";
  if (input.runStatus === "superseded") return "skipped";
  if (input.runStatus === "ready") return "processed";

  if (input.latestInboundIsAutomated) return "skipped";
  if (input.agentMode === "off") return "off";
  return "not_processed";
}

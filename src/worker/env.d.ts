interface OutboundEmailBinding {
  send(message: {
    from: string | { email: string; name?: string };
    to: string | Array<string | { email: string; name?: string }>;
    subject: string;
    text?: string;
    html?: string;
    attachments?: Array<{
      content: string | ArrayBuffer | ArrayBufferView;
      filename: string;
      type: string;
      disposition: "attachment" | "inline";
      contentId?: string;
    }>;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

interface WorkerEnv {
  WEB_ACCESS_TEAM_DOMAIN?: string;
  WEB_ACCESS_AUD?: string;
  HYPERDRIVE: Hyperdrive;
  EMAIL: OutboundEmailBinding;
  AI?: Ai;
  AI_API_KEY?: string;
  DRAFT_QUEUE: Queue<{ runId: number; dispatchId: string }>;
  QUEUE_DAILY_OPERATION_LIMIT?: string;
  QUEUE_MONTHLY_OPERATION_LIMIT?: string;
  AI_DAILY_CALL_LIMIT?: string;
  AI_MONTHLY_CALL_LIMIT?: string;
  OAUTH_KV: KVNamespace;
  MCP_RATE_LIMITER?: RateLimit;
  MCP_DAILY_REQUEST_LIMIT?: string;
  MCP_MONTHLY_REQUEST_LIMIT?: string;
  INBOUND_MINUTE_MESSAGE_LIMIT?: string;
  INBOUND_DAILY_MESSAGE_LIMIT?: string;
  INBOUND_DAILY_BYTE_LIMIT?: string;
  MAIL_STORAGE_LIMIT_BYTES?: string;
  MCP_SEND_ENABLED?: string;
  MCP_DAILY_SEND_LIMIT?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT?: string;
}

interface Env extends WorkerEnv {
  DB: import("./database.ts").Database;
}

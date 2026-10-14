CREATE TABLE usage_budgets (
  resource TEXT NOT NULL CHECK (resource IN ('queue', 'ai')),
  period TEXT NOT NULL,
  used BIGINT NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (resource, period)
);

ALTER TABLE draft_runs DROP CONSTRAINT draft_runs_status_check;
ALTER TABLE draft_runs ADD CONSTRAINT draft_runs_status_check
  CHECK (status IN ('queued', 'generating', 'ready', 'failed', 'superseded', 'deferred'));
ALTER TABLE draft_runs ADD COLUMN retry_after TIMESTAMPTZ,
  ADD COLUMN dispatch_id TEXT,
  ADD COLUMN queued_at TIMESTAMPTZ;
CREATE INDEX idx_draft_runs_deferred ON draft_runs(retry_after) WHERE status = 'deferred';

-- Inbound delivery already serializes on the destination inbox. The same RFC
-- message can legitimately be delivered to several inboxes or sent to oneself.
ALTER TABLE messages DROP CONSTRAINT messages_message_id_key;
ALTER TABLE messages ADD CONSTRAINT messages_thread_rfc_id_key UNIQUE (thread_id, message_id);
CREATE INDEX idx_messages_rfc_id ON messages(message_id);

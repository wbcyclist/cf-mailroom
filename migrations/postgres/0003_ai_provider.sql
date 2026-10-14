ALTER TABLE global_settings
  ADD COLUMN ai_provider TEXT NOT NULL DEFAULT 'disabled'
    CHECK (ai_provider IN ('disabled', 'workers-ai', 'openai-compatible', 'openai-responses')),
  ADD COLUMN ai_base_url TEXT;

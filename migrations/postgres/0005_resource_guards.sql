ALTER TABLE usage_budgets DROP CONSTRAINT usage_budgets_resource_check;
ALTER TABLE usage_budgets ADD CONSTRAINT usage_budgets_resource_check
  CHECK (resource IN ('queue', 'ai', 'mcp'));

CREATE TABLE inbound_usage (
  period TEXT PRIMARY KEY,
  message_count BIGINT NOT NULL CHECK (message_count >= 0),
  raw_bytes BIGINT NOT NULL CHECK (raw_bytes >= 0)
);

-- Logical payload bytes, including MIME, decoded bodies, and attachment content.
-- Physical PostgreSQL space also includes indexes, row metadata, WAL, and backups.
CREATE TABLE mail_storage_usage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  used_bytes BIGINT NOT NULL CHECK (used_bytes >= 0)
);
INSERT INTO mail_storage_usage (id, used_bytes)
SELECT 1,
  COALESCE((SELECT sum(octet_length(content)) FROM stored_files), 0) +
  COALESCE((SELECT sum(octet_length(COALESCE(text_body, '')) + octet_length(COALESCE(html_body, ''))) FROM messages), 0);

CREATE FUNCTION track_mail_storage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_bytes BIGINT := 0;
  next_bytes BIGINT := 0;
BEGIN
  IF TG_TABLE_NAME = 'stored_files' THEN
    IF TG_OP <> 'INSERT' THEN previous_bytes := octet_length(OLD.content); END IF;
    IF TG_OP <> 'DELETE' THEN next_bytes := octet_length(NEW.content); END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN
      previous_bytes := octet_length(COALESCE(OLD.text_body, '')) + octet_length(COALESCE(OLD.html_body, ''));
    END IF;
    IF TG_OP <> 'DELETE' THEN
      next_bytes := octet_length(COALESCE(NEW.text_body, '')) + octet_length(COALESCE(NEW.html_body, ''));
    END IF;
  END IF;
  UPDATE mail_storage_usage SET used_bytes = used_bytes + next_bytes - previous_bytes WHERE id = 1;
  RETURN NULL;
END;
$$;

CREATE TRIGGER stored_files_storage AFTER INSERT OR UPDATE OR DELETE ON stored_files
  FOR EACH ROW EXECUTE FUNCTION track_mail_storage();
CREATE TRIGGER messages_storage AFTER INSERT OR UPDATE OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION track_mail_storage();

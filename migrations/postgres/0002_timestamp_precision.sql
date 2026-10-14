-- JSON cursors use millisecond ISO timestamps. Store the same precision so a
-- cursor cannot skip rows that differ only by sub-millisecond precision.
DO $$
DECLARE column_record RECORD;
BEGIN
  FOR column_record IN
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND data_type = 'timestamp with time zone'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ(3)',
      column_record.table_name, column_record.column_name);
  END LOOP;
END $$;

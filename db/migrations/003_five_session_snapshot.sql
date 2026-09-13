-- Keep the deployed physical table name as a temporary cross-version compatibility
-- boundary. Both the old three-session runtime and the new five-session runtime can
-- read and write this unconstrained row store while deployments overlap.

ALTER INDEX IF EXISTS three_session_snapshot_latest_idx
  RENAME TO five_session_snapshot_latest_idx;

DO $migration$
DECLARE
  constraint_name TEXT;
BEGIN
  FOREACH constraint_name IN ARRAY ARRAY[
    'market_check', 'symbol_check', 'session_date_check',
    'as_of_check', 'prices_check', 'volume_check'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'three_session_snapshot_' || constraint_name
        AND conrelid = 'three_session_snapshot_sessions'::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE three_session_snapshot_sessions RENAME CONSTRAINT %I TO %I',
        'three_session_snapshot_' || constraint_name,
        'five_session_snapshot_' || constraint_name
      );
    END IF;
  END LOOP;
END
$migration$;

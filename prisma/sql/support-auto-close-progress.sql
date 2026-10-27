-- Operator-applied additive rollout; apply before deploying auto-close readers.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "SupportCase" ADD COLUMN IF NOT EXISTS "autoCloseLastAttemptAt" TIMESTAMPTZ;
COMMIT;

-- Run outside a transaction; check pg_index.indisvalid before deploying.
SET lock_timeout = '5s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SupportCase_status_autoCloseLastAttemptAt_resolvedAt_id_idx"
  ON "SupportCase" (status, "autoCloseLastAttemptAt", "resolvedAt", id);
DO $gate$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('"SupportCase_status_autoCloseLastAttemptAt_resolvedAt_id_idx"')
      AND indrelid = '"SupportCase"'::regclass
      AND indisvalid AND indisready
  ) THEN
    RAISE EXCEPTION 'Auto-close progress index is invalid; drop the invalid index concurrently outside a transaction and rerun this file';
  END IF;
END;
$gate$;
RESET lock_timeout;

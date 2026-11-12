-- btree_gist backs the exclusion constraints and lives in the extensions schema, never in public.
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE SCHEMA IF NOT EXISTS extensions;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'btree_gist' AND n.nspname <> 'extensions'
  ) THEN
    ALTER EXTENSION btree_gist SET SCHEMA extensions;
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

COMMIT;

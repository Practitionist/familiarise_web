-- Backfill legacy Supabase export URLs into exact object owners before deploying
-- the reader/worker that no longer consults OrgDataExportJob.fileUrl.
-- Apply only after the additive OrgDataExportArtifact table exists and the
-- export worker is quiesced. Verify the reviewed project origin below against
-- the deployment before applying; bucket/path come from each exact old URL.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL TIME ZONE 'UTC';

LOCK TABLE "OrgDataExportJob" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  legacy RECORD;
  parts TEXT[];
  expected_origin CONSTANT TEXT := 'https://pzmbxqdgibfkhjwzeprf.supabase.co';
  expected_path TEXT;
  attempt_token TIMESTAMPTZ;
  artifact_expiry TIMESTAMPTZ;
BEGIN
  FOR legacy IN
    SELECT
      "id",
      "organizationId",
      "fileUrl",
      "fileSizeBytes",
      "expiresAt",
      "startedAt",
      "completedAt",
      "createdAt"
    FROM "OrgDataExportJob"
    WHERE "fileUrl" IS NOT NULL
    ORDER BY "id"
    FOR UPDATE
  LOOP
    parts := regexp_match(
      legacy."fileUrl",
      '^https?://[^/]+/storage/v1/object/sign/([^/?#]+)/([^?#]+)([?].*)?$'
    );
    expected_path := legacy."organizationId" || '/' || legacy."id" || '.json';

    IF parts IS NULL
      OR split_part(legacy."fileUrl", '/storage/v1/object/sign/', 1) <> expected_origin
      OR parts[1] = ''
      OR parts[2] <> expected_path
    THEN
      RAISE EXCEPTION
        'Unrecognized legacy data-export storage URL for job %; inspect its exact bucket/path before continuing',
        legacy."id";
    END IF;

    attempt_token := COALESCE(
      legacy."startedAt",
      legacy."completedAt",
      legacy."createdAt"
    );
    artifact_expiry := COALESCE(
      legacy."expiresAt",
      legacy."completedAt" + INTERVAL '7 days',
      legacy."createdAt" + INTERVAL '7 days'
    );

    INSERT INTO "OrgDataExportArtifact" (
      "exportJobId",
      "attemptStartedAt",
      "bucket",
      "storagePath",
      "expiresAt",
      "createdAt",
      "fileSizeBytes"
    ) VALUES (
      legacy."id",
      attempt_token,
      parts[1],
      parts[2],
      artifact_expiry,
      legacy."createdAt",
      legacy."fileSizeBytes"
    )
    ON CONFLICT DO NOTHING;

    IF NOT EXISTS (
      SELECT 1
      FROM "OrgDataExportArtifact" owner
      WHERE owner."exportJobId" = legacy."id"
        AND owner."attemptStartedAt" = attempt_token
        AND owner."bucket" = parts[1]
        AND owner."storagePath" = parts[2]
    ) THEN
      RAISE EXCEPTION
        'Conflicting export artifact owner for legacy job %; inspect before continuing',
        legacy."id";
    END IF;

    UPDATE "OrgDataExportJob"
    SET "startedAt" = COALESCE("startedAt", attempt_token),
        "fileUrl" = NULL
    WHERE "id" = legacy."id"
      AND "fileUrl" = legacy."fileUrl";
  END LOOP;
END $$;

COMMIT;

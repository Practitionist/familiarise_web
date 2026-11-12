-- Export artifact rows are reachable only through the server-side database role.
BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE "OrgDataExportArtifact" ENABLE ROW LEVEL SECURITY;

COMMIT;

-- Operator-reviewed additive rollout; generate from the PR base and read back the catalog.
-- Do not run a whole-database schema diff or apply unrelated drift.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- CreateTable
CREATE TABLE "OrgDataExportArtifact" (
    "exportJobId" TEXT NOT NULL,
    "attemptStartedAt" TIMESTAMPTZ(3) NOT NULL,
    "bucket" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDeleteAttemptedAt" TIMESTAMPTZ(3),
    "fileSizeBytes" BIGINT,

    CONSTRAINT "OrgDataExportArtifact_pkey" PRIMARY KEY ("exportJobId","attemptStartedAt")
);

-- CreateIndex
CREATE INDEX "OrgDataExportArtifact_lastDeleteAttemptedAt_expiresAt_creat_idx" ON "OrgDataExportArtifact"("lastDeleteAttemptedAt", "expiresAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrgDataExportArtifact_bucket_storagePath_key" ON "OrgDataExportArtifact"("bucket", "storagePath");

-- Object ownership is available only to the server-side database role.
ALTER TABLE "OrgDataExportArtifact" ENABLE ROW LEVEL SECURITY;

COMMIT;

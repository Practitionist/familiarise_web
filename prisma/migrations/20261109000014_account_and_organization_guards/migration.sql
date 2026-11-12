-- Invitations, domain claims, SSO ids, erasure requests, ops proposals and org settings.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- At most one pending invite per organisation and case-folded email.
DROP INDEX IF EXISTS "invitations_org_email_pending_key";
CREATE UNIQUE INDEX "invitations_org_email_pending_key"
  ON "invitations" ("organizationId", lower("email"))
  WHERE "status" = 'PENDING';

-- At most one active erasure request per user.
DROP INDEX IF EXISTS "erasure_request_active_user_key";
CREATE UNIQUE INDEX "erasure_request_active_user_key"
  ON "ErasureRequest" ("userId")
  WHERE "status" IN ('PENDING', 'IN_PROGRESS');

-- Backstop on the stored onboarding draft size; the writer enforces the product limit.
ALTER TABLE "onboarding_drafts" DROP CONSTRAINT IF EXISTS "onboarding_draft_payload_size";
ALTER TABLE "onboarding_drafts" ADD CONSTRAINT "onboarding_draft_payload_size"
  CHECK (pg_column_size("payload") <= 65536);

-- An SSO provider id never shadows a sign-in method; keep in sync with RESERVED_PROVIDER_IDS.
ALTER TABLE "ssoProvider" DROP CONSTRAINT IF EXISTS "sso_provider_id_not_reserved";
ALTER TABLE "ssoProvider" ADD CONSTRAINT "sso_provider_id_not_reserved"
  CHECK (lower(btrim("providerId")) NOT IN ('credential', 'facebook', 'github', 'google', 'sso'));

-- Multiple organizations may register an unverified claim for the same domain,
-- but at most one organization can hold a verified claim on a domain at a time.
DROP INDEX IF EXISTS "org_domain_claims_verified_domain_key";
CREATE UNIQUE INDEX IF NOT EXISTS "org_domain_claims_verified_domain_key"
  ON "org_domain_claims" ("domain")
  WHERE "verifiedAt" IS NOT NULL;

-- Org recording-retention cap: NULL follows the platform schedule; a set cap stays inside the PATCH route's 7..3650 range.
ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS "org_stream_recording_retention_days_range";
ALTER TABLE "organizations" ADD CONSTRAINT "org_stream_recording_retention_days_range"
  CHECK ("streamRecordingRetentionDays" IS NULL OR "streamRecordingRetentionDays" BETWEEN 7 AND 3650);

-- One open second-approval proposal per (action, target); decided rows keep theirs.
CREATE UNIQUE INDEX IF NOT EXISTS "ops_action_proposal_one_open_key"
  ON "ops_action_proposals" ("action", "targetKind", "targetId")
  WHERE "status" = 'PROPOSED';

COMMIT;

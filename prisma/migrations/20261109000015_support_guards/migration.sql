-- Support case shape, open-case uniqueness, immutable decisions and the chat-access log.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- Open cases deduplicate within their ownership, organization, subject and submitting party.
DROP INDEX IF EXISTS "support_case_open_scope_key";
CREATE UNIQUE INDEX IF NOT EXISTS "support_case_open_scope_key"
  ON "SupportCase" ("ownershipScope", "organizationId", "scopeKey", "requesterUserId", "submitterUserId", "category")
  NULLS NOT DISTINCT
  WHERE "closedAt" IS NULL AND "deletedAt" IS NULL;

-- At most one primary subject row per SupportCase.
DROP INDEX IF EXISTS "support_case_subject_primary_key";
CREATE UNIQUE INDEX IF NOT EXISTS "support_case_subject_primary_key"
  ON "SupportCaseSubject" ("caseId")
  WHERE "isPrimary" = true;

-- A SupportCase must carry at least a category or a flowKey, an occurrence requires an appointment,
-- problem links remain strictly one level deep, and CSAT scores stay between 1 and 5.
ALTER TABLE "SupportCase" DROP CONSTRAINT IF EXISTS "support_case_scope_and_shape_chk";
ALTER TABLE "SupportCase" ADD CONSTRAINT "support_case_scope_and_shape_chk"
  CHECK (
    ("category" IS NOT NULL OR "flowKey" IS NOT NULL)
    AND ("appointmentOccurrenceId" IS NULL OR "appointmentId" IS NOT NULL)
    AND ("problemCaseId" IS NULL OR "caseKind" = 'INCIDENT')
    AND ("csatRating" IS NULL OR ("csatRating" BETWEEN 1 AND 5))
  );

-- A session-count remedy removes at least one session.
ALTER TABLE "SupportFinancialRecommendation" DROP CONSTRAINT IF EXISTS "support_recommendation_sessions_removed_min";
ALTER TABLE "SupportFinancialRecommendation" ADD CONSTRAINT "support_recommendation_sessions_removed_min"
  CHECK ("sessionsRemoved" IS NULL OR "sessionsRemoved" >= 1);

ALTER TABLE "SupportCase" DROP CONSTRAINT IF EXISTS "support_case_ownership_and_appeal_shape";
ALTER TABLE "SupportCase" ADD CONSTRAINT "support_case_ownership_and_appeal_shape"
  CHECK (("ownershipScope" = 'PERSONAL' OR "organizationId" IS NOT NULL)
    AND num_nonnulls("appealOfDecisionId", "appealOfModerationActionId") <= 1);

ALTER TABLE "SupportCaseAttachment" DROP CONSTRAINT IF EXISTS "support_case_attachment_shape";
ALTER TABLE "SupportCaseAttachment" ADD CONSTRAINT "support_case_attachment_shape"
  CHECK (num_nonnulls("messageId", "evidenceRequestId") <= 1 AND "fileSize" >= 0);

ALTER TABLE "SupportFinancialRecommendation" DROP CONSTRAINT IF EXISTS "support_recommendation_shape";
ALTER TABLE "SupportFinancialRecommendation" ADD CONSTRAINT "support_recommendation_shape"
  CHECK ("amountPaise" >= 0 AND (("decidedAt" IS NULL AND "approved" IS NULL AND "decidedById" IS NULL)
    OR ("decidedAt" IS NOT NULL AND "approved" IS NOT NULL AND "decidedById" IS NOT NULL))
    AND (("voidedAt" IS NULL AND "voidedById" IS NULL)
      OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND NOT "approved")));

-- One undecided support refund recommendation per payment.
CREATE UNIQUE INDEX IF NOT EXISTS "support_recommendation_one_open_per_payment"
  ON "SupportFinancialRecommendation" ("paymentId") WHERE "decidedAt" IS NULL;

CREATE OR REPLACE FUNCTION assert_support_decision_immutable() RETURNS trigger
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Case decisions are immutable; append a new decision instead';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS support_case_decision_immutable ON "SupportCaseDecision";
CREATE TRIGGER support_case_decision_immutable
  BEFORE UPDATE OR DELETE ON "SupportCaseDecision"
  FOR EACH ROW EXECUTE FUNCTION assert_support_decision_immutable();

-- One original decision per case; every later decision supersedes exactly one other.
CREATE UNIQUE INDEX IF NOT EXISTS "support_decision_one_original_per_case"
  ON "SupportCaseDecision" ("caseId") WHERE "supersedesDecisionId" IS NULL;

-- Keeps the post-closure evidence purge scan cheap as closed cases accumulate.
CREATE INDEX IF NOT EXISTS "support_case_closed_at_idx"
  ON "SupportCase" ("closedAt") WHERE "closedAt" IS NOT NULL;

ALTER TABLE "SupportCaseChatAccess" DROP CONSTRAINT IF EXISTS "support_chat_access_shape";
-- An ended grant names why; only an intervention touches Stream membership; OPEN_CASE never justifies an intervention.
ALTER TABLE "SupportCaseChatAccess" ADD CONSTRAINT "support_chat_access_shape"
  CHECK (("endedAt" IS NULL) = ("endReason" IS NULL)
    AND "expiresAt" > "createdAt"
    AND cardinality("scopeUserIds") >= 1
    AND ("kind" = 'INTERVENE' OR ("streamJoinedAt" IS NULL AND "streamLeftAt" IS NULL))
    AND ("streamLeftAt" IS NULL OR ("streamJoinedAt" IS NOT NULL AND "streamLeftAt" >= "streamJoinedAt"))
    AND ("reviewNoticeAt" IS NULL OR "endedAt" IS NOT NULL)
    AND ("kind" = 'READ' OR "basis" <> 'OPEN_CASE'));

-- One Familiarise Support seat per channel across all cases.
CREATE UNIQUE INDEX IF NOT EXISTS "support_chat_one_live_intervention_per_channel"
  ON "SupportCaseChatAccess" ("channelType", "channelId") WHERE "kind" = 'INTERVENE' AND "endedAt" IS NULL;

-- One live read grant per operator per case.
CREATE UNIQUE INDEX IF NOT EXISTS "support_chat_one_live_read_per_operator"
  ON "SupportCaseChatAccess" ("caseId", "grantedById") WHERE "kind" = 'READ' AND "endedAt" IS NULL;

-- Keeps the SLA-sweep expiry, Stream-leave and review-notice scans cheap.
CREATE INDEX IF NOT EXISTS "support_chat_access_live_expiry_idx"
  ON "SupportCaseChatAccess" ("expiresAt") WHERE "endedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "support_chat_access_pending_leave_idx"
  ON "SupportCaseChatAccess" ("endedAt")
  WHERE "kind" = 'INTERVENE' AND "streamJoinedAt" IS NOT NULL AND "streamLeftAt" IS NULL;

CREATE INDEX IF NOT EXISTS "support_chat_access_pending_notice_idx"
  ON "SupportCaseChatAccess" ("caseId") WHERE "endedAt" IS NOT NULL AND "reviewNoticeAt" IS NULL;

-- The access log is append-only: only the end, Stream and notice stamps may be set, once each.
CREATE OR REPLACE FUNCTION assert_support_chat_access_append_only() RETURNS trigger
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Chat access grants are an access log and cannot be deleted'; END IF;
  IF (NEW."caseId", NEW."kind", NEW."basis", NEW."grantedById", NEW."opsActionId", NEW."channelType", NEW."channelId",
      NEW."scopeUserIds", NEW."windowStart", NEW."organizationIds", NEW."withholdNotice", NEW."expiresAt", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."caseId", OLD."kind", OLD."basis", OLD."grantedById", OLD."opsActionId", OLD."channelType", OLD."channelId",
      OLD."scopeUserIds", OLD."windowStart", OLD."organizationIds", OLD."withholdNotice", OLD."expiresAt", OLD."createdAt")
     OR (OLD."endedAt" IS NOT NULL AND (NEW."endedAt", NEW."endedById", NEW."endReason")
       IS DISTINCT FROM (OLD."endedAt", OLD."endedById", OLD."endReason"))
     OR (OLD."streamJoinedAt" IS NOT NULL AND NEW."streamJoinedAt" IS DISTINCT FROM OLD."streamJoinedAt")
     OR (OLD."streamLeftAt" IS NOT NULL AND NEW."streamLeftAt" IS DISTINCT FROM OLD."streamLeftAt")
     OR (OLD."reviewNoticeAt" IS NOT NULL AND NEW."reviewNoticeAt" IS DISTINCT FROM OLD."reviewNoticeAt") THEN
    RAISE EXCEPTION 'Chat access grants only gain end, Stream and notice stamps';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS support_chat_access_append_only ON "SupportCaseChatAccess";
CREATE TRIGGER support_chat_access_append_only
  BEFORE UPDATE OR DELETE ON "SupportCaseChatAccess"
  FOR EACH ROW EXECUTE FUNCTION assert_support_chat_access_append_only();

COMMIT;

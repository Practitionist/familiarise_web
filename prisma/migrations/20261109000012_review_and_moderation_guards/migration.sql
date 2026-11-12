-- Review uniqueness, removal pairing, append-only revisions and moderation shape.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- One rating per person per level (one call, or the whole appointment when the occurrence is NULL).
DROP INDEX IF EXISTS "appointment_feedback_level_key";
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_feedback_level_key"
  ON "AppointmentFeedback" ("appointmentId", "appointmentOccurrenceId", "userId") NULLS NOT DISTINCT;

-- One review per consultant, consultee, track and event; NULL event keys compare equal.
DROP INDEX IF EXISTS "consultant_review_pair_track_event_key";
CREATE UNIQUE INDEX IF NOT EXISTS "consultant_review_pair_track_event_key"
  ON "ConsultantReview" ("consultantProfileId", "consulteeProfileId", "track", "ratingUnitId")
  NULLS NOT DISTINCT
  WHERE "track" IS NOT NULL;

-- A removed review or reply always names who removed it.
ALTER TABLE "ConsultantReview" DROP CONSTRAINT IF EXISTS "consultant_review_removed_pair";
ALTER TABLE "ConsultantReview" ADD CONSTRAINT "consultant_review_removed_pair"
  CHECK (("deletedAt" IS NULL) = ("removedBy" IS NULL));

ALTER TABLE "ConsultantReview" DROP CONSTRAINT IF EXISTS "consultant_review_reply_removed_pair";
ALTER TABLE "ConsultantReview" ADD CONSTRAINT "consultant_review_reply_removed_pair"
  CHECK (("replyDeletedAt" IS NULL) = ("replyRemovedBy" IS NULL));

-- A moderation action names the report, review or feedback it is about.
ALTER TABLE "ModerationAction" DROP CONSTRAINT IF EXISTS "moderation_action_has_target";
ALTER TABLE "ModerationAction" ADD CONSTRAINT "moderation_action_has_target"
  CHECK ("reportId" IS NOT NULL OR "reviewId" IS NOT NULL OR "feedbackId" IS NOT NULL);

-- A direct moderation act names the content its type is about.
ALTER TABLE "ModerationAction" DROP CONSTRAINT IF EXISTS "moderation_action_target_matches_type";
ALTER TABLE "ModerationAction" ADD CONSTRAINT "moderation_action_target_matches_type"
  CHECK (
    ("actionType" NOT IN ('REVIEW_REMOVED', 'REVIEW_REPLY_REMOVED', 'REVIEW_EXCLUDED_FROM_AGGREGATE') OR "reviewId" IS NOT NULL)
    AND ("actionType" <> 'FEEDBACK_EXCLUDED_FROM_AGGREGATE' OR "feedbackId" IS NOT NULL)
  );

-- A GROUP review names the event it rates.
ALTER TABLE "ConsultantReview" DROP CONSTRAINT IF EXISTS "consultant_review_group_has_event";
ALTER TABLE "ConsultantReview" ADD CONSTRAINT "consultant_review_group_has_event"
  CHECK ("track" IS DISTINCT FROM 'GROUP' OR "ratingUnitId" IS NOT NULL);

-- A REVIEW report names the review it is about.
ALTER TABLE "ModerationReport" DROP CONSTRAINT IF EXISTS "moderation_report_review_has_review";
ALTER TABLE "ModerationReport" ADD CONSTRAINT "moderation_report_review_has_review"
  CHECK ("type" IS DISTINCT FROM 'REVIEW' OR "reviewId" IS NOT NULL);

-- A review revision never changes, and is deleted only with its parent review.
DROP TRIGGER IF EXISTS review_revision_immutable ON "ConsultantReviewRevision";

CREATE OR REPLACE FUNCTION assert_review_revision_immutable() RETURNS trigger
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'ConsultantReviewRevision % is immutable', OLD."id";
  END IF;
  IF EXISTS (SELECT 1 FROM "ConsultantReview" WHERE "id" = OLD."reviewId") THEN
    RAISE EXCEPTION
      'ConsultantReviewRevision % cannot be deleted while review % exists',
      OLD."id", OLD."reviewId";
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER review_revision_immutable
  BEFORE UPDATE OR DELETE ON "ConsultantReviewRevision"
  FOR EACH ROW
  EXECUTE FUNCTION assert_review_revision_immutable();

CREATE UNIQUE INDEX IF NOT EXISTS "moderation_report_reporter_open_content_key"
  ON "ModerationReport" ("reportedById", "targetUserId", "type", "reviewId", "streamMessageId")
  NULLS NOT DISTINCT
  WHERE "status" IN ('PENDING', 'UNDER_REVIEW', 'ESCALATED');

COMMIT;

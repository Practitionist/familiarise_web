-- A collaborator belongs to one plan, carries a role and tier that fit it, and each plan has one presenter.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- A collaborator belongs to exactly one plan: a webinar or a class.
ALTER TABLE "Collaborator" DROP CONSTRAINT IF EXISTS "collaborator_plan_xor";
ALTER TABLE "Collaborator" ADD CONSTRAINT "collaborator_plan_xor"
  CHECK (
    ("collaboratorType" = 'WEBINAR' AND "webinarPlanId" IS NOT NULL AND "classPlanId" IS NULL)
    OR ("collaboratorType" = 'CLASS' AND "classPlanId" IS NOT NULL AND "webinarPlanId" IS NULL)
  );

-- A collaborator's revenue share lies in 1..9000 bps.
ALTER TABLE "Collaborator" DROP CONSTRAINT IF EXISTS "collaborator_share_bps_in_range";
ALTER TABLE "Collaborator" ADD CONSTRAINT "collaborator_share_bps_in_range"
  CHECK (1 <= "revenueShareBps" AND "revenueShareBps" <= 9000);

ALTER TABLE "Collaborator" DROP CONSTRAINT IF EXISTS "collaborator_role_matches_plan_type";
ALTER TABLE "Collaborator" ADD CONSTRAINT "collaborator_role_matches_plan_type"
  CHECK (
    ("collaboratorType" = 'WEBINAR' AND "role" IN ('CO_HOST', 'MODERATOR', 'GUEST_SPEAKER', 'TECHNICAL_SUPPORT'))
    OR ("collaboratorType" = 'CLASS' AND "role" IN ('CO_INSTRUCTOR', 'TEACHING_ASSISTANT', 'GUEST_LECTURER', 'CONTENT_CREATOR'))
  );

ALTER TABLE "Collaborator" DROP CONSTRAINT IF EXISTS "collaborator_tier_matches_role";
ALTER TABLE "Collaborator" ADD CONSTRAINT "collaborator_tier_matches_role"
  CHECK (
    ("role" IN ('CO_HOST', 'CO_INSTRUCTOR') AND "tier" = 'PRESENTER')
    OR ("role" NOT IN ('CO_HOST', 'CO_INSTRUCTOR') AND "tier" = 'CREW')
  );

-- One live presenter per plan.
DROP INDEX IF EXISTS "collaborator_one_presenter_webinar";
CREATE UNIQUE INDEX IF NOT EXISTS "collaborator_one_presenter_webinar"
  ON "Collaborator" ("webinarPlanId")
  WHERE "tier" = 'PRESENTER' AND "status" IN ('PENDING', 'ACCEPTED');

DROP INDEX IF EXISTS "collaborator_one_presenter_class";
CREATE UNIQUE INDEX IF NOT EXISTS "collaborator_one_presenter_class"
  ON "Collaborator" ("classPlanId")
  WHERE "tier" = 'PRESENTER' AND "status" IN ('PENDING', 'ACCEPTED');

COMMIT;

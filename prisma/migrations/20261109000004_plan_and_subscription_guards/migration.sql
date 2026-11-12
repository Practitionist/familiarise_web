-- Plan pricing, capacity and session-count invariants, plus waitlist and cancellation-policy shape.
BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE "ConsultationPlan" DROP CONSTRAINT IF EXISTS "consultation_plan_price_nonnegative";
ALTER TABLE "ConsultationPlan" ADD CONSTRAINT "consultation_plan_price_nonnegative" CHECK ("price" >= 0);

ALTER TABLE "SubscriptionPlan" DROP CONSTRAINT IF EXISTS "subscription_plan_price_nonnegative";
ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "subscription_plan_price_nonnegative" CHECK ("price" >= 0);

ALTER TABLE "WebinarPlan" DROP CONSTRAINT IF EXISTS "webinar_plan_price_nonnegative";
ALTER TABLE "WebinarPlan" ADD CONSTRAINT "webinar_plan_price_nonnegative" CHECK ("price" >= 0);

ALTER TABLE "ClassPlan" DROP CONSTRAINT IF EXISTS "class_plan_price_nonnegative";
ALTER TABLE "ClassPlan" ADD CONSTRAINT "class_plan_price_nonnegative" CHECK ("price" >= 0);

ALTER TABLE "WebinarPlan" DROP CONSTRAINT IF EXISTS "webinar_plan_max_participants_min";
ALTER TABLE "WebinarPlan" ADD CONSTRAINT "webinar_plan_max_participants_min" CHECK ("maxParticipants" >= 1);

ALTER TABLE "ClassPlan" DROP CONSTRAINT IF EXISTS "class_plan_max_participants_min";
ALTER TABLE "ClassPlan" ADD CONSTRAINT "class_plan_max_participants_min" CHECK ("maxParticipants" >= 1);

-- Per-instance capacity override. NULL means "inherit the plan's value", so
-- the guard has to admit NULL while still rejecting a zero or negative cap.
ALTER TABLE "Webinar" DROP CONSTRAINT IF EXISTS "webinar_max_participants_min";
ALTER TABLE "Webinar" ADD CONSTRAINT "webinar_max_participants_min" CHECK ("maxParticipants" IS NULL OR "maxParticipants" >= 1);

ALTER TABLE "Class" DROP CONSTRAINT IF EXISTS "class_max_participants_min";
ALTER TABLE "Class" ADD CONSTRAINT "class_max_participants_min" CHECK ("maxParticipants" IS NULL OR "maxParticipants" >= 1);

-- Plans sell at least one session.
ALTER TABLE "SubscriptionPlan" DROP CONSTRAINT IF EXISTS "subscription_plan_total_sessions_min";
ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "subscription_plan_total_sessions_min"
  CHECK ("totalSessions" >= 1);

ALTER TABLE "ClassPlan" DROP CONSTRAINT IF EXISTS "class_plan_total_sessions_min";
ALTER TABLE "ClassPlan" ADD CONSTRAINT "class_plan_total_sessions_min"
  CHECK ("totalSessions" >= 1);

-- One ACTIVE cancellation policy per scope; the platform scope (NULL org) counts as one.
DROP INDEX IF EXISTS "cancellation_policy_one_active_per_scope";
CREATE UNIQUE INDEX IF NOT EXISTS "cancellation_policy_one_active_per_scope"
  ON "CancellationPolicy" ("organizationId") NULLS NOT DISTINCT
  WHERE "status" = 'ACTIVE';

DROP INDEX IF EXISTS "cancellation_policy_scope_version";
CREATE UNIQUE INDEX IF NOT EXISTS "cancellation_policy_scope_version"
  ON "CancellationPolicy" ("organizationId", "version") NULLS NOT DISTINCT;

-- A subscription returns at most two sessions to its plan.
ALTER TABLE "Subscription" DROP CONSTRAINT IF EXISTS "subscription_sessions_returned_range";
ALTER TABLE "Subscription" ADD CONSTRAINT "subscription_sessions_returned_range"
  CHECK ("sessionsReturned" BETWEEN 0 AND 2);

-- A weeks plan runs 1..52 weeks; null keeps the months length.
ALTER TABLE "SubscriptionPlan" DROP CONSTRAINT IF EXISTS "subscription_plan_weeks_range";
ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "subscription_plan_weeks_range"
  CHECK ("durationInWeeks" IS NULL OR "durationInWeeks" BETWEEN 1 AND 52);

-- A support partial refund removes at most the sessions the plan sold.
ALTER TABLE "Subscription" DROP CONSTRAINT IF EXISTS "subscription_sessions_refunded_range";
ALTER TABLE "Subscription" ADD CONSTRAINT "subscription_sessions_refunded_range"
  CHECK ("sessionsRefunded" >= 0
    AND ("sessionsTotal" IS NULL OR "sessionsRefunded" <= "sessionsTotal"));

-- Frozen purchase terms are positive when stamped.
ALTER TABLE "Subscription" DROP CONSTRAINT IF EXISTS "subscription_frozen_terms_positive";
ALTER TABLE "Subscription" ADD CONSTRAINT "subscription_frozen_terms_positive"
  CHECK (("sessionsPerWeek" IS NULL OR "sessionsPerWeek" >= 1)
    AND ("sessionMinutes" IS NULL OR "sessionMinutes" >= 1));

-- A Regular-time slot is an ISO weekday and a minute of the local day.
ALTER TABLE "RegularTime" DROP CONSTRAINT IF EXISTS "regular_time_ranges";
ALTER TABLE "RegularTime" ADD CONSTRAINT "regular_time_ranges"
  CHECK ("weekday" BETWEEN 1 AND 7 AND "localStartMinutes" BETWEEN 0 AND 1439);

-- One live row per plan slot; superseded rows keep their validUntil as history.
DROP INDEX IF EXISTS "regular_time_one_live_slot";
CREATE UNIQUE INDEX IF NOT EXISTS "regular_time_one_live_slot"
  ON "RegularTime" ("subscriptionId", "weekday", "localStartMinutes")
  WHERE "validUntil" IS NULL;

-- An open plan-end choice has no decision; every other status has one.
ALTER TABLE "PlanEndChoice" DROP CONSTRAINT IF EXISTS "plan_end_choice_shape";
ALTER TABLE "PlanEndChoice" ADD CONSTRAINT "plan_end_choice_shape"
  CHECK (("status" = 'OFFERED' AND "decidedAt" IS NULL)
    OR ("status" <> 'OFFERED' AND "decidedAt" IS NOT NULL));

-- An extension adds 1..4 weeks and remembers the plan end it replaced.
ALTER TABLE "PlanEndChoice" DROP CONSTRAINT IF EXISTS "plan_end_choice_extended";
ALTER TABLE "PlanEndChoice" ADD CONSTRAINT "plan_end_choice_extended"
  CHECK ("status" NOT IN ('EXTENDED', 'EXPERT_DECLINED')
    OR ("extraWeeksOffered" IS NOT NULL
      AND "extraWeeksOffered" BETWEEN 1 AND 4
      AND "previousPlanEndsAt" IS NOT NULL));

-- Notify-me rows exist only for group events; NOTIFIED and BOOKED carry their timestamps.
ALTER TABLE "AppointmentWaitlist" DROP CONSTRAINT IF EXISTS "appointment_waitlist_plan_kind_chk";
ALTER TABLE "AppointmentWaitlist" ADD CONSTRAINT "appointment_waitlist_plan_kind_chk"
  CHECK ("planKind" IN ('WEBINAR', 'CLASS'));

ALTER TABLE "AppointmentWaitlist" DROP CONSTRAINT IF EXISTS "appointment_waitlist_notified_at_chk";
ALTER TABLE "AppointmentWaitlist" ADD CONSTRAINT "appointment_waitlist_notified_at_chk"
  CHECK ("status" <> 'NOTIFIED' OR "notifiedAt" IS NOT NULL);

ALTER TABLE "AppointmentWaitlist" DROP CONSTRAINT IF EXISTS "appointment_waitlist_booked_at_chk";
ALTER TABLE "AppointmentWaitlist" ADD CONSTRAINT "appointment_waitlist_booked_at_chk"
  CHECK ("status" <> 'BOOKED' OR "bookedAt" IS NOT NULL);

-- NULL means the 200-seat ceiling; the upper bound is enforced in Zod like maxParticipants.
ALTER TABLE "WebinarPlan" DROP CONSTRAINT IF EXISTS "webinar_plan_waitlist_max_min";
ALTER TABLE "WebinarPlan" ADD CONSTRAINT "webinar_plan_waitlist_max_min"
  CHECK ("waitlistMax" IS NULL OR "waitlistMax" >= 1);

ALTER TABLE "ClassPlan" DROP CONSTRAINT IF EXISTS "class_plan_waitlist_max_min";
ALTER TABLE "ClassPlan" ADD CONSTRAINT "class_plan_waitlist_max_min"
  CHECK ("waitlistMax" IS NULL OR "waitlistMax" >= 1);

COMMIT;

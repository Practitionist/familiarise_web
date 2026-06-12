-- #676 A1–A4 — data-integrity CHECK constraints for booking/payment tables.
--
-- Prisma 7 has no @@check in PSL, so these ride the same sidecar pattern as
-- ledger-triggers.sql: idempotent statements split on `-- SPLIT`, applied via
-- `npm run db:constraints` after every push/reset (NOT against the shared dev
-- DB mid-cycle — the pre-MVP reset applies them to a clean schema).
--
-- Payment amounts use >= 0, not > 0: credit-covered checkouts and
-- org-sponsored bookings legitimately write amount = 0 (free_/org_ synthetic
-- payment intents in lib/payments/operations/checkout.ts).

ALTER TABLE "SlotOfAppointment" DROP CONSTRAINT IF EXISTS "slot_time_order";
-- SPLIT
ALTER TABLE "SlotOfAppointment" ADD CONSTRAINT "slot_time_order" CHECK ("endsAt" > "startsAt");
-- SPLIT
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "payment_amounts_nonnegative";
-- SPLIT
ALTER TABLE "Payment" ADD CONSTRAINT "payment_amounts_nonnegative" CHECK ("amount" >= 0 AND "originalAmount" >= 0 AND "taxAmount" >= 0);
-- SPLIT
ALTER TABLE "ConsultationPlan" DROP CONSTRAINT IF EXISTS "consultation_plan_price_nonnegative";
-- SPLIT
ALTER TABLE "ConsultationPlan" ADD CONSTRAINT "consultation_plan_price_nonnegative" CHECK ("price" >= 0);
-- SPLIT
ALTER TABLE "SubscriptionPlan" DROP CONSTRAINT IF EXISTS "subscription_plan_price_nonnegative";
-- SPLIT
ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "subscription_plan_price_nonnegative" CHECK ("price" >= 0);
-- SPLIT
ALTER TABLE "WebinarPlan" DROP CONSTRAINT IF EXISTS "webinar_plan_price_nonnegative";
-- SPLIT
ALTER TABLE "WebinarPlan" ADD CONSTRAINT "webinar_plan_price_nonnegative" CHECK ("price" >= 0);
-- SPLIT
ALTER TABLE "ClassPlan" DROP CONSTRAINT IF EXISTS "class_plan_price_nonnegative";
-- SPLIT
ALTER TABLE "ClassPlan" ADD CONSTRAINT "class_plan_price_nonnegative" CHECK ("price" >= 0);
-- SPLIT
ALTER TABLE "WebinarPlan" DROP CONSTRAINT IF EXISTS "webinar_plan_max_participants_min";
-- SPLIT
ALTER TABLE "WebinarPlan" ADD CONSTRAINT "webinar_plan_max_participants_min" CHECK ("maxParticipants" >= 1);
-- SPLIT
ALTER TABLE "ClassPlan" DROP CONSTRAINT IF EXISTS "class_plan_max_participants_min";
-- SPLIT
ALTER TABLE "ClassPlan" ADD CONSTRAINT "class_plan_max_participants_min" CHECK ("maxParticipants" >= 1);

-- SPLIT
-- #440 — DB-level double-booking backstop for 1:1 bookings. The application
-- guards (consultant allocation lock, #827 confirm-time recheck) are the
-- first line; this exclusion constraint is the last line: two CONFIRMED
-- slots for the same consultant may never overlap in time. Scoped to rows
-- carrying the denormalized consultantProfileId — consultation/subscription
-- slot creates set it; webinar/class attendee slots deliberately leave it
-- NULL (many same-window rows per event are legitimate there) and legacy
-- pre-#440 rows are NULL. tstzrange is '[)' so back-to-back slots don't
-- conflict.
CREATE EXTENSION IF NOT EXISTS btree_gist;
-- SPLIT
ALTER TABLE "SlotOfAppointment" DROP CONSTRAINT IF EXISTS "slot_no_confirmed_overlap";
-- SPLIT
ALTER TABLE "SlotOfAppointment" ADD CONSTRAINT "slot_no_confirmed_overlap"
  EXCLUDE USING gist (
    "consultantProfileId" WITH =,
    tstzrange("startsAt", "endsAt") WITH &&
  )
  WHERE ("consultantProfileId" IS NOT NULL AND NOT "isTentative");

-- SPLIT
-- #747 / #685 — DB-enforced "at most one pending invite per (org, email)".
-- Prisma's `partialIndexes` is still preview at 7.7.0 (drift bugs
-- prisma/prisma#29263 / #29415), so the partial unique index ships via this
-- sidecar instead; the Serializable tx in invitations/route.ts stays as the
-- first line. Applied to a clean schema (pre-MVP reset) — CREATE fails loudly
-- if duplicate pending invites already exist, which is the correct outcome.
CREATE UNIQUE INDEX IF NOT EXISTS "invitations_org_email_pending_key"
  ON "invitations" ("organizationId", "email")
  WHERE "status" = 'pending';

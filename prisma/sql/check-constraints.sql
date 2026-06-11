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

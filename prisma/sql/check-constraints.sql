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
-- first line. lower(email): the accept flow compares case-insensitively and
-- the POST handler normalizes, so the index must not admit a mixed-case
-- duplicate from any other writer. Applied to a clean schema (pre-MVP reset)
-- — CREATE fails loudly if duplicate pending invites already exist, which is
-- the correct outcome.
DROP INDEX IF EXISTS "invitations_org_email_pending_key";
-- SPLIT
CREATE UNIQUE INDEX "invitations_org_email_pending_key"
  ON "invitations" ("organizationId", lower("email"))
  WHERE "status" = 'pending';

-- SPLIT
-- #676 PM-17 — extend the payment_amounts_nonnegative pattern to every other
-- money-bearing table. Every paise column is non-negative (>= 0, matching
-- Payment). We deliberately do NOT use > 0: zero is legitimate across the
-- board — fully-refunded or credit/org-sponsored rows, LICENSE-funded
-- bookings (amount = 0), and refund/earnings reversal counter-entries that
-- net a row back to zero. NULLable columns (e.g. tdsAmountPaise, netAmount)
-- are exempted automatically: a CHECK passes when its operand is NULL.
ALTER TABLE "Refund" DROP CONSTRAINT IF EXISTS "refund_amount_nonnegative";
-- SPLIT
ALTER TABLE "Refund" ADD CONSTRAINT "refund_amount_nonnegative" CHECK ("amountPaise" >= 0);
-- SPLIT
ALTER TABLE "Dispute" DROP CONSTRAINT IF EXISTS "dispute_amount_nonnegative";
-- SPLIT
ALTER TABLE "Dispute" ADD CONSTRAINT "dispute_amount_nonnegative" CHECK ("amountPaise" >= 0);
-- SPLIT
ALTER TABLE "ConsultantPayout" DROP CONSTRAINT IF EXISTS "consultant_payout_amounts_nonnegative";
-- SPLIT
ALTER TABLE "ConsultantPayout" ADD CONSTRAINT "consultant_payout_amounts_nonnegative"
  CHECK ("amount" >= 0 AND "tdsDeducted" >= 0 AND ("netAmount" IS NULL OR "netAmount" >= 0));
-- SPLIT
ALTER TABLE "OrganizationPayout" DROP CONSTRAINT IF EXISTS "org_payout_amounts_nonnegative";
-- SPLIT
ALTER TABLE "OrganizationPayout" ADD CONSTRAINT "org_payout_amounts_nonnegative"
  CHECK (
    "amountPaise" >= 0
    AND "grossRevenuePaise" >= 0
    AND "platformFeePaise" >= 0
    AND "refundsPaise" >= 0
    AND "netPayoutPaise" >= 0
    AND "clawbackAmountPaise" >= 0
    AND ("tdsAmountPaise" IS NULL OR "tdsAmountPaise" >= 0)
  );
-- SPLIT
ALTER TABLE "ConsultantEarnings" DROP CONSTRAINT IF EXISTS "consultant_earnings_amounts_nonnegative";
-- SPLIT
ALTER TABLE "ConsultantEarnings" ADD CONSTRAINT "consultant_earnings_amounts_nonnegative"
  CHECK (
    "grossAmount" >= 0
    AND "platformFeePaise" >= 0
    AND "consultantSharePaise" >= 0
    AND "refundedShareAmount" >= 0
    AND ("gstTcsAccruedPaise" IS NULL OR "gstTcsAccruedPaise" >= 0)
  );
-- SPLIT
ALTER TABLE "OrganizationEarnings" DROP CONSTRAINT IF EXISTS "org_earnings_amounts_nonnegative";
-- SPLIT
ALTER TABLE "OrganizationEarnings" ADD CONSTRAINT "org_earnings_amounts_nonnegative"
  CHECK (
    "grossAmountPaise" >= 0
    AND "platformFeePaise" >= 0
    AND "orgSharePaise" >= 0
    AND "consultantSharePaise" >= 0
    AND "refundedAmountPaise" >= 0
  );

-- SPLIT
-- #676 PM-18 — the 3-way split must never distribute more than it took in:
-- platform fee + org share + consultant share <= gross. earnings-service.ts
-- computes orgShare as the residual (gross - platformFee - consultantShare,
-- clamped to >= 0), so equality is the norm and this catches a future writer
-- that mis-derives the split. Applied to OrganizationEarnings only: the
-- ConsultantEarnings COLLABORATOR rows deliberately carry grossAmount = 0
-- while consultantSharePaise > 0 (the booking gross lives once on the OWNER
-- row), so the same invariant does not hold there and must not be enforced.
ALTER TABLE "OrganizationEarnings" DROP CONSTRAINT IF EXISTS "org_earnings_split_within_gross";
-- SPLIT
ALTER TABLE "OrganizationEarnings" ADD CONSTRAINT "org_earnings_split_within_gross"
  CHECK ("platformFeePaise" + "orgSharePaise" + "consultantSharePaise" <= "grossAmountPaise");

-- SPLIT
-- #676 PM-22 — financial-year strings are always "YYYY-YY" (e.g. 2026-27).
-- Both writers persist the FY to avoid Apr-Mar boundary drift; this rejects a
-- malformed value at write time. ConsultantPayout.tdsFinancialYear is nullable
-- (payouts without a TDS deduction), so NULL is admitted.
ALTER TABLE "TDSRecord" DROP CONSTRAINT IF EXISTS "tds_record_financial_year_format";
-- SPLIT
ALTER TABLE "TDSRecord" ADD CONSTRAINT "tds_record_financial_year_format"
  CHECK ("financialYear" ~ '^[0-9]{4}-[0-9]{2}$');
-- SPLIT
ALTER TABLE "ConsultantPayout" DROP CONSTRAINT IF EXISTS "consultant_payout_tds_fy_format";
-- SPLIT
ALTER TABLE "ConsultantPayout" ADD CONSTRAINT "consultant_payout_tds_fy_format"
  CHECK ("tdsFinancialYear" IS NULL OR "tdsFinancialYear" ~ '^[0-9]{4}-[0-9]{2}$');

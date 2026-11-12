-- Earnings, holds and payout invariants on both the consultant and the organisation rail.
BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE "ConsultantPayout" DROP CONSTRAINT IF EXISTS "consultant_payout_amounts_nonnegative";
ALTER TABLE "ConsultantPayout" ADD CONSTRAINT "consultant_payout_amounts_nonnegative"
  CHECK ("amount" >= 0 AND "tdsDeducted" >= 0 AND "clawbackAmountPaise" >= 0 AND ("netAmount" IS NULL OR "netAmount" >= 0));

ALTER TABLE "OrganizationPayout" DROP CONSTRAINT IF EXISTS "org_payout_amounts_nonnegative";
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

ALTER TABLE "ConsultantEarnings" DROP CONSTRAINT IF EXISTS "consultant_earnings_amounts_nonnegative";
ALTER TABLE "ConsultantEarnings" ADD CONSTRAINT "consultant_earnings_amounts_nonnegative"
  CHECK (
    "grossAmount" >= 0
    AND "platformFeePaise" >= 0
    AND "consultantSharePaise" >= 0
    AND "refundedShareAmount" >= 0
  );

ALTER TABLE "OrganizationEarnings" DROP CONSTRAINT IF EXISTS "org_earnings_amounts_nonnegative";
ALTER TABLE "OrganizationEarnings" ADD CONSTRAINT "org_earnings_amounts_nonnegative"
  CHECK (
    "grossAmountPaise" >= 0
    AND "platformFeePaise" >= 0
    AND "orgSharePaise" >= 0
    AND "consultantSharePaise" >= 0
    AND "refundedAmountPaise" >= 0
  );

-- Platform fee, org share and consultant share never exceed the gross they split.
ALTER TABLE "OrganizationEarnings" DROP CONSTRAINT IF EXISTS "org_earnings_split_within_gross";
ALTER TABLE "OrganizationEarnings" ADD CONSTRAINT "org_earnings_split_within_gross"
  CHECK ("platformFeePaise" + "orgSharePaise" + "consultantSharePaise" <= "grossAmountPaise");

-- A per-earning share snapshot lies in 0..10000 bps.
ALTER TABLE "ConsultantEarnings" DROP CONSTRAINT IF EXISTS "consultant_earnings_share_bps_range";
ALTER TABLE "ConsultantEarnings" ADD CONSTRAINT "consultant_earnings_share_bps_range"
  CHECK ("shareBps" >= 0 AND "shareBps" <= 10000);

-- One earning per payment, consultant, role, occurrence and cycle; NULLs compare equal.
DROP INDEX IF EXISTS "consultant_earnings_occurrence_key";
CREATE UNIQUE INDEX IF NOT EXISTS "consultant_earnings_occurrence_key"
  ON "ConsultantEarnings" ("paymentId", "consultantProfileId", "role", "appointmentOccurrenceId", "cycleOrdinal") NULLS NOT DISTINCT;

-- A fee waiver is consumed by CAS on sessionsRemaining > 0; it never goes negative.
ALTER TABLE "ConsultantFeeWaiver" DROP CONSTRAINT IF EXISTS "consultant_fee_waiver_sessions_nonnegative";
ALTER TABLE "ConsultantFeeWaiver" ADD CONSTRAINT "consultant_fee_waiver_sessions_nonnegative"
  CHECK ("sessionsRemaining" >= 0);

-- A referral waiver names its referral; a founding waiver has none.
ALTER TABLE "ConsultantFeeWaiver" DROP CONSTRAINT IF EXISTS "consultant_fee_waiver_referral_matches_reason";
ALTER TABLE "ConsultantFeeWaiver" ADD CONSTRAINT "consultant_fee_waiver_referral_matches_reason"
  CHECK (("reason" = 'FOUNDING_EXPERT') = ("referralId" IS NULL));

-- One founding waiver per consultant; the admin grant maps the violation to a 409.
CREATE UNIQUE INDEX IF NOT EXISTS "consultant_fee_waiver_one_founding_key"
  ON "ConsultantFeeWaiver" ("consultantProfileId")
  WHERE "reason" = 'FOUNDING_EXPERT';

-- Take rates are basis points of the gross; own-link never exceeds marketplace, and the
-- proposer approves their own schedule only once it has stood 24 hours (sole-admin rule).
ALTER TABLE "PlatformFeeSchedule" DROP CONSTRAINT IF EXISTS "platform_fee_schedule_valid";
ALTER TABLE "PlatformFeeSchedule" ADD CONSTRAINT "platform_fee_schedule_valid"
  CHECK (
    "marketplaceBps" BETWEEN 0 AND 10000
    AND "ownLinkBps" BETWEEN 0 AND "marketplaceBps"
    AND (
      "checkerUserId" IS NULL
      OR "checkerUserId" <> "makerUserId"
      OR "approvedAt" >= "createdAt" + interval '24 hours'
    )
    AND (("checkerUserId" IS NULL) = ("approvedAt" IS NULL))
  );

DROP INDEX IF EXISTS "organization_earnings_split_key";
CREATE UNIQUE INDEX IF NOT EXISTS "organization_earnings_split_key"
  ON "OrganizationEarnings" ("paymentId", "organizationId", "consultantProfileId", "role", "cycleOrdinal")
  NULLS NOT DISTINCT;

-- 194-O: one threshold catch-up per expert per financial year among live payouts; a
-- catch-up belongs to the payout's own TDS year, and a credit back is never negative.
ALTER TABLE "ConsultantPayout" DROP CONSTRAINT IF EXISTS "consultant_payout_tds_threshold_sane";
ALTER TABLE "ConsultantPayout" ADD CONSTRAINT "consultant_payout_tds_threshold_sane"
  CHECK (
    "tdsCreditPaise" >= 0
    AND ("tdsCatchUpFy" IS NULL OR "tdsCatchUpFy" = "tdsFinancialYear")
  );

CREATE UNIQUE INDEX IF NOT EXISTS "consultant_payout_one_tds_catch_up_per_fy"
  ON "ConsultantPayout" ("consultantProfileId", "tdsCatchUpFy")
  WHERE "tdsCatchUpFy" IS NOT NULL
    AND "status" IN ('PROCESSING', 'COMPLETED');

-- An EarningsHold freezes exactly one earning, consultant or organisation.
ALTER TABLE "EarningsHold" DROP CONSTRAINT IF EXISTS "earnings_hold_one_earning";
ALTER TABLE "EarningsHold" ADD CONSTRAINT "earnings_hold_one_earning"
  CHECK (num_nonnulls("consultantEarningsId", "organizationEarningsId") = 1);

-- One active hold per (earning, reason, source); a released hold keeps its row.
CREATE UNIQUE INDEX IF NOT EXISTS "earnings_hold_active_consultant_key"
  ON "EarningsHold" ("consultantEarningsId", "reason", "sourceRef")
  WHERE "releasedAt" IS NULL AND "consultantEarningsId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "earnings_hold_active_org_key"
  ON "EarningsHold" ("organizationEarningsId", "reason", "sourceRef")
  WHERE "releasedAt" IS NULL AND "organizationEarningsId" IS NOT NULL;

ALTER TABLE "ConsultantEarnings" DROP CONSTRAINT IF EXISTS "consultant_earnings_batched_has_payout";
ALTER TABLE "ConsultantEarnings" ADD CONSTRAINT "consultant_earnings_batched_has_payout"
  CHECK ("status" <> 'BATCHED' OR "payoutId" IS NOT NULL);

ALTER TABLE "OrganizationEarnings" DROP CONSTRAINT IF EXISTS "org_earnings_batched_has_payout";
ALTER TABLE "OrganizationEarnings" ADD CONSTRAINT "org_earnings_batched_has_payout"
  CHECK ("status" <> 'BATCHED' OR "orgPayoutId" IS NOT NULL);

ALTER TABLE "ConsultantEarnings" DROP CONSTRAINT IF EXISTS "consultant_earnings_currency_inr";
ALTER TABLE "ConsultantEarnings" ADD CONSTRAINT "consultant_earnings_currency_inr" CHECK ("currency" = 'INR');

ALTER TABLE "ConsultantPayout" DROP CONSTRAINT IF EXISTS "consultant_payout_currency_inr";
ALTER TABLE "ConsultantPayout" ADD CONSTRAINT "consultant_payout_currency_inr" CHECK ("currency" = 'INR');

COMMIT;

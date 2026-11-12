-- Referral credit and programme configuration invariants.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- The stored remaining credit always equals amount minus used.
ALTER TABLE "ReferralCredit" DROP CONSTRAINT IF EXISTS "referral_credit_balance_consistent";
ALTER TABLE "ReferralCredit" ADD CONSTRAINT "referral_credit_balance_consistent"
  CHECK (
    "amount" >= 0
    AND "usedAmount" >= 0
    AND "remainingAmount" >= 0
    AND "remainingAmount" = "amount" - "usedAmount"
  );

ALTER TABLE "ReferralCreditUsage" DROP CONSTRAINT IF EXISTS "referral_credit_usage_nonnegative";
ALTER TABLE "ReferralCreditUsage" ADD CONSTRAINT "referral_credit_usage_nonnegative"
  CHECK ("amount" >= 0 AND "originalAmount" >= 0 AND "restoredAmount" >= 0);

ALTER TABLE "ReferralProgramConfig" DROP CONSTRAINT IF EXISTS "referral_program_config_ranges";
ALTER TABLE "ReferralProgramConfig" ADD CONSTRAINT "referral_program_config_ranges"
  CHECK (
    "discountBps" BETWEEN 0 AND 10000
    AND "redemptionCapBps" BETWEEN 0 AND 10000
    AND "monthlyBudgetPaise" >= 0
    AND "currentMonthSpentPaise" >= 0
    AND "referrerRewardPaise" >= 0
    AND "discountMaxPaise" >= 0
    AND "minOrderPaise" >= 0
    AND "perReferrerYearlyCapPaise" >= 0
    AND "creditExpiryDays" > 0
    AND "qualifyWindowDays" > 0
    AND "perCodeLifetimeCap" >= 0
    AND "weeklyVestCap" >= 0
    AND "expertYearlyReferralCap" >= 0
    AND "expertWaiverSessions" >= 0
    AND "expertWaiverDays" > 0
    AND "expertReferralBudgetPaise" >= 0
    AND "foundingWaiverSessions" >= 0
    AND "foundingWaiverDays" > 0
    AND "foundingExpertCap" >= 0
    AND ("holdSameIpReferrals" IS NULL OR "holdSameIpReferrals" >= 2)
    AND ("holdSameDeviceReferrals" IS NULL OR "holdSameDeviceReferrals" >= 2)
    AND ("holdWindowDays" IS NULL OR "holdWindowDays" > 0)
  );

COMMIT;

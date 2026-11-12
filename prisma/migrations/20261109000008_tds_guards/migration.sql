-- Withholding invariants: financial-year format, one deductee per row and sane rates.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- Financial years are written YYYY-YY.
ALTER TABLE "TDSRecord" DROP CONSTRAINT IF EXISTS "tds_record_financial_year_format";
ALTER TABLE "TDSRecord" ADD CONSTRAINT "tds_record_financial_year_format"
  CHECK ("financialYear" ~ '^[0-9]{4}-[0-9]{2}$');

ALTER TABLE "ConsultantPayout" DROP CONSTRAINT IF EXISTS "consultant_payout_tds_fy_format";
ALTER TABLE "ConsultantPayout" ADD CONSTRAINT "consultant_payout_tds_fy_format"
  CHECK ("tdsFinancialYear" IS NULL OR "tdsFinancialYear" ~ '^[0-9]{4}-[0-9]{2}$');

-- A withholding row belongs to exactly one deductee: a consultant or an organisation.
ALTER TABLE "TDSRecord" DROP CONSTRAINT IF EXISTS "tds_record_deductee_xor";
ALTER TABLE "TDSRecord" ADD CONSTRAINT "tds_record_deductee_xor"
  CHECK (("consultantProfileId" IS NULL) <> ("organizationId" IS NULL));

-- The payout a withholding row cites is on the same rail as its deductee.
ALTER TABLE "TDSRecord" DROP CONSTRAINT IF EXISTS "tds_record_payout_rail_matches";
ALTER TABLE "TDSRecord" ADD CONSTRAINT "tds_record_payout_rail_matches"
  CHECK (
    ("organizationId" IS NULL AND "orgPayoutId" IS NULL)
    OR ("consultantProfileId" IS NULL AND "payoutId" IS NULL)
  );

-- A TDS adjustment belongs to exactly one deductee.
ALTER TABLE "TdsAdjustment" DROP CONSTRAINT IF EXISTS "tds_adjustment_deductee_xor";
ALTER TABLE "TdsAdjustment" ADD CONSTRAINT "tds_adjustment_deductee_xor"
  CHECK (("consultantProfileId" IS NULL) <> ("organizationId" IS NULL));

-- Org payout financial years are written YYYY-YY.
ALTER TABLE "OrganizationPayout" DROP CONSTRAINT IF EXISTS "org_payout_tds_fy_format";
ALTER TABLE "OrganizationPayout" ADD CONSTRAINT "org_payout_tds_fy_format"
  CHECK ("tdsFinancialYear" IS NULL OR "tdsFinancialYear" ~ '^[0-9]{4}-[0-9]{2}$');

-- TDS rates lie in 0..10000 bps, thresholds are non-negative and windows never end before they start.
ALTER TABLE "TdsRate" DROP CONSTRAINT IF EXISTS "tds_rate_bps_and_window_sane";
ALTER TABLE "TdsRate" ADD CONSTRAINT "tds_rate_bps_and_window_sane"
  CHECK (
    "rateBps" >= 0 AND "rateBps" <= 10000
    AND ("noPanRateBps" IS NULL OR ("noPanRateBps" >= 0 AND "noPanRateBps" <= 10000))
    AND ("thresholdPaise" IS NULL OR "thresholdPaise" >= 0)
    AND ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
  );

ALTER TABLE "TdsRate" DROP CONSTRAINT IF EXISTS "tds_rate_bps_bounds";
ALTER TABLE "TdsRate" ADD CONSTRAINT "tds_rate_bps_bounds"
  CHECK (
    "rateBps" >= 0 AND "rateBps" <= 10000
    AND ("noPanRateBps" IS NULL OR ("noPanRateBps" >= 0 AND "noPanRateBps" <= 10000))
  );

COMMIT;

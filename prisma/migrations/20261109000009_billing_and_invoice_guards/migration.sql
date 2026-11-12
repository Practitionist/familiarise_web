-- Organisation billing, statutory documents, rate cards and program-assignment invariants.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- A prepaid wallet never goes negative; NULL means the account is not on WALLET funding.
ALTER TABLE "BillingAccount" DROP CONSTRAINT IF EXISTS "billing_account_wallet_nonnegative";
ALTER TABLE "BillingAccount" ADD CONSTRAINT "billing_account_wallet_nonnegative"
  CHECK ("walletBalance" IS NULL OR "walletBalance" >= 0);

-- A purchase order can never have more left on it than it was worth.
ALTER TABLE "PurchaseOrder" DROP CONSTRAINT IF EXISTS "purchase_order_amounts_coherent";
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "purchase_order_amounts_coherent"
  CHECK (
    "totalAmountPaise" >= 0
    AND "remainingAmountPaise" >= 0
    AND "remainingAmountPaise" <= "totalAmountPaise"
  );

-- marginalPaise is what the payer is charged: base + surcharge + the surcharge's
-- GST, which is never negative, so it can never fall below base + surcharge.
ALTER TABLE "OverageEvent" DROP CONSTRAINT IF EXISTS "overage_marginal_is_base_plus_surcharge";
ALTER TABLE "OverageEvent" ADD CONSTRAINT "overage_marginal_is_base_plus_surcharge"
  CHECK (
    "basePaise" >= 0
    AND "surchargePaise" >= 0
    AND "marginalPaise" >= "basePaise" + "surchargePaise"
  );

-- A rate card's three shares sum to exactly 10000 bps.
ALTER TABLE "RateCard" DROP CONSTRAINT IF EXISTS "rate_card_bps_sum_is_whole";
ALTER TABLE "RateCard" ADD CONSTRAINT "rate_card_bps_sum_is_whole"
  CHECK (
    "platformBps" >= 0 AND "orgBps" >= 0 AND "consultantBps" >= 0
    AND "platformBps" + "orgBps" + "consultantBps" = 10000
  );

-- Redemptions never exceed a capped code's limit.
ALTER TABLE "DiscountCode" DROP CONSTRAINT IF EXISTS "discount_code_uses_within_cap";
ALTER TABLE "DiscountCode" ADD CONSTRAINT "discount_code_uses_within_cap"
  CHECK (
    "currentUses" >= 0
    AND ("maxUses" IS NULL OR "currentUses" <= "maxUses")
  );

-- Statutory documents and billing amounts are non-negative and their tax heads add up.
ALTER TABLE "OrganizationInvoice" DROP CONSTRAINT IF EXISTS "org_invoice_amounts_nonnegative";
ALTER TABLE "OrganizationInvoice" ADD CONSTRAINT "org_invoice_amounts_nonnegative"
  CHECK (
    "subtotalPaise" >= 0
    AND "igstPaise" >= 0 AND "cgstPaise" >= 0 AND "sgstPaise" >= 0
    AND "totalPaise" >= 0
    AND "subtotalPaise" + "igstPaise" + "cgstPaise" + "sgstPaise" = "totalPaise"
  );

ALTER TABLE "InvoiceLineItem" DROP CONSTRAINT IF EXISTS "invoice_line_item_amounts_nonnegative";
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "invoice_line_item_amounts_nonnegative"
  CHECK ("quantity" > 0 AND "unitPricePaise" >= 0 AND ("taxPaise" IS NULL OR "taxPaise" >= 0));

ALTER TABLE "CreditNote" DROP CONSTRAINT IF EXISTS "credit_note_amounts_nonnegative";
ALTER TABLE "CreditNote" ADD CONSTRAINT "credit_note_amounts_nonnegative"
  CHECK (
    "subtotalPaise" >= 0
    AND "igstPaise" >= 0 AND "cgstPaise" >= 0 AND "sgstPaise" >= 0
    AND "totalPaise" >= 0
    AND "igstPaise" + "cgstPaise" + "sgstPaise" <= "totalPaise"
  );

-- An org credit note is keyed by exactly one of a refund, a dispute, an overage reversal or a voided invoice.
ALTER TABLE "CreditNote" DROP CONSTRAINT IF EXISTS "credit_note_trigger_xor";
ALTER TABLE "CreditNote" ADD CONSTRAINT "credit_note_trigger_xor"
  CHECK (num_nonnulls("refundId", "disputeId", "overageEventId", "voidedInvoiceId") = 1);

ALTER TABLE "WalletTopUp" DROP CONSTRAINT IF EXISTS "wallet_topup_amount_positive";
ALTER TABLE "WalletTopUp" ADD CONSTRAINT "wallet_topup_amount_positive"
  CHECK ("amountPaise" > 0);

ALTER TABLE "LicensedSeatConfig" DROP CONSTRAINT IF EXISTS "licensed_seat_config_pricing_sane";
ALTER TABLE "LicensedSeatConfig" ADD CONSTRAINT "licensed_seat_config_pricing_sane"
  CHECK (
    "ratePerSeatPaise" >= 0
    AND ("priceCapPerEngagementPaise" IS NULL OR "priceCapPerEngagementPaise" >= 0)
    AND ("maxOveragePerCyclePaise" IS NULL OR "maxOveragePerCyclePaise" >= 0)
    AND ("overageSurchargeBps" IS NULL OR ("overageSurchargeBps" >= 0 AND "overageSurchargeBps" <= 10000))
  );

ALTER TABLE "Contract" DROP CONSTRAINT IF EXISTS "contract_payment_terms_nonnegative";
ALTER TABLE "Contract" ADD CONSTRAINT "contract_payment_terms_nonnegative"
  CHECK ("paymentTermsDays" >= 0);

-- One open rate-card window per scope; NULL scope columns compare equal.
DROP INDEX IF EXISTS "rate_card_one_open_window";
CREATE UNIQUE INDEX IF NOT EXISTS "rate_card_one_open_window"
  ON "RateCard" ("ownerOrgId", "ownerContractId", "planType", "planId")
  NULLS NOT DISTINCT
  WHERE "effectiveTo" IS NULL;

-- B2C tax documents carry non-negative heads.
ALTER TABLE "ConsumerInvoice" DROP CONSTRAINT IF EXISTS "consumer_invoice_amounts_nonnegative";
ALTER TABLE "ConsumerInvoice" ADD CONSTRAINT "consumer_invoice_amounts_nonnegative"
  CHECK ("taxableValuePaise" >= 0 AND "cgstPaise" >= 0 AND "sgstPaise" >= 0 AND "igstPaise" >= 0 AND "totalPaise" >= 0);

-- A supply is intra-state (CGST+SGST) or inter-state (IGST), never both.
ALTER TABLE "ConsumerInvoice" DROP CONSTRAINT IF EXISTS "consumer_invoice_tax_head_xor";
ALTER TABLE "ConsumerInvoice" ADD CONSTRAINT "consumer_invoice_tax_head_xor"
  CHECK ("igstPaise" = 0 OR ("cgstPaise" = 0 AND "sgstPaise" = 0));

ALTER TABLE "ConsumerCreditNote" DROP CONSTRAINT IF EXISTS "consumer_credit_note_amounts_nonnegative";
ALTER TABLE "ConsumerCreditNote" ADD CONSTRAINT "consumer_credit_note_amounts_nonnegative"
  CHECK ("taxableValuePaise" >= 0 AND "cgstPaise" >= 0 AND "sgstPaise" >= 0 AND "igstPaise" >= 0 AND "totalPaise" >= 0);

-- A credit note follows the place-of-supply rule of the invoice it reverses.
ALTER TABLE "ConsumerCreditNote" DROP CONSTRAINT IF EXISTS "consumer_credit_note_tax_head_xor";
ALTER TABLE "ConsumerCreditNote" ADD CONSTRAINT "consumer_credit_note_tax_head_xor"
  CHECK ("igstPaise" = 0 OR ("cgstPaise" = 0 AND "sgstPaise" = 0));

-- ACTIVE program assignments of one membership never overlap in time.
ALTER TABLE "ProgramAssignment" DROP CONSTRAINT IF EXISTS "program_assignment_no_active_overlap";
ALTER TABLE "ProgramAssignment" ADD CONSTRAINT "program_assignment_no_active_overlap"
  EXCLUDE USING gist (
    "programId" WITH =,
    "membershipId" WITH =,
    tstzrange("periodStart", "periodEnd") WITH &&
  ) WHERE ("status" = 'ACTIVE');

-- At most one ACTIVE contract per BillingAccount so active billing-term lookups
-- never face ambiguous active contracts.
DROP INDEX IF EXISTS "contract_one_active_per_billing_account_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "contract_one_active_per_billing_account_idx"
  ON "Contract" ("billingAccountId")
  WHERE "status" = 'ACTIVE';

-- CreditPoolConfig pricing and budget bounds (parity with licensed_seat_config_pricing_sane).
ALTER TABLE "CreditPoolConfig" DROP CONSTRAINT IF EXISTS "credit_pool_config_pricing_sane";
ALTER TABLE "CreditPoolConfig" ADD CONSTRAINT "credit_pool_config_pricing_sane"
  CHECK (
    "creditBudgetPerCycle" > 0
    AND ("overageSurchargeBps" IS NULL OR ("overageSurchargeBps" >= 0 AND "overageSurchargeBps" <= 10000))
    AND ("maxOveragePerCyclePaise" IS NULL OR "maxOveragePerCyclePaise" > 0)
    AND ("priceCapPerEngagementPaise" IS NULL OR "priceCapPerEngagementPaise" > 0)
  );

COMMIT;

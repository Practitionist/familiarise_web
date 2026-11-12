-- Payment, refund, dispute and webhook-event invariants.
BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "payment_amounts_nonnegative";
ALTER TABLE "Payment" ADD CONSTRAINT "payment_amounts_nonnegative"
  CHECK ("amount" >= 0 AND "originalAmount" >= 0 AND "taxAmount" >= 0);

ALTER TABLE "PaymentLeg" DROP CONSTRAINT IF EXISTS "payment_leg_nonreversal_nonnegative";
ALTER TABLE "PaymentLeg" ADD CONSTRAINT "payment_leg_nonreversal_nonnegative"
  CHECK ("source"::text LIKE '%\_REVERSAL' OR "amountPaise" >= 0);

-- Money columns are non-negative; zero is legitimate (credit-funded, sponsored or fully reversed rows).
ALTER TABLE "Refund" DROP CONSTRAINT IF EXISTS "refund_amount_nonnegative";
ALTER TABLE "Refund" ADD CONSTRAINT "refund_amount_nonnegative" CHECK ("amountPaise" >= 0);

ALTER TABLE "Dispute" DROP CONSTRAINT IF EXISTS "dispute_amount_nonnegative";
ALTER TABLE "Dispute" ADD CONSTRAINT "dispute_amount_nonnegative" CHECK ("amountPaise" >= 0);

ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "payment_platform_fee_bps_range";
ALTER TABLE "Payment" ADD CONSTRAINT "payment_platform_fee_bps_range"
  CHECK ("platformFeeBps" IS NULL OR "platformFeeBps" BETWEEN 0 AND 10000);

ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "payment_welcome_discount_positive";
ALTER TABLE "Payment" ADD CONSTRAINT "payment_welcome_discount_positive"
  CHECK ("welcomeDiscountPaise" IS NULL OR "welcomeDiscountPaise" > 0);

-- At most one live welcome-discounted order per buyer; a second checkout must finish or abandon the first.
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_live_welcome_discount_user_key"
  ON "Payment" ("userId")
  WHERE "welcomeDiscountPaise" IS NOT NULL
    AND "referralReleasedAt" IS NULL
    AND "paymentStatus" IN ('PENDING', 'SUCCEEDED')
    AND "deletedAt" IS NULL;

-- A processed event carries no error, and processedAt is set exactly when processed is.
ALTER TABLE "WebhookEvent" DROP CONSTRAINT IF EXISTS "webhook_event_processed_error_exclusive";
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "webhook_event_processed_error_exclusive"
  CHECK (NOT ("processed" AND "error" IS NOT NULL));
ALTER TABLE "WebhookEvent" DROP CONSTRAINT IF EXISTS "webhook_event_processed_timestamp_consistent";
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "webhook_event_processed_timestamp_consistent"
  CHECK (("processed" IS TRUE) IS NOT DISTINCT FROM ("processedAt" IS NOT NULL));

CREATE INDEX IF NOT EXISTS "WebhookEvent_unprocessed_provider_receivedAt_idx"
  ON "WebhookEvent" ("provider", "receivedAt")
  WHERE NOT "processed";

-- A stamped refund-owed amount is positive; NULL means the full remaining balance.
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "payment_refund_owed_paise_positive";
ALTER TABLE "Payment" ADD CONSTRAINT "payment_refund_owed_paise_positive"
  CHECK ("refundOwedPaise" IS NULL OR "refundOwedPaise" > 0);

ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "payment_currency_inr";
ALTER TABLE "Payment" ADD CONSTRAINT "payment_currency_inr" CHECK ("currency" = 'INR');

ALTER TABLE "Refund" DROP CONSTRAINT IF EXISTS "refund_currency_inr";
ALTER TABLE "Refund" ADD CONSTRAINT "refund_currency_inr" CHECK ("currency" = 'INR');

ALTER TABLE "Dispute" DROP CONSTRAINT IF EXISTS "dispute_currency_inr";
ALTER TABLE "Dispute" ADD CONSTRAINT "dispute_currency_inr" CHECK ("currency" = 'INR');

COMMIT;

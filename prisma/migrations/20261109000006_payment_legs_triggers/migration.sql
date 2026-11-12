-- Deferred constraint triggers: payment legs sum to the payment, and refunds never exceed it.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- Non-reversal, non-credit legs sum to Payment.amount (licence-only payments skip the sum);
-- each reversal leg is negative and never exceeds its original siblings.
CREATE OR REPLACE FUNCTION assert_payment_legs_ok(p_payment_id TEXT) RETURNS void
SET search_path = public
AS $$
DECLARE
  v_amount BIGINT;
  v_funding_sum BIGINT;
  v_sibling_sum BIGINT;
  v_original_count BIGINT;
  v_non_license_count BIGINT;
  r RECORD;
BEGIN
  SELECT "amount" INTO v_amount FROM "Payment" WHERE "id" = p_payment_id;
  IF NOT FOUND THEN
    RETURN; -- payment already gone (cascade delete) — nothing to guard
  END IF;

  -- Both counts span every non-reversal leg INCLUDING REFERRAL_CREDIT, so the
  -- carve fires on pure LICENSE bookings (where every non-reversal leg is a
  -- 0-value LICENSE leg) while split LICENSE + CARD co-pay bookings (one 0-value
  -- LICENSE leg plus non-LICENSE legs summing to Payment.amount) proceed into
  -- the non-LICENSE funding-sum check below.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (
      WHERE NOT ("source"::text = 'LICENSE' AND "amountPaise" = 0)
    )
  INTO v_original_count, v_non_license_count
  FROM "PaymentLeg"
  WHERE "paymentId" = p_payment_id
    AND RIGHT("source"::text, 9) <> '_REVERSAL';

  IF NOT (v_original_count > 0 AND v_non_license_count = 0) THEN
    SELECT COALESCE(SUM("amountPaise"), 0) INTO v_funding_sum
    FROM "PaymentLeg"
    WHERE "paymentId" = p_payment_id
      AND RIGHT("source"::text, 9) <> '_REVERSAL'
      AND "source"::text NOT IN ('REFERRAL_CREDIT', 'LICENSE');

    IF v_funding_sum <> v_amount THEN
      RAISE EXCEPTION 'payment_legs_sum_to_amount violated for payment %: legs sum to % but Payment.amount is %',
        p_payment_id, v_funding_sum, v_amount
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  FOR r IN
    SELECT "source", "amountPaise"
    FROM "PaymentLeg"
    WHERE "paymentId" = p_payment_id
      AND RIGHT("source"::text, 9) = '_REVERSAL'
  LOOP
    IF r."amountPaise" >= 0 THEN
      RAISE EXCEPTION 'payment_legs_reversal_pair violated for payment %: reversal leg % carries non-negative %',
        p_payment_id, r."source", r."amountPaise"
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT COALESCE(SUM("amountPaise"), 0) INTO v_sibling_sum
    FROM "PaymentLeg"
    WHERE "paymentId" = p_payment_id
      AND "source"::text = LEFT(r."source"::text, LENGTH(r."source"::text) - 9);

    IF -r."amountPaise" > v_sibling_sum THEN
      RAISE EXCEPTION 'payment_legs_reversal_pair violated for payment %: reversal % (%) exceeds original sibling sum %',
        p_payment_id, r."source", -r."amountPaise", v_sibling_sum
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Re-parenting a leg re-checks both payments.
CREATE OR REPLACE FUNCTION assert_payment_legs_on_leg_write() RETURNS trigger
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM assert_payment_legs_ok(OLD."paymentId");
  ELSIF TG_OP = 'UPDATE' AND NEW."paymentId" IS DISTINCT FROM OLD."paymentId" THEN
    PERFORM assert_payment_legs_ok(OLD."paymentId");
    PERFORM assert_payment_legs_ok(NEW."paymentId");
  ELSE
    PERFORM assert_payment_legs_ok(NEW."paymentId");
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_legs_sum_to_amount ON "PaymentLeg";
CREATE CONSTRAINT TRIGGER payment_legs_sum_to_amount
  AFTER INSERT OR UPDATE OR DELETE ON "PaymentLeg"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_payment_legs_on_leg_write();

-- A direct Payment.amount write re-checks its legs.
CREATE OR REPLACE FUNCTION assert_payment_legs_on_payment_update() RETURNS trigger
SET search_path = public
AS $$
BEGIN
  PERFORM assert_payment_legs_ok(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_amount_vs_legs ON "Payment";
CREATE CONSTRAINT TRIGGER payment_amount_vs_legs
  AFTER INSERT OR UPDATE OF "amount" ON "Payment"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_payment_legs_on_payment_update();

-- Succeeded and pending refunds plus lost chargebacks never exceed Payment.amount.
CREATE OR REPLACE FUNCTION assert_payment_refunds_within_amount(p_payment_id TEXT) RETURNS void
SET search_path = public
AS $$
DECLARE
  v_amount BIGINT;
  v_refunded BIGINT;
  v_charged_back BIGINT;
BEGIN
  -- Concurrent refund commits on one payment serialize here, so each sees the other's row.
  SELECT "amount" INTO v_amount FROM "Payment" WHERE "id" = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM("amountPaise"), 0) INTO v_refunded
  FROM "Refund"
  WHERE "paymentId" = p_payment_id
    AND "status" IN ('SUCCEEDED', 'PENDING');

  SELECT COALESCE(SUM("amountPaise"), 0) INTO v_charged_back
  FROM "Dispute"
  WHERE "paymentId" = p_payment_id
    AND "status" IN ('LOST', 'CHARGE_REFUNDED');

  IF v_refunded + v_charged_back > v_amount THEN
    RAISE EXCEPTION 'payment_refunds_within_amount violated for payment %: refunds % + chargebacks % exceed Payment.amount %',
      p_payment_id, v_refunded, v_charged_back, v_amount
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION assert_payment_refunds_on_write() RETURNS trigger
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."paymentId" IS DISTINCT FROM OLD."paymentId" THEN
    PERFORM assert_payment_refunds_within_amount(OLD."paymentId");
  END IF;
  PERFORM assert_payment_refunds_within_amount(NEW."paymentId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_refunds_within_amount ON "Refund";
CREATE CONSTRAINT TRIGGER payment_refunds_within_amount
  AFTER INSERT OR UPDATE OF "status", "amountPaise", "paymentId" ON "Refund"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_payment_refunds_on_write();

COMMIT;

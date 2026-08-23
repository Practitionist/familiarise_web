-- #1020-4 / C-02 — PaymentLeg funding-sum invariant, enforced by the DATABASE.
--
-- `lib/payments/payment-legs.ts::checkPaymentLegsSumToAmount` defines the
-- invariant: sum of non-reversal legs === Payment.amount, and every
-- *_REVERSAL leg is negative and never exceeds its original sibling in
-- magnitude. Checkout logs drift warn-only (a surprise 500 on the hot path
-- blocks real bookings); reconcilers assert it after the fact. Both are
-- detection. This trigger makes the imbalance UNCOMMITTABLE — the same
-- posture ledger-triggers.sql already gives the journal — so no writer
-- (app code, raw SQL, a future script) can persist drifted legs.
--
-- Semantics mirror checkPaymentLegsSumToAmount EXACTLY:
--   * funding sum  = Σ amountPaise over legs whose source does not end in
--     `_REVERSAL` (LICENSE's intentional 0-value legs are part of the sum)
--   * reversal leg = must be negative; |reversal| ≤ Σ its original siblings
--
-- DEFERRABLE INITIALLY DEFERRED: fires at COMMIT, so multi-statement writes
-- (Payment + legs in one tx) never see a half-written state. Row-level per
-- Postgres constraint-trigger rules; each fired row re-checks its whole
-- payment, which is idempotent when several rows commit together.

CREATE OR REPLACE FUNCTION assert_payment_legs_sum_to_amount() RETURNS trigger AS $$
DECLARE
  v_payment_id TEXT;
  v_amount BIGINT;
  v_funding_sum BIGINT;
  v_sibling_sum BIGINT;
  r RECORD;
BEGIN
  v_payment_id := COALESCE(NEW.paymentId, OLD.paymentId);

  SELECT "amount" INTO v_amount FROM "Payment" WHERE "id" = v_payment_id;
  IF NOT FOUND THEN
    RETURN NULL; -- payment already gone (cascade delete) — nothing to guard
  END IF;

  SELECT COALESCE(SUM("amountPaise"), 0) INTO v_funding_sum
  FROM "PaymentLeg"
  WHERE "paymentId" = v_payment_id
    AND RIGHT("source"::text, 9) <> '_REVERSAL';

  IF v_funding_sum <> v_amount THEN
    RAISE EXCEPTION 'payment_legs_sum_to_amount violated for payment %: legs sum to % but Payment.amount is %',
      v_payment_id, v_funding_sum, v_amount
      USING ERRCODE = 'check_violation';
  END IF;

  FOR r IN
    SELECT "source", "amountPaise"
    FROM "PaymentLeg"
    WHERE "paymentId" = v_payment_id
      AND RIGHT("source"::text, 9) = '_REVERSAL'
  LOOP
    IF r."amountPaise" >= 0 THEN
      RAISE EXCEPTION 'payment_legs_reversal_pair violated for payment %: reversal leg % carries non-negative %',
        v_payment_id, r."source", r."amountPaise"
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT COALESCE(SUM("amountPaise"), 0) INTO v_sibling_sum
    FROM "PaymentLeg"
    WHERE "paymentId" = v_payment_id
      AND "source"::text = LEFT(r."source"::text, LENGTH(r."source"::text) - 9);

    IF -r."amountPaise" > v_sibling_sum THEN
      RAISE EXCEPTION 'payment_legs_reversal_pair violated for payment %: reversal % (%) exceeds original sibling sum %',
        v_payment_id, r."source", -r."amountPaise", v_sibling_sum
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- SPLIT
DROP TRIGGER IF EXISTS payment_legs_sum_to_amount ON "PaymentLeg";
-- SPLIT
CREATE CONSTRAINT TRIGGER payment_legs_sum_to_amount
  AFTER INSERT OR UPDATE OR DELETE ON "PaymentLeg"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_payment_legs_sum_to_amount();

-- The double-entry ledger and the usage ledger: balanced, positive, INR and append-only.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- Entry amounts are strictly positive; direction carries the sign the balance trigger sums.
ALTER TABLE "LedgerEntry" DROP CONSTRAINT IF EXISTS "ledger_entry_amount_positive";
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "ledger_entry_amount_positive"
  CHECK ("amountPaise" > 0);

-- The usage ledger is append-only; meters are derived from it.
DROP TRIGGER IF EXISTS usage_ledger_entry_immutable ON "UsageLedgerEntry";

CREATE OR REPLACE FUNCTION assert_usage_ledger_entry_immutable() RETURNS trigger
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'UsageLedgerEntry % is immutable (% refused)', OLD."id", TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER usage_ledger_entry_immutable
  BEFORE UPDATE OR DELETE ON "UsageLedgerEntry"
  FOR EACH ROW
  EXECUTE FUNCTION assert_usage_ledger_entry_immutable();

-- Settlement is INR-only: every ledger account and money row carries INR.
ALTER TABLE "LedgerAccount" DROP CONSTRAINT IF EXISTS "ledger_account_currency_inr";
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "ledger_account_currency_inr" CHECK ("currency" = 'INR');

DROP TRIGGER IF EXISTS ledger_txn_balanced ON "LedgerEntry";

-- Every ledger transaction balances at COMMIT: Σ DEBIT = Σ CREDIT.
CREATE OR REPLACE FUNCTION assert_ledger_txn_balanced() RETURNS trigger
SET search_path = public
AS $$
DECLARE
  txn_id text;
  imbalance bigint;
BEGIN
  txn_id := COALESCE(NEW."transactionId", OLD."transactionId");
  SELECT COALESCE(
           SUM(CASE WHEN "direction" = 'DEBIT' THEN "amountPaise" ELSE -"amountPaise" END),
           0)
    INTO imbalance
    FROM "LedgerEntry"
   WHERE "transactionId" = txn_id;
  IF imbalance <> 0 THEN
    RAISE EXCEPTION
      'Ledger transaction % is unbalanced by % paise (Sum(DEBIT) - Sum(CREDIT) != 0)',
      txn_id, imbalance;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_txn_balanced
  AFTER INSERT OR UPDATE OR DELETE ON "LedgerEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_ledger_txn_balanced();

-- The journal is append-only.
DROP TRIGGER IF EXISTS ledger_entry_immutable ON "LedgerEntry";

CREATE OR REPLACE FUNCTION assert_ledger_entry_immutable() RETURNS trigger
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'LedgerEntry % is immutable (% refused)', OLD."id", TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entry_immutable
  BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW
  EXECUTE FUNCTION assert_ledger_entry_immutable();

DROP TRIGGER IF EXISTS ledger_transaction_immutable ON "LedgerTransaction";

CREATE OR REPLACE FUNCTION assert_ledger_transaction_immutable() RETURNS trigger
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'LedgerTransaction % is immutable (% refused)', OLD."id", TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_transaction_immutable
  BEFORE UPDATE OR DELETE ON "LedgerTransaction"
  FOR EACH ROW
  EXECUTE FUNCTION assert_ledger_transaction_immutable();

COMMIT;

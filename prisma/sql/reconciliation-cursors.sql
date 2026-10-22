-- Operator-applied additive rollout for fair recovery polling; apply before deploying the readers.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "lastReconciledAt" TIMESTAMPTZ;
ALTER TABLE "Refund" ADD COLUMN IF NOT EXISTS "lastReconciledAt" TIMESTAMPTZ;
ALTER TABLE "WalletTopUp" ADD COLUMN IF NOT EXISTS "lastReconciledAt" TIMESTAMPTZ;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "lastAccrualRollupAt" TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS "Organization_lastAccrualRollupAt_id_idx" ON "Organization" ("lastAccrualRollupAt", id);
CREATE INDEX IF NOT EXISTS "Payment_paymentStatus_lastReconciledAt_id_idx" ON "Payment" ("paymentStatus", "lastReconciledAt", id);
CREATE INDEX IF NOT EXISTS "Refund_status_lastReconciledAt_id_idx" ON "Refund" (status, "lastReconciledAt", id);
CREATE INDEX IF NOT EXISTS "WalletTopUp_status_lastReconciledAt_id_idx" ON "WalletTopUp" (status, "lastReconciledAt", id);
COMMIT;

/**
 * Starts one ledger reconciliation in-process, shared by the reconcile-ledgers
 * door and the console's reconcile job. The shared lease rejects active callers.
 * Wallet pages freeze immediately; idle checkpoints can be resumed by an admin.
 */

import {
  freezeDriftedWallets,
  type FrozenWallet,
} from "@/lib/payments/wallet-freeze";
import { runReconcileLedgers } from "@/scripts/reconcile/reconcile-ledgers";

export async function startLedgerReconciliation(input: {
  organizationId?: string;
  triggeredById?: string;
}) {
  const { organizationId } = input;
  const frozenWallets: FrozenWallet[] = [];
  const report = await runReconcileLedgers({
    scope: organizationId ? `org:${organizationId}` : "full",
    ...(organizationId ? { organizationId } : {}),
    triggeredById: input.triggeredById,
    onWalletDrift: async (id, findings) => {
      await freezeDriftedWallets({ id, findings }, frozenWallets);
    },
  });
  await freezeDriftedWallets(
    {
      id: report.id,
      findings: report.findings.filter(
        (finding) =>
          !frozenWallets.some(
            (wallet) => wallet.billingAccountId === finding.billingAccountId,
          ),
      ),
    },
    frozenWallets,
  );
  return { ...report, frozenWallets };
}

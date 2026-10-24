/** Advances an authenticated audit slice; only newly checked wallet pages freeze. */

import {
  freezeDriftedWallets,
  type FrozenWallet,
} from "@/lib/payments/wallet-freeze";
import { runReconcileLedgers } from "@/scripts/reconcile/reconcile-ledgers";

export async function startLedgerReconciliation(input: {
  organizationId?: string;
  triggeredById: string;
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
  return { ...report, frozenWallets };
}

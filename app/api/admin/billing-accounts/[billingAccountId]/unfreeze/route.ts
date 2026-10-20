/**
 * POST /api/admin/billing-accounts/[billingAccountId]/unfreeze
 *
 * Manual ops release for a wallet-spend freeze (#837): once the drift that made
 * the reconcile job freeze the wallet is reconciled, this writes the
 * WALLET_UNFREEZE event that lifts it. ADMIN, step-up, a reason and an ops log
 * row; unfreezing a wallet that is not frozen is a 409, so a retry cannot double-act.
 * The account's wallet drift is re-checked first; a wallet still drifted stays frozen.
 */

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import prisma from "@/lib/prisma";
import {
  isWalletFrozen,
  unfreezeWalletSpend,
} from "@/lib/payments/wallet-freeze";
import { walletDriftFindings } from "@/scripts/reconcile/reconcile-ledgers";

const NOT_FROZEN = () =>
  new OpsRefusal(
    "NOT_FROZEN",
    "Wallet spend is not frozen on this account.",
    409,
  );

export const POST = withOpsAction(
  "payments.manage",
  "wallet.unfreeze",
  {},
  {
    mode: "gateway",
    target: ({ params }) => ({
      kind: "BillingAccount",
      id: params.billingAccountId,
    }),
    run: async ({ params, body, actor }) => {
      const account = await prisma.billingAccount.findUnique({
        where: { id: params.billingAccountId },
        select: { id: true, ownerOrgId: true },
      });
      if (!account) {
        throw new OpsRefusal("NOT_FOUND", "Billing account not found.", 404);
      }
      if (!(await isWalletFrozen(prisma, account.id))) throw NOT_FROZEN();
      const { findings } = await walletDriftFindings({
        billingAccountId: account.id,
      });
      const drift = findings[0];
      if (drift) {
        throw new OpsRefusal(
          "WALLET_STILL_DRIFTED",
          `The cached wallet balance (${drift.actualPaise} paise) still differs from the journal (${drift.expectedPaise} paise).`,
          409,
        );
      }
      // false ⇒ a concurrent actor or re-freeze won; never report success for a no-op.
      const applied = await unfreezeWalletSpend({
        billingAccountId: account.id,
        organizationId: account.ownerOrgId,
        actorUserId: actor.userId,
        reason: body.reason,
      });
      if (!applied) throw NOT_FROZEN();
      return {
        target: { kind: "BillingAccount", id: account.id },
        before: { frozen: true },
        after: { frozen: false, organizationId: account.ownerOrgId },
        response: { status: "unfrozen", billingAccountId: account.id },
      };
    },
  },
  { stepUp: true },
);

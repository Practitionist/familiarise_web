/**
 * POST /api/admin/billing-accounts/[billingAccountId]/refund-remaining
 *
 * Returns an org's remaining wallet balance the way it came in: refunds against
 * its CONFIRMED top-ups, newest first, each keyed `wallet-refund:<account>:<topUp>`.
 * Wallet spend is frozen for the run and lifted only when this run froze it and
 * the balance reached 0. A drifted wallet is refused before any money moves.
 */

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import prisma from "@/lib/prisma";
import {
  freezeWalletSpend,
  isWalletFrozen,
  unfreezeWalletSpend,
} from "@/lib/payments/wallet-freeze";
import { refundRemainingWalletBalance } from "@/lib/payments/operations/wallet-refund";
import { walletDriftFindings } from "@/scripts/reconcile/reconcile-ledgers";

export const POST = withOpsAction(
  "payments.manage",
  "wallet.refund_remaining",
  {},
  {
    mode: "gateway",
    target: ({ params }) => ({
      kind: "BillingAccount",
      id: params.billingAccountId,
    }),
    run: async ({ params, body, actor }) => {
      await assertMoneyOpsBudget(actor.userId);
      const account = await prisma.billingAccount.findUnique({
        where: { id: params.billingAccountId },
        select: { id: true, ownerOrgId: true },
      });
      if (!account) {
        throw new OpsRefusal("NOT_FOUND", "Billing account not found.", 404);
      }
      const { findings } = await walletDriftFindings({
        billingAccountId: account.id,
      });
      if (findings.length > 0) {
        throw new OpsRefusal(
          "WALLET_DRIFTED",
          "The cached wallet balance differs from the journal; reconcile it before refunding.",
          409,
        );
      }

      const wasFrozen = await isWalletFrozen(prisma, account.id);
      await freezeWalletSpend({
        billingAccountId: account.id,
        organizationId: account.ownerOrgId,
        reason: `refund-remaining by ${actor.userId}: ${body.reason}`,
      });
      const result = await refundRemainingWalletBalance({
        billingAccountId: account.id,
        reason: body.reason,
      });
      const unfrozen =
        !wasFrozen && result.balanceAfterPaise === 0
          ? await unfreezeWalletSpend({
              billingAccountId: account.id,
              organizationId: account.ownerOrgId,
              actorUserId: actor.userId,
              reason: `refund-remaining complete: ${body.reason}`,
            })
          : false;

      const summary = {
        startingBalancePaise: result.startingBalancePaise,
        balanceAfterPaise: result.balanceAfterPaise,
        pendingPaise: result.pendingPaise,
        refundCount: result.refunds.length,
        stoppedOn: result.stoppedOn,
        frozen: !unfrozen,
      };
      return {
        target: { kind: "BillingAccount", id: account.id },
        before: { walletBalancePaise: result.startingBalancePaise },
        after: summary,
        response: { ...summary, refunds: result.refunds },
        status: result.stoppedOn ? 207 : 200,
      };
    },
  },
  { stepUp: true },
);

/**
 * POST /api/admin/billing-accounts/[billingAccountId]/refund-remaining
 *
 * Returns an org's remaining top-up money the way it came in: refunds against
 * its CONFIRMED top-ups, newest first, each keyed `wallet-refund:<account>:<topUp>`.
 * Operator-granted credit stays in the wallet. Wallet spend is frozen for the run
 * and lifted only when this run froze it and no top-up money is left. A drifted
 * wallet is refused before any money moves.
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
import {
  grantedWalletCreditPaise,
  refundRemainingWalletBalance,
} from "@/lib/payments/operations/wallet-refund";
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
      const retainedPaise = Math.min(
        result.balanceAfterPaise,
        result.grantedCreditPaise,
      );
      const unfrozen =
        !wasFrozen && result.balanceAfterPaise === retainedPaise
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
        retainedGrantedCreditPaise: retainedPaise,
        ...(retainedPaise > 0 && {
          note: "Operator-granted credit stays in the wallet; this door returns only top-up money.",
        }),
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
  {
    stepUp: true,
    secondApprover: {
      route: "/api/admin/billing-accounts/[billingAccountId]/refund-remaining",
      target: ({ params }) => ({
        kind: "BillingAccount",
        id: params.billingAccountId,
      }),
      // What the run would return: the cached balance less operator-granted credit.
      amountPaise: async (_body, { params }) => {
        const account = await prisma.billingAccount.findUnique({
          where: { id: params.billingAccountId },
          select: { walletBalance: true, ownerOrgId: true },
        });
        if (!account) return 0;
        const granted = await grantedWalletCreditPaise(
          prisma,
          account.ownerOrgId,
        );
        return Math.max(0, (account.walletBalance ?? 0) - granted);
      },
    },
  },
);

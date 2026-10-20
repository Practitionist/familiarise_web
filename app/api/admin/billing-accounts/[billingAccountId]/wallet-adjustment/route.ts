/**
 * POST /api/admin/billing-accounts/[billingAccountId]/wallet-adjustment
 *
 * An operator's signed wallet correction: the balanced journal (against
 * PLATFORM_PROMO for a credit, PLATFORM_FEE for a debit), the cached balance and
 * the ops log row commit in one transaction. ADMIN, step-up, a reason, and a
 * caller-minted key so a double-click replays instead of adjusting twice.
 */

import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { assertMoneyOpsBudget } from "@/lib/backoffice/money-limit";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  adjustWallet,
  WalletAdjustmentKeyReusedError,
  WalletInsufficientFundsError,
} from "@/lib/api/organizations/wallet";

const KEY_REQUIRED_COPY =
  "idempotencyKey is required and must be a UUID — mint one per adjustment dialog.";

export const POST = withOpsAction(
  "payments.manage",
  "wallet.adjust",
  {
    amountPaise: z
      .number()
      .int()
      .refine((n) => n !== 0 && Number.isSafeInteger(n), {
        message: "amountPaise must be a non-zero whole number of paise.",
      }),
    idempotencyKey: z
      .string({
        required_error: KEY_REQUIRED_COPY,
        invalid_type_error: KEY_REQUIRED_COPY,
      })
      .uuid(KEY_REQUIRED_COPY),
  },
  {
    mode: "tx",
    run: async (tx, { params, body, actor }) => {
      await assertMoneyOpsBudget(actor.userId);
      const account = await tx.billingAccount.findUnique({
        where: { id: params.billingAccountId },
        select: { id: true, walletBalance: true },
      });
      if (!account) {
        throw new OpsRefusal("NOT_FOUND", "Billing account not found.", 404);
      }
      try {
        const result = await adjustWallet(tx, {
          billingAccountId: account.id,
          amountPaise: body.amountPaise,
          idempotencyKey: body.idempotencyKey,
          description: `Ops wallet adjustment by ${actor.userId}: ${body.reason}`,
        });
        return {
          target: { kind: "BillingAccount", id: account.id },
          before: { walletBalancePaise: account.walletBalance ?? 0 },
          after: {
            walletBalancePaise: result.balanceAfter,
            amountPaise: body.amountPaise,
            replayed: result.replayed,
          },
          response: {
            status: result.replayed ? "replayed" : "adjusted",
            billingAccountId: account.id,
            balanceAfterPaise: result.balanceAfter,
          },
        };
      } catch (err) {
        if (err instanceof WalletInsufficientFundsError) {
          throw new OpsRefusal(
            "WALLET_INSUFFICIENT_FUNDS",
            "The wallet holds less than this debit; a wallet balance never goes negative.",
            409,
          );
        }
        if (err instanceof WalletAdjustmentKeyReusedError) {
          throw new OpsRefusal(
            "IDEMPOTENCY_KEY_REUSED",
            "This adjustment key was already used for a different amount.",
            409,
          );
        }
        throw err;
      }
    },
  },
  {
    stepUp: true,
    secondApprover: {
      route: "/api/admin/billing-accounts/[billingAccountId]/wallet-adjustment",
      target: ({ params }) => ({
        kind: "BillingAccount",
        id: params.billingAccountId,
      }),
      amountPaise: (body) => Math.abs(body.amountPaise),
    },
  },
);

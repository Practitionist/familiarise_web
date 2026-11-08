/**
 * POST /api/admin/referrals/credits/[creditId]/reverse — ADMIN voids a credit's unused balance
 * with a reason, through `reverseCreditBalance`, and the audit row in the same transaction.
 */

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";
import { reverseCreditBalance } from "@/lib/referrals/credit-reversal";

export const POST = withOpsAction(
  "referrals.manage",
  "referrals.credit.reverse",
  {},
  {
    mode: "tx",
    run: async (tx, ctx) => {
      const creditId = ctx.params.creditId;
      if (!creditId) {
        throw new OpsRefusal(
          "INVALID_CREDIT_ID",
          "Credit ID is required.",
          400,
        );
      }

      const now = new Date();
      const outcome = await reverseCreditBalance(tx, {
        creditId,
        reversedBy: ctx.actor.userId,
        reason: ctx.body.reason,
        now,
      });
      switch (outcome.kind) {
        case "NOT_FOUND":
          throw new OpsRefusal(
            "CREDIT_NOT_FOUND",
            "Referral credit not found.",
            404,
          );
        case "ALREADY_REVERSED":
          throw new OpsRefusal(
            "CREDIT_ALREADY_REVERSED",
            "This referral credit has already been reversed.",
            409,
          );
        case "NOT_REVERSIBLE":
          throw new OpsRefusal(
            "CREDIT_NOT_REVERSIBLE",
            `This referral credit is ${outcome.state.toLowerCase()} and holds nothing to reverse.`,
            409,
          );
        case "NO_REMAINING_BALANCE":
        case "RETIRED":
          throw new OpsRefusal(
            "NO_REMAINING_BALANCE",
            "This referral credit has no unused balance left to reverse.",
            409,
          );
        case "CHANGED":
          throw new OpsRefusal(
            "CREDIT_CHANGED",
            "Credit was modified or reversed concurrently; refresh and retry.",
            409,
          );
        case "REVERSED":
          break;
      }

      const updated = await tx.referralCredit.findUniqueOrThrow({
        where: { id: creditId },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          usages: {
            select: {
              id: true,
              paymentId: true,
              amount: true,
              originalAmount: true,
              restoredAmount: true,
              createdAt: true,
            },
            orderBy: { createdAt: "desc" },
          },
        },
      });

      const { before, reversedPaise } = outcome;
      return {
        target: { kind: "ReferralCredit", id: creditId },
        response: {
          credit: updated,
          reversedAmountPaise: reversedPaise,
        },
        before: {
          amountPaise: before.amountPaise,
          usedAmountPaise: before.usedPaise,
          remainingAmountPaise: reversedPaise,
          reversedAt: null,
        },
        after: {
          amountPaise: before.usedPaise,
          usedAmountPaise: before.usedPaise,
          remainingAmountPaise: 0,
          reversedAmountPaise: reversedPaise,
          reversedAt: now.toISOString(),
          reversedBy: ctx.actor.userId,
          reversedReason: ctx.body.reason,
        },
      };
    },
  },
);

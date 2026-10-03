/**
 * POST /api/admin/referrals/credits/[creditId]/reverse
 *
 * #1839 — Reverse unused referral credit balance (Admin-only via `withOpsAction`).
 *
 * Enforces:
 * - `referrals.manage` surface permission + mandatory audit reason (`opsReasonSchema`)
 * - Credit must exist, must not already be reversed (`reversedAt === null`),
 *   and must have `remainingAmount > 0` (otherwise 409 Conflict).
 * - Satisfies the DB CHECK constraint `referral_credit_balance_consistent`
 *   (`remainingAmount = amount - usedAmount`, all >= 0) by setting
 *   `amount = credit.usedAmount` and `remainingAmount = 0`, preserving
 *   `usedAmount` as the exact sum of `ReferralCreditUsage` rows.
 * - Stamps `reversedAt`, `reversedBy`, and `reversedReason`, and writes an
 *   atomic `OpsActionLog` row in the same transaction.
 */

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";

export const POST = withOpsAction(
  "referrals.manage",
  "referrals.credit.reverse",
  {},
  {
    mode: "tx",
    run: async (tx, ctx) => {
      const creditId = ctx.params.creditId;
      if (!creditId) {
        throw new OpsRefusal("INVALID_CREDIT_ID", "Credit ID is required.", 400);
      }

      const existing = await tx.referralCredit.findUnique({
        where: { id: creditId },
      });
      if (!existing) {
        throw new OpsRefusal(
          "CREDIT_NOT_FOUND",
          "Referral credit not found.",
          404,
        );
      }

      if (existing.reversedAt !== null) {
        throw new OpsRefusal(
          "CREDIT_ALREADY_REVERSED",
          "This referral credit has already been reversed.",
          409,
        );
      }

      const remainingPaise = Number(existing.remainingAmount);
      const usedPaise = Number(existing.usedAmount);
      const originalAmountPaise = Number(existing.amount);

      if (remainingPaise <= 0) {
        throw new OpsRefusal(
          "NO_REMAINING_BALANCE",
          "This referral credit has no unused balance left to reverse.",
          409,
        );
      }

      const now = new Date();
      const cas = await tx.referralCredit.updateMany({
        where: {
          id: creditId,
          reversedAt: null,
          usedAmount: existing.usedAmount,
          remainingAmount: existing.remainingAmount,
        },
        data: {
          // Preserve usedAmount = sum(usages) while zeroing remainingAmount so
          // the DB CHECK constraint `remainingAmount = amount - usedAmount` holds.
          amount: usedPaise,
          remainingAmount: 0,
          reversedAt: now,
          reversedBy: ctx.actor.userId,
          reversedReason: ctx.body.reason,
        },
      });
      if (cas.count !== 1) {
        throw new OpsRefusal(
          "CREDIT_CHANGED",
          "Credit was modified or reversed concurrently; refresh and retry.",
          409,
        );
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

      return {
        target: { kind: "ReferralCredit", id: creditId },
        response: {
          credit: updated,
          reversedAmountPaise: remainingPaise,
        },
        before: {
          amountPaise: originalAmountPaise,
          usedAmountPaise: usedPaise,
          remainingAmountPaise: remainingPaise,
          reversedAt: null,
        },
        after: {
          amountPaise: usedPaise,
          usedAmountPaise: usedPaise,
          remainingAmountPaise: 0,
          reversedAmountPaise: remainingPaise,
          reversedAt: now.toISOString(),
          reversedBy: ctx.actor.userId,
          reversedReason: ctx.body.reason,
        },
      };
    },
  },
);

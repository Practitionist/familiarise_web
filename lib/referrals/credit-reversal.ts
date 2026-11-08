import type { ReferralCreditState } from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { postLedgerTxn } from "@/lib/payments/ledger/post";

export type CreditReversal =
  | {
      kind: "REVERSED";
      reversedPaise: number;
      before: {
        amountPaise: number;
        usedPaise: number;
        state: ReferralCreditState;
      };
    }
  | { kind: "RETIRED" }
  | { kind: "NOT_FOUND" }
  | { kind: "ALREADY_REVERSED" }
  | { kind: "NOT_REVERSIBLE"; state: ReferralCreditState }
  | { kind: "NO_REMAINING_BALANCE" }
  | { kind: "CHANGED" };

/**
 * Voids a credit's unused balance by CAS on its state and balance, keeping usedAmount (the spent
 * part) so `remainingAmount = amount - usedAmount` holds, and releases a vested balance from the
 * liability under `referral-reverse:<creditId>`. A credit is reversed at most once.
 */
export async function reverseCreditBalance(
  tx: Tx,
  input: {
    creditId: string;
    reversedBy: string;
    reason: string;
    now: Date;
    /** Also stamp a credit with nothing left to void (spent, reserved or expired), posting nothing. */
    retireEmpty?: boolean;
  },
): Promise<CreditReversal> {
  const { creditId, now } = input;
  const existing = await tx.referralCredit.findUnique({
    where: { id: creditId },
    select: {
      amount: true,
      usedAmount: true,
      remainingAmount: true,
      state: true,
      vestedAt: true,
      reversedAt: true,
    },
  });
  if (!existing) return { kind: "NOT_FOUND" };
  if (existing.reversedAt !== null) return { kind: "ALREADY_REVERSED" };
  const empty = existing.state === "EXPIRED" || existing.remainingAmount <= 0;
  if (existing.state !== "VOID" && empty && input.retireEmpty) {
    // The stamp makes a later restore of a reserved or spent balance land on a dead row.
    const retired = await tx.referralCredit.updateMany({
      where: {
        id: creditId,
        reversedAt: null,
        state: existing.state,
        usedAmount: existing.usedAmount,
        remainingAmount: existing.remainingAmount,
      },
      data: {
        reversedAt: now,
        reversedBy: input.reversedBy,
        reversedReason: input.reason,
        ...(existing.state === "VESTED" && { state: "VOID", voidedAt: now }),
      },
    });
    return retired.count === 1 ? { kind: "RETIRED" } : { kind: "CHANGED" };
  }
  if (existing.state === "EXPIRED" || existing.state === "VOID") {
    return { kind: "NOT_REVERSIBLE", state: existing.state };
  }
  if (existing.remainingAmount <= 0) return { kind: "NO_REMAINING_BALANCE" };

  const cas = await tx.referralCredit.updateMany({
    where: {
      id: creditId,
      reversedAt: null,
      state: existing.state,
      usedAmount: existing.usedAmount,
      remainingAmount: existing.remainingAmount,
    },
    data: {
      amount: existing.usedAmount,
      remainingAmount: 0,
      reversedAt: now,
      reversedBy: input.reversedBy,
      reversedReason: input.reason,
      state: "VOID",
      voidedAt: now,
    },
  });
  if (cas.count !== 1) return { kind: "CHANGED" };

  // Only a VESTED credit with vestedAt set sits in the liability.
  if (existing.vestedAt && existing.state === "VESTED") {
    await postLedgerTxn(tx, {
      idempotencyKey: `referral-reverse:${creditId}`,
      kind: "REFERRAL_CREDIT",
      description: `Referral credit ${creditId} reversed: ${input.reason}`,
      postings: [
        {
          account: { kind: "REFERRAL_CREDIT_LIABILITY" },
          direction: "DEBIT",
          amountPaise: existing.remainingAmount,
        },
        {
          account: { kind: "PLATFORM_PROMO" },
          direction: "CREDIT",
          amountPaise: existing.remainingAmount,
        },
      ],
    });
  }
  return {
    kind: "REVERSED",
    reversedPaise: existing.remainingAmount,
    before: {
      amountPaise: existing.amount,
      usedPaise: existing.usedAmount,
      state: existing.state,
    },
  };
}

/** Who a reversal made by the lost-chargeback settlement is stamped with. */
export const CHARGEBACK_REVERSAL_ACTOR = "system:chargeback";

/**
 * A lost chargeback on a payment that qualified VESTED referrals (a learner's and an expert's can
 * share one payment): each referrer's credit loses its unspent balance (the spent part is
 * absorbed) and the experts' unused waiver sessions end. Idempotent: a credit is reversed once.
 */
export async function voidVestedReferralRewards(
  tx: Tx,
  input: { paymentId: string; disputeId: string; now: Date },
): Promise<{ reversedPaise: number; waiversRevoked: number }> {
  const referrals = await tx.referral.findMany({
    where: { qualifyingPaymentId: input.paymentId, status: "VESTED" },
    select: { id: true, referralCode: { select: { userId: true } } },
  });
  if (referrals.length === 0) return { reversedPaise: 0, waiversRevoked: 0 };

  let reversedPaise = 0;
  for (const referral of referrals) {
    const credits = await tx.referralCredit.findMany({
      where: {
        referralId: referral.id,
        userId: referral.referralCode.userId,
        source: "REFERRAL_BONUS",
        reversedAt: null,
      },
      select: { id: true },
    });
    for (const credit of credits) {
      const outcome = await reverseCreditBalance(tx, {
        creditId: credit.id,
        reversedBy: CHARGEBACK_REVERSAL_ACTOR,
        reason: `chargeback lost (dispute ${input.disputeId})`,
        now: input.now,
        retireEmpty: true,
      });
      // A balance that moved underneath must not settle the dispute with the credit still live.
      if (outcome.kind === "CHANGED") {
        throw new Error(`REFERRAL_CREDIT_CHANGED: credit ${credit.id}`);
      }
      if (outcome.kind === "REVERSED") reversedPaise += outcome.reversedPaise;
    }
  }
  const waivers = await tx.consultantFeeWaiver.updateMany({
    where: {
      referralId: { in: referrals.map((r) => r.id) },
      sessionsRemaining: { gt: 0 },
    },
    data: { sessionsRemaining: 0 },
  });
  return { reversedPaise, waiversRevoked: waivers.count };
}

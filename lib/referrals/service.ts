import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { Prisma as PrismaNamespace } from "@prisma/client";
import type { ReferralCode, Referral, ReferralCredit } from "@prisma/client";
import { sumPaise } from "@/lib/payments/utils/money";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
import {
  acceptsNewReferees,
  readReferralProgramConfig,
} from "./program-config";

// #780 — bare model types still say bigint; the extended client returns number
export type ReferralCodeRow = Omit<
  ReferralCode,
  "referrerReward" | "refereeReward" | "totalEarned" | "yearRewardPaise"
> & {
  referrerReward: number | null;
  refereeReward: number | null;
  totalEarned: number;
  yearRewardPaise: number;
};
export type ReferralRow = Omit<
  Referral,
  "referrerRewardAmount" | "refereeRewardAmount"
> & {
  referrerRewardAmount: number | null;
  refereeRewardAmount: number | null;
};
export type ReferralCreditRow = Omit<
  ReferralCredit,
  "amount" | "usedAmount" | "remainingAmount"
> & {
  amount: number;
  usedAmount: number;
  remainingAmount: number;
};

// Constants
// #880 conservative launch: ₹300 each (the referrer reward ramps to ₹500 once
// unit economics are validated). Role-weighting and the consultant commission
// waiver arrive in later phases; these are the flat launch baselines.
const DEFAULT_REFERRER_REWARD = 30000; // ₹300 in paise
const DEFAULT_REFEREE_REWARD = 30000; // ₹300 in paise

/**
 * Creates or returns an existing referral code for a user.
 */
export async function createReferralCode(
  userId: string,
): Promise<ReferralCodeRow> {
  const existing = await prisma.referralCode.findUnique({
    where: { userId },
  });

  if (existing) return existing;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });

  const code = await generateUniqueCode(user?.name);

  try {
    return await prisma.referralCode.create({
      data: {
        userId,
        code,
        referrerReward: DEFAULT_REFERRER_REWARD,
        refereeReward: DEFAULT_REFEREE_REWARD,
      },
    });
  } catch (error) {
    // FIX #596: Handle race condition — concurrent first-use requests
    // can both pass the findUnique check, then one fails on unique constraint.
    if (
      error instanceof PrismaNamespace.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const rawTarget = error.meta?.target;
      const target = Array.isArray(rawTarget)
        ? rawTarget
        : typeof rawTarget === "string"
          ? [rawTarget]
          : [];
      const isUserIdConflict = target.includes("userId");

      // userId conflict: another request created the record first — return it
      if (isUserIdConflict) {
        const raced = await prisma.referralCode.findUnique({
          where: { userId },
        });
        if (raced) return raced;
      }

      // code conflict: generated code collided — retry with a new code
      const isCodeConflict = target.includes("code");
      if (isCodeConflict) {
        const retryCode = await generateUniqueCode(user?.name);
        return prisma.referralCode.create({
          data: {
            userId,
            code: retryCode,
            referrerReward: DEFAULT_REFERRER_REWARD,
            refereeReward: DEFAULT_REFEREE_REWARD,
          },
        });
      }
    }
    throw error;
  }
}

/**
 * Generates a unique referral code, trying name-based first, then random fallback.
 */
export async function generateUniqueCode(
  name?: string | null,
): Promise<string> {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  if (name) {
    const prefix = name
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 4);

    if (prefix.length >= 3) {
      for (let i = 0; i < 100; i++) {
        const suffix =
          chars[Math.floor(Math.random() * chars.length)] +
          chars[Math.floor(Math.random() * chars.length)];
        const code = `${prefix}${suffix}`;
        const exists = await prisma.referralCode.findUnique({
          where: { code },
        });
        if (!exists) return code;
      }
    }
  }

  // Fallback to random code
  let code: string;
  do {
    code = Array.from(
      { length: 8 },
      () => chars[Math.floor(Math.random() * chars.length)],
    ).join("");
  } while (await prisma.referralCode.findUnique({ where: { code } }));

  return code;
}

/**
 * Validates a referral code. Returns the code record if valid, null otherwise.
 */
export async function validateReferralCode(
  code: string,
  db: Tx | typeof prisma = prisma,
): Promise<ReferralCodeRow | null> {
  // Generated codes are upper-case; seeded and hand-typed ones are not.
  const typed = code.trim();
  return db.referralCode.findFirst({
    where: {
      OR: [
        { code: { equals: typed, mode: "insensitive" } },
        { customCode: { equals: typed, mode: "insensitive" } },
      ],
      isActive: true,
    },
  });
}

/**
 * Applies a referral code to a new account: no prior paid booking, created inside the
 * qualify window, programme live. Serializable so concurrent applies cannot pass the cap.
 */
export async function applyReferralCode(
  newUserId: string,
  code: string,
): Promise<ReferralRow | null> {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const referralCode = await validateReferralCode(code, tx);
        if (!referralCode || referralCode.userId === newUserId) return null;
        if (referralCode.totalReferrals >= referralCode.maxReferrals) {
          return null;
        }

        const cfg = await readReferralProgramConfig(tx);
        const now = new Date();
        if (!acceptsNewReferees(cfg, now)) return null;
        const windowStart = new Date(
          now.getTime() - cfg.qualifyWindowDays * 24 * 60 * 60 * 1000,
        );
        const user = await tx.user.findUnique({
          where: { id: newUserId },
          select: { createdAt: true },
        });
        if (!user || user.createdAt < windowStart) return null;
        const priorPaid = await tx.payment.count({
          where: {
            userId: newUserId,
            paymentStatus: "SUCCEEDED",
            deletedAt: null,
          },
        });
        if (priorPaid > 0) return null;

        const existingReferral = await tx.referral.findUnique({
          where: { referredUserId: newUserId },
          select: { id: true },
        });
        if (existingReferral) return null;

        const ref = await tx.referral.create({
          data: {
            referralCodeId: referralCode.id,
            referredUserId: newUserId,
            status: "SIGNED_UP",
            referrerRewardAmount: cfg.referrerRewardPaise,
            configVersion: cfg.version,
          },
        });

        await tx.referralCode.update({
          where: { id: referralCode.id },
          data: { totalReferrals: { increment: 1 } },
        });
        return ref;
      },
      {
        isolationLevel: "Serializable",
        timeout: 10000,
      },
    ),
  );
}

/** Credits the user can spend now: VESTED, INR, with balance, not past expiry. */
export function spendableCreditsWhere(
  userId: string,
  now: Date = new Date(),
): PrismaNamespace.ReferralCreditWhereInput {
  return {
    userId,
    currency: "INR",
    state: "VESTED",
    remainingAmount: { gt: 0 },
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

/**
 * Returns the user's available (non-expired, non-fully-used) credit balance.
 */
export async function getUserCredits(
  userId: string,
  db: Tx | typeof prisma = prisma,
): Promise<{
  totalAvailable: number;
  credits: ReferralCreditRow[];
}> {
  const credits = await db.referralCredit.findMany({
    where: spendableCreditsWhere(userId),
    orderBy: { expiresAt: "asc" },
  });

  const totalAvailable = credits.reduce((sum, c) => sum + c.remainingAmount, 0);

  return { totalAvailable, credits };
}

/**
 * A credit with `vestedAt` set is a liability: redeeming it draws the liability down (Dr
 * REFERRAL_CREDIT_LIABILITY / Cr PLATFORM_PROMO) and restoring it on a refund or an
 * abandoned order re-raises it, so the liability always equals the vested balance.
 */
async function postReferralLiabilityMove(
  tx: Tx,
  input: {
    key: string;
    direction: "DRAW" | "RESTORE";
    amountPaise: number;
    description: string;
  },
): Promise<void> {
  if (input.amountPaise <= 0) return;
  const liability = { kind: "REFERRAL_CREDIT_LIABILITY" as const };
  const promo = { kind: "PLATFORM_PROMO" as const };
  const draw = input.direction === "DRAW";
  await postLedgerTxn(tx, {
    idempotencyKey: input.key,
    kind: "REFERRAL_CREDIT",
    description: input.description,
    postings: [
      {
        account: draw ? liability : promo,
        direction: "DEBIT",
        amountPaise: input.amountPaise,
      },
      {
        account: draw ? promo : liability,
        direction: "CREDIT",
        amountPaise: input.amountPaise,
      },
    ],
  });
}

/**
 * Applies referral credits to a payment at checkout, soonest-expiring first. Each draw is
 * a CAS on a still-spendable balance; a credit that changed underneath aborts the checkout
 * with CREDIT_SHORTFALL so it re-prices. Usage rows keep the per-payment trail.
 */
export async function applyCreditsToPayment(
  userId: string,
  paymentAmount: number,
  tx: Tx,
  paymentId?: string,
): Promise<{ creditsUsed: number; remainingToPay: number }> {
  const now = new Date();
  const { credits } = await getUserCredits(userId, tx);

  let creditsUsed = 0;
  let remainingToPay = paymentAmount;
  let firstUsageId: string | null = null;

  for (const credit of credits) {
    if (remainingToPay <= 0) break;

    const useAmount = Math.min(credit.remainingAmount, remainingToPay);

    const drawn = await tx.referralCredit.updateMany({
      where: {
        id: credit.id,
        state: "VESTED",
        remainingAmount: { gte: useAmount },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: {
        usedAmount: { increment: useAmount },
        remainingAmount: { decrement: useAmount },
        ...(credit.remainingAmount - useAmount === 0 && { usedAt: now }),
      },
    });
    if (drawn.count !== 1) {
      throw Object.assign(
        new Error(
          `CREDIT_SHORTFALL: credit ${credit.id} changed while it was being redeemed`,
        ),
        { httpStatus: 409, code: "CREDIT_SHORTFALL", retryAfter: 2 },
      );
    }

    // Create ledger entry for accurate per-payment tracking and reversal
    if (paymentId) {
      const usage = await tx.referralCreditUsage.create({
        data: {
          creditId: credit.id,
          paymentId,
          amount: useAmount,
          originalAmount: useAmount,
        },
      });
      firstUsageId ??= usage.id;
      if (credit.vestedAt) {
        await postReferralLiabilityMove(tx, {
          key: `referral-redeem:${usage.id}`,
          direction: "DRAW",
          amountPaise: useAmount,
          description: `Referral credit ${credit.id} redeemed on payment ${paymentId}`,
        });
      }
    }

    creditsUsed += useAmount;
    remainingToPay -= useAmount;
  }

  // One REFERRAL_CREDIT leg per payment (@@unique([paymentId, source])); the
  // usage rows above keep the per-credit trail.
  if (paymentId && firstUsageId && creditsUsed > 0) {
    await tx.paymentLeg.create({
      data: {
        paymentId,
        source: "REFERRAL_CREDIT",
        amountPaise: creditsUsed,
        sourceRef: firstUsageId,
      },
    });
  }

  return { creditsUsed, remainingToPay };
}

/**
 * Reverses referral credits that were consumed for a specific payment.
 * Uses the ReferralCreditUsage ledger for accurate per-payment reversal.
 * Called during refund processing to restore credits to the user.
 *
 * For partial refunds: uses cumulative proportional restoration to avoid
 * rounding drift across multiple partial refunds. Queries the total SUCCEEDED
 * refunds for the payment (including the current one) to compute the cumulative
 * ratio, then restores (cumulativeTarget - alreadyRestored) per usage record.
 * On the final refund (cumulative = original), this guarantees exact restoration.
 * For full refunds: restores all usage and deletes the usage records.
 */
export async function reverseCreditsForPayment(
  paymentId: string,
  tx: Tx,
  refundAmount?: number,
  originalPaymentAmount?: number,
): Promise<number> {
  // Find all usage records for this payment from the ledger. Carry the credit's
  // expiry so we don't restore onto a credit that has since lapsed (REF-2).
  const usageRecords = await tx.referralCreditUsage.findMany({
    where: { paymentId },
    include: {
      credit: { select: { expiresAt: true, state: true, vestedAt: true } },
    },
  });

  if (usageRecords.length === 0) return 0;

  // Determine if this is a partial refund
  const isPartialRefund =
    refundAmount !== null &&
    refundAmount !== undefined &&
    originalPaymentAmount !== null &&
    originalPaymentAmount !== undefined &&
    originalPaymentAmount > 0 &&
    refundAmount < originalPaymentAmount;

  // For partial refunds, query the cumulative SUCCEEDED refund total for this
  // payment (the current refund is already recorded before this function runs).
  // Using cumulative totals instead of per-refund ratios eliminates rounding drift.
  let cumulativeRefunded: number | null = null;
  if (isPartialRefund) {
    const aggregate = await tx.refund.aggregate({
      where: { paymentId, status: "SUCCEEDED" },
      _sum: { amountPaise: true },
    });
    // #780 — aggregates bypass the result extension and still return bigint
    const refundedSum = aggregate._sum?.amountPaise;
    cumulativeRefunded =
      refundedSum === null || refundedSum === undefined
        ? (refundAmount ?? 0)
        : sumPaise(refundedSum);
  }

  let totalRestored = 0;
  let skippedExpired = 0;
  const now = new Date();

  for (const usage of usageRecords) {
    if (usage.amount <= 0) continue;

    // REF-2 (#692) — never resurrect an expired credit. If the credit lapsed
    // after it was applied, restoring remainingAmount onto it just leaves dead
    // balance (getUserCredits filters expiry; the expiry cron re-zeroes it).
    // Skip + log; the usage row stays so the credit reads as still consumed.
    // (Issuing fresh credit on refund-of-expired is a product decision, not done here.)
    // `credit` is a required FK relation that the findMany above always includes,
    // so it is never null here — no optional chain needed.
    const creditExpiresAt = usage.credit.expiresAt;
    if (creditExpiresAt && creditExpiresAt.getTime() < now.getTime()) {
      skippedExpired += usage.amount;
      continue;
    }

    let restoreAmount: number;

    if (isPartialRefund && cumulativeRefunded !== null) {
      // Cumulative proportional approach: compute how much should have been
      // restored in total by now, then subtract what was already restored.
      const cumulativeTarget = Math.round(
        (usage.originalAmount * cumulativeRefunded) / originalPaymentAmount!,
      );
      const alreadyRestored = usage.restoredAmount;
      restoreAmount = Math.min(
        cumulativeTarget - alreadyRestored,
        usage.amount,
      );
    } else {
      // Full refund — restore everything remaining
      restoreAmount = usage.amount;
    }

    if (restoreAmount <= 0) continue;

    // Restore the appropriate amount to the credit
    await tx.referralCredit.update({
      where: { id: usage.creditId },
      data: {
        usedAmount: { decrement: restoreAmount },
        remainingAmount: { increment: restoreAmount },
        ...(restoreAmount >= usage.amount && { usedAt: null }),
      },
    });

    if (usage.credit.vestedAt && usage.credit.state === "VESTED") {
      await postReferralLiabilityMove(tx, {
        key: `referral-restore:${usage.id}:${usage.restoredAmount + restoreAmount}`,
        direction: "RESTORE",
        amountPaise: restoreAmount,
        description: `Referral credit ${usage.creditId} restored from payment ${paymentId}`,
      });
    }

    if (restoreAmount >= usage.amount) {
      // Full restore — remove the usage record
      await tx.referralCreditUsage.delete({
        where: { id: usage.id },
      });
    } else {
      // Partial restore — reduce usage amount and track cumulative restored
      await tx.referralCreditUsage.update({
        where: { id: usage.id },
        data: {
          amount: { decrement: restoreAmount },
          restoredAmount: { increment: restoreAmount },
        },
      });
    }

    totalRestored += restoreAmount;
  }

  if (totalRestored > 0) {
    console.log(
      `🔄 Restored ${totalRestored} referral credits for ${isPartialRefund ? "partially " : ""}refunded payment ${paymentId}`,
    );
  }
  if (skippedExpired > 0) {
    // REF-2 — visibility: credit value (in paise) not returned because the
    // underlying credit had already expired.
    console.log(
      `⏭️  Skipped restoring ${skippedExpired} paise of expired referral credit for refunded payment ${paymentId}`,
    );
  }

  return totalRestored;
}

/**
 * #1771 K-5 — give back at most `amountPaise` of the credit a payment used,
 * oldest usage first, skipping lapsed credits (REF-2). The partial twin of
 * `reverseCreditsForPayment` for a credit-funded class seat, whose Refund rows
 * are ₹0 and so cannot drive the cumulative-refund ratio above.
 */
export async function restoreCreditsForPaymentUpTo(
  paymentId: string,
  tx: Tx,
  amountPaise: number,
): Promise<number> {
  const usages = await tx.referralCreditUsage.findMany({
    where: { paymentId },
    orderBy: { createdAt: "asc" },
    include: {
      credit: { select: { expiresAt: true, state: true, vestedAt: true } },
    },
  });
  const now = Date.now();
  let left = amountPaise;
  let restored = 0;
  for (const usage of usages) {
    if (left <= 0) break;
    const expired =
      usage.credit.expiresAt && usage.credit.expiresAt.getTime() < now;
    if (usage.amount <= 0 || expired) continue;
    const give = Math.min(left, usage.amount);
    if (usage.credit.vestedAt && usage.credit.state === "VESTED") {
      await postReferralLiabilityMove(tx, {
        key: `referral-restore:${usage.id}:${usage.restoredAmount + give}`,
        direction: "RESTORE",
        amountPaise: give,
        description: `Referral credit ${usage.creditId} restored from payment ${paymentId}`,
      });
    }
    await tx.referralCredit.update({
      where: { id: usage.creditId },
      data: {
        usedAmount: { decrement: give },
        remainingAmount: { increment: give },
        ...(give >= usage.amount && { usedAt: null }),
      },
    });
    // Kept at amount 0, never deleted: Σ originalAmount is the seat's value
    // for every later partial return, so it must not shrink.
    await tx.referralCreditUsage.update({
      where: { id: usage.id },
      data: {
        amount: { decrement: give },
        restoredAmount: { increment: give },
      },
    });
    left -= give;
    restored += give;
  }
  return restored;
}

/**
 * Sets a custom vanity code for a user's referral code.
 */
export async function setCustomCode(
  userId: string,
  customCode: string,
): Promise<ReferralCodeRow | null> {
  const referralCode = await prisma.referralCode.findUnique({
    where: { userId },
  });

  if (!referralCode) return null;

  const normalized = customCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.length < 3 || normalized.length > 20) return null;

  // Check uniqueness against both code and customCode fields
  const existing = await prisma.referralCode.findFirst({
    where: {
      OR: [{ code: normalized }, { customCode: normalized }],
      NOT: { id: referralCode.id },
    },
  });
  if (existing) return null;

  return prisma.referralCode.update({
    where: { id: referralCode.id },
    data: { customCode: normalized },
  });
}

/**
 * Gets a user's referral code with stats.
 */
export async function getReferralCode(
  userId: string,
): Promise<ReferralCodeRow | null> {
  return prisma.referralCode.findUnique({
    where: { userId },
  });
}

/**
 * Gets a user's referral list (people they referred).
 */
export async function getUserReferrals(
  userId: string,
): Promise<
  (ReferralRow & { referredUser: { name: string; image: string | null } })[]
> {
  const referralCode = await prisma.referralCode.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!referralCode) return [];

  const rows = await prisma.referral.findMany({
    where: { referralCodeId: referralCode.id },
    include: {
      referredUser: {
        select: { name: true, image: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const cfg = await readReferralProgramConfig();
  if (!cfg) return rows;
  const windowCutoff = new Date(
    Date.now() - cfg.qualifyWindowDays * 24 * 60 * 60 * 1000,
  );
  return rows.map((r) => {
    const isStale = r.status === "SIGNED_UP" && r.signedUpAt < windowCutoff;
    return isStale ? { ...r, status: "EXPIRED" as const } : r;
  });
}

/**
 * Gets a user's full credit history (including used/expired).
 */
export async function getCreditHistory(
  userId: string,
): Promise<ReferralCreditRow[]> {
  return prisma.referralCredit.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

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
import { refundInitiatedByBuyer } from "./refund-cause";

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
  paymentId: string,
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

    creditsUsed += useAmount;
    remainingToPay -= useAmount;
  }

  // One REFERRAL_CREDIT leg per payment (@@unique([paymentId, source])); the
  // usage rows above keep the per-credit trail.
  if (firstUsageId && creditsUsed > 0) {
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

/** The least time a seller-caused refund leaves restored credit spendable. */
const SELLER_REFUND_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;

const restorableCredit = {
  select: {
    expiresAt: true,
    state: true,
    vestedAt: true,
    userId: true,
    currency: true,
    source: true,
    configVersion: true,
  },
} as const;

type RestorableCredit = Pick<
  ReferralCredit,
  | "expiresAt"
  | "state"
  | "vestedAt"
  | "userId"
  | "currency"
  | "source"
  | "configVersion"
>;

/** True when the expert or the platform raised the refund row, not the buyer. */
async function sellerCausedRefund(
  tx: Tx,
  refundRowId: string | undefined,
): Promise<boolean> {
  if (!refundRowId) return false;
  const refund = await tx.refund.findUnique({
    where: { id: refundRowId },
    select: { metadata: true, payment: { select: { userId: true } } },
  });
  return (
    !!refund && !refundInitiatedByBuyer(refund.metadata, refund.payment.userId)
  );
}

function restoreRaced(creditId: string): Error {
  return Object.assign(
    new Error(
      `CREDIT_RESTORE_RACED: credit ${creditId} changed while it was being restored`,
    ),
    { code: "CREDIT_RESTORE_RACED" },
  );
}

/**
 * Gives `give` paise of one usage back. A seller-caused refund keeps the value valid until at
 * least now + 30 days; an EXPIRED credit stays terminal, so the value moves to a new credit.
 */
async function restoreUsageToCredit(
  tx: Tx,
  input: {
    paymentId: string;
    usageId: string;
    creditId: string;
    credit: RestorableCredit;
    restoredBefore: number;
    give: number;
    fullyRestored: boolean;
    sellerCaused: boolean;
    now: Date;
  },
): Promise<void> {
  const { credit, creditId, give, now } = input;
  const key = `referral-restore:${input.usageId}:${input.restoredBefore + give}`;
  const floor = new Date(now.getTime() + SELLER_REFUND_VALIDITY_MS);

  if (credit.state === "EXPIRED") {
    // The old row keeps its breakage and usage trail; amount and usedAmount shrink by what moved.
    const shrunk = await tx.referralCredit.updateMany({
      where: { id: creditId, state: "EXPIRED", usedAmount: { gte: give } },
      data: { amount: { decrement: give }, usedAmount: { decrement: give } },
    });
    if (shrunk.count !== 1) throw restoreRaced(creditId);
    const fresh = await tx.referralCredit.create({
      data: {
        userId: credit.userId,
        amount: give,
        usedAmount: 0,
        remainingAmount: give,
        currency: credit.currency,
        source: credit.source,
        state: "VESTED",
        vestedAt: credit.vestedAt ? now : null,
        expiresAt: floor,
        configVersion: credit.configVersion,
        idempotencyKey: key,
        reason: `Restored from expired credit ${creditId} on refunded payment ${input.paymentId}`,
      },
      select: { id: true },
    });
    if (credit.vestedAt) {
      await postReferralLiabilityMove(tx, {
        key,
        direction: "RESTORE",
        amountPaise: give,
        description: `Referral credit ${fresh.id} restored from expired credit ${creditId} on payment ${input.paymentId}`,
      });
    }
    return;
  }

  const extend =
    input.sellerCaused && credit.expiresAt !== null && credit.expiresAt < floor;
  const moved = await tx.referralCredit.updateMany({
    where: { id: creditId, state: credit.state, expiresAt: credit.expiresAt },
    data: {
      usedAmount: { decrement: give },
      remainingAmount: { increment: give },
      ...(input.fullyRestored && { usedAt: null }),
      ...(extend && { expiresAt: floor }),
    },
  });
  if (moved.count !== 1) throw restoreRaced(creditId);
  if (credit.vestedAt && credit.state === "VESTED") {
    await postReferralLiabilityMove(tx, {
      key,
      direction: "RESTORE",
      amountPaise: give,
      description: `Referral credit ${creditId} restored from payment ${input.paymentId}`,
    });
  }
}

/** A lapsed credit is restored only when the expert or the platform caused the refund. */
function restorable(
  credit: RestorableCredit,
  sellerCaused: boolean,
  now: Date,
): boolean {
  const lapsed =
    credit.state === "EXPIRED" ||
    (credit.expiresAt !== null && credit.expiresAt < now);
  return sellerCaused || !lapsed;
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
 * `refundRowId` classifies the refund's cause; payment-failure restores omit it.
 */
export async function reverseCreditsForPayment(
  paymentId: string,
  tx: Tx,
  refundAmount?: number,
  originalPaymentAmount?: number,
  refundRowId?: string,
): Promise<number> {
  const usageRecords = await tx.referralCreditUsage.findMany({
    where: { paymentId },
    include: { credit: restorableCredit },
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

  const sellerCaused = await sellerCausedRefund(tx, refundRowId);
  let totalRestored = 0;
  let skippedExpired = 0;
  const now = new Date();

  for (const usage of usageRecords) {
    if (usage.amount <= 0) continue;

    // A lapsed credit stays consumed on a buyer cancel; the usage row is kept.
    if (!restorable(usage.credit, sellerCaused, now)) {
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

    await restoreUsageToCredit(tx, {
      paymentId,
      usageId: usage.id,
      creditId: usage.creditId,
      credit: usage.credit,
      restoredBefore: usage.restoredAmount,
      give: restoreAmount,
      fullyRestored: restoreAmount >= usage.amount,
      sellerCaused,
      now,
    });

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
    console.log(
      `⏭️  Skipped restoring ${skippedExpired} paise of expired referral credit for refunded payment ${paymentId}`,
    );
  }

  return totalRestored;
}

/**
 * Gives back at most `amountPaise` of the credit a payment used, oldest usage first. The
 * partial twin of `reverseCreditsForPayment` for a credit-funded class seat, whose Refund rows
 * are ₹0 and so cannot drive the cumulative-refund ratio above.
 */
export async function restoreCreditsForPaymentUpTo(
  paymentId: string,
  tx: Tx,
  amountPaise: number,
  refundRowId: string,
): Promise<number> {
  const usages = await tx.referralCreditUsage.findMany({
    where: { paymentId },
    orderBy: { createdAt: "asc" },
    include: { credit: restorableCredit },
  });
  const sellerCaused = await sellerCausedRefund(tx, refundRowId);
  const now = new Date();
  let left = amountPaise;
  let restored = 0;
  for (const usage of usages) {
    if (left <= 0) break;
    if (usage.amount <= 0 || !restorable(usage.credit, sellerCaused, now)) {
      continue;
    }
    const give = Math.min(left, usage.amount);
    await restoreUsageToCredit(tx, {
      paymentId,
      usageId: usage.id,
      creditId: usage.creditId,
      credit: usage.credit,
      restoredBefore: usage.restoredAmount,
      give,
      fullyRestored: give >= usage.amount,
      sellerCaused,
      now,
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

import prisma from "@/lib/prisma";
import { Prisma as PrismaNamespace } from "@prisma/client";
import type {
  ReferralCode,
  Referral,
  ReferralCredit,
  Prisma,
} from "@prisma/client";

// Constants
const DEFAULT_REFERRER_REWARD = 50000; // ₹500 in paise
const DEFAULT_REFEREE_REWARD = 20000; // ₹200 in paise
const QUALIFICATION_WINDOW_DAYS = 30;
const CREDIT_EXPIRY_MONTHS = 6;
const SERIALIZABLE_MAX_RETRIES = 3;

/**
 * Retries a function that may fail due to Prisma serialization conflicts (P2034).
 * Applies exponential backoff between retries.
 */
async function withSerializableRetry<T>(
  fn: () => Promise<T>,
  maxRetries = SERIALIZABLE_MAX_RETRIES,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isSerializationFailure =
        error instanceof PrismaNamespace.PrismaClientKnownRequestError &&
        error.code === "P2034";

      if (!isSerializationFailure || attempt === maxRetries) {
        throw error;
      }

      const backoffMs = 50 * 2 ** attempt; // 50ms, 100ms, 200ms
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error("withSerializableRetry: exhausted retries");
}

/**
 * Creates or returns an existing referral code for a user.
 */
export async function createReferralCode(
  userId: string,
): Promise<ReferralCode> {
  const existing = await prisma.referralCode.findUnique({
    where: { userId },
  });

  if (existing) return existing;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });

  const code = await generateUniqueCode(user?.name);

  return prisma.referralCode.create({
    data: {
      userId,
      code,
      referrerReward: DEFAULT_REFERRER_REWARD,
      refereeReward: DEFAULT_REFEREE_REWARD,
    },
  });
}

/**
 * Generates a unique referral code, trying name-based first, then random fallback.
 */
export async function generateUniqueCode(
  name?: string | null,
): Promise<string> {
  if (name) {
    const baseCode = name
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 6);

    if (baseCode.length >= 3) {
      for (let i = 0; i < 100; i++) {
        const code = i === 0 ? baseCode : `${baseCode}${i}`;
        const exists = await prisma.referralCode.findUnique({
          where: { code },
        });
        if (!exists) return code;
      }
    }
  }

  // Fallback to random code
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
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
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ReferralCode | null> {
  return db.referralCode.findFirst({
    where: {
      OR: [{ code: code.toUpperCase() }, { customCode: code.toUpperCase() }],
      isActive: true,
    },
  });
}

/**
 * Applies a referral code to a newly signed-up user.
 * Creates the Referral record and gives the referee their welcome bonus.
 */
/**
 * FIX #8: Uses Serializable isolation to prevent concurrent code applications
 * from exceeding the maxReferrals cap.
 */
export async function applyReferralCode(
  newUserId: string,
  code: string,
): Promise<Referral | null> {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // Validate inside transaction to prevent TOCTOU race conditions
        const referralCode = await validateReferralCode(code, tx);
        if (!referralCode) return null;

        // Can't refer yourself
        if (referralCode.userId === newUserId) return null;

        // Check if max referrals cap reached
        if (referralCode.totalReferrals >= referralCode.maxReferrals)
          return null;

        // Check if already referred
        const existingReferral = await tx.referral.findUnique({
          where: { referredUserId: newUserId },
        });
        if (existingReferral) return null;

        const ref = await tx.referral.create({
          data: {
            referralCodeId: referralCode.id,
            referredUserId: newUserId,
            status: "SIGNED_UP",
            referrerRewardAmount:
              referralCode.referrerReward ?? DEFAULT_REFERRER_REWARD,
            refereeRewardAmount:
              referralCode.refereeReward ?? DEFAULT_REFEREE_REWARD,
          },
        });

        await tx.referralCode.update({
          where: { id: referralCode.id },
          data: { totalReferrals: { increment: 1 } },
        });

        // Give referee immediate welcome bonus
        const refereeReward = ref.refereeRewardAmount;
        if (refereeReward && refereeReward > 0) {
          const expiresAt = new Date();
          expiresAt.setMonth(expiresAt.getMonth() + CREDIT_EXPIRY_MONTHS);

          await tx.referralCredit.create({
            data: {
              userId: newUserId,
              amount: refereeReward,
              currency: "INR",
              source: "REFEREE_BONUS",
              referralId: ref.id,
              remainingAmount: refereeReward,
              expiresAt,
            },
          });
        }

        return ref;
      },
      {
        isolationLevel: "Serializable",
        timeout: 10000,
      },
    ),
  );
}

/**
 * Called after a user's first paid booking to qualify their referral.
 * Rewards the referrer if the referral is within the qualification window.
 * FIX #7: Entire flow runs in a serializable transaction with conditional status guard
 * to prevent duplicate rewards from concurrent webhook execution.
 */
export async function processQualifyingAction(
  userId: string,
  action: string,
): Promise<void> {
  await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // Read referral INSIDE transaction to prevent TOCTOU race
        const referral = await tx.referral.findUnique({
          where: { referredUserId: userId },
          include: { referralCode: true },
        });

        if (!referral || referral.status !== "SIGNED_UP") return;

        // Check if within qualification window
        const daysSinceSignup = Math.floor(
          (Date.now() - referral.signedUpAt.getTime()) / (1000 * 60 * 60 * 24),
        );

        if (daysSinceSignup > QUALIFICATION_WINDOW_DAYS) {
          await tx.referral.update({
            where: { id: referral.id },
            data: { status: "EXPIRED" },
          });
          return;
        }

        // Conditional update: only succeeds if status is still SIGNED_UP.
        // This prevents concurrent calls from both creating rewards.
        const updated = await tx.referral.updateMany({
          where: { id: referral.id, status: "SIGNED_UP" },
          data: {
            status: "REWARDED",
            qualifiedAt: new Date(),
            qualifyingAction: action,
            referrerRewardPaidAt: new Date(),
          },
        });

        // If no rows updated, another concurrent call already processed this
        if (updated.count === 0) return;

        // Give referrer their bonus
        const referrerReward = referral.referrerRewardAmount;
        if (referrerReward && referrerReward > 0) {
          const expiresAt = new Date();
          expiresAt.setMonth(expiresAt.getMonth() + CREDIT_EXPIRY_MONTHS);

          await tx.referralCredit.create({
            data: {
              userId: referral.referralCode.userId,
              amount: referrerReward,
              currency: "INR",
              source: "REFERRAL_BONUS",
              referralId: referral.id,
              remainingAmount: referrerReward,
              expiresAt,
            },
          });

          // Update referral code stats
          await tx.referralCode.update({
            where: { id: referral.referralCodeId },
            data: {
              successfulReferrals: { increment: 1 },
              totalEarned: { increment: referrerReward },
            },
          });
        }
      },
      {
        isolationLevel: "Serializable",
        timeout: 10000,
      },
    ),
  );
}

/**
 * Returns the user's available (non-expired, non-fully-used) credit balance.
 */
export async function getUserCredits(
  userId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{
  totalAvailable: number;
  credits: ReferralCredit[];
}> {
  const credits = await db.referralCredit.findMany({
    where: {
      userId,
      remainingAmount: { gt: 0 },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: { expiresAt: "asc" },
  });

  const totalAvailable = credits.reduce((sum, c) => sum + c.remainingAmount, 0);

  return { totalAvailable, credits };
}

/**
 * Applies referral credits to a payment at checkout.
 * Uses FIFO ordering by expiry date (expiring soonest first).
 * Creates per-payment usage records in ReferralCreditUsage ledger for accurate reversal.
 * Returns the total credits used and the remaining amount to pay.
 */
export async function applyCreditsToPayment(
  userId: string,
  paymentAmount: number,
  tx: Prisma.TransactionClient,
  paymentId?: string,
): Promise<{ creditsUsed: number; remainingToPay: number }> {
  const { credits } = await getUserCredits(userId, tx);

  let creditsUsed = 0;
  let remainingToPay = paymentAmount;

  for (const credit of credits) {
    if (remainingToPay <= 0) break;

    const useAmount = Math.min(credit.remainingAmount, remainingToPay);

    await tx.referralCredit.update({
      where: { id: credit.id },
      data: {
        usedAmount: { increment: useAmount },
        remainingAmount: { decrement: useAmount },
        ...(credit.remainingAmount - useAmount === 0 && {
          usedAt: new Date(),
        }),
      },
    });

    // Create ledger entry for accurate per-payment tracking and reversal
    if (paymentId) {
      await tx.referralCreditUsage.create({
        data: {
          creditId: credit.id,
          paymentId,
          amount: useAmount,
          originalAmount: useAmount,
        },
      });
    }

    creditsUsed += useAmount;
    remainingToPay -= useAmount;
  }

  return { creditsUsed, remainingToPay };
}

/**
 * Reverses referral credits that were consumed for a specific payment.
 * Uses the ReferralCreditUsage ledger for accurate per-payment reversal.
 * Called during refund processing to restore credits to the user.
 *
 * For partial refunds: restores a proportional fraction of each usage record
 * (refundAmount / originalPaymentAmount) and reduces the usage amount accordingly.
 * For full refunds: restores all usage and deletes the usage records.
 */
export async function reverseCreditsForPayment(
  paymentId: string,
  tx: Prisma.TransactionClient,
  refundAmount?: number,
  originalPaymentAmount?: number,
): Promise<number> {
  // Find all usage records for this payment from the ledger
  const usageRecords = await tx.referralCreditUsage.findMany({
    where: { paymentId },
  });

  if (usageRecords.length === 0) return 0;

  // Determine if this is a partial refund
  const isPartialRefund =
    refundAmount != null &&
    originalPaymentAmount != null &&
    originalPaymentAmount > 0 &&
    refundAmount < originalPaymentAmount;

  const refundRatio = isPartialRefund
    ? refundAmount / originalPaymentAmount
    : 1;

  let totalRestored = 0;

  for (const usage of usageRecords) {
    if (usage.amount <= 0) continue;

    const restoreAmount = isPartialRefund
      ? Math.min(Math.round(usage.originalAmount * refundRatio), usage.amount)
      : usage.amount;

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

    if (restoreAmount >= usage.amount) {
      // Full restore — remove the usage record
      await tx.referralCreditUsage.delete({
        where: { id: usage.id },
      });
    } else {
      // Partial restore — reduce the usage record amount
      await tx.referralCreditUsage.update({
        where: { id: usage.id },
        data: { amount: { decrement: restoreAmount } },
      });
    }

    totalRestored += restoreAmount;
  }

  if (totalRestored > 0) {
    console.log(
      `🔄 Restored ${totalRestored} referral credits for ${isPartialRefund ? "partially " : ""}refunded payment ${paymentId}`,
    );
  }

  return totalRestored;
}

/**
 * Sets a custom vanity code for a user's referral code.
 */
export async function setCustomCode(
  userId: string,
  customCode: string,
): Promise<ReferralCode | null> {
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
): Promise<ReferralCode | null> {
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
  (Referral & { referredUser: { name: string; image: string | null } })[]
> {
  const referralCode = await prisma.referralCode.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!referralCode) return [];

  return prisma.referral.findMany({
    where: { referralCodeId: referralCode.id },
    include: {
      referredUser: {
        select: { name: true, image: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Gets a user's full credit history (including used/expired).
 */
export async function getCreditHistory(
  userId: string,
): Promise<ReferralCredit[]> {
  return prisma.referralCredit.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Expires unqualified referrals that are past the qualification window.
 * Called by cron job.
 */
export async function expireStaleReferrals(): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - QUALIFICATION_WINDOW_DAYS);

  const result = await prisma.referral.updateMany({
    where: {
      status: "SIGNED_UP",
      signedUpAt: { lt: cutoffDate },
    },
    data: { status: "EXPIRED" },
  });

  return result.count;
}

/**
 * Expires credits that are past their expiry date.
 * Called by cron job.
 */
export async function expireStaleCredits(): Promise<number> {
  const result = await prisma.referralCredit.updateMany({
    where: {
      remainingAmount: { gt: 0 },
      expiresAt: { lt: new Date() },
    },
    data: { remainingAmount: 0 },
  });

  return result.count;
}

import prisma from "@/lib/prisma";
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
      OR: [
        { code: code.toUpperCase() },
        { customCode: code.toUpperCase() },
      ],
      isActive: true,
    },
  });
}

/**
 * Applies a referral code to a newly signed-up user.
 * Creates the Referral record and gives the referee their welcome bonus.
 */
export async function applyReferralCode(
  newUserId: string,
  code: string,
): Promise<Referral | null> {
  return prisma.$transaction(async (tx) => {
    // Validate inside transaction to prevent TOCTOU race conditions
    const referralCode = await validateReferralCode(code, tx);
    if (!referralCode) return null;

    // Can't refer yourself
    if (referralCode.userId === newUserId) return null;

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
  });
}

/**
 * Called after a user's first paid booking to qualify their referral.
 * Rewards the referrer if the referral is within the qualification window.
 */
export async function processQualifyingAction(
  userId: string,
  action: string,
): Promise<void> {
  const referral = await prisma.referral.findUnique({
    where: { referredUserId: userId },
    include: { referralCode: true },
  });

  if (!referral || referral.status !== "SIGNED_UP") return;

  // Check if within qualification window
  const daysSinceSignup = Math.floor(
    (Date.now() - referral.signedUpAt.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (daysSinceSignup > QUALIFICATION_WINDOW_DAYS) {
    await prisma.referral.update({
      where: { id: referral.id },
      data: { status: "EXPIRED" },
    });
    return;
  }

  // Mark as qualified and reward referrer in a transaction
  await prisma.$transaction(async (tx) => {
    await tx.referral.update({
      where: { id: referral.id },
      data: {
        status: "REWARDED",
        qualifiedAt: new Date(),
        qualifyingAction: action,
        referrerRewardPaidAt: new Date(),
      },
    });

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
  });
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
 * Returns the total credits used and the remaining amount to pay.
 */
export async function applyCreditsToPayment(
  userId: string,
  paymentAmount: number,
  tx: Prisma.TransactionClient,
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

    creditsUsed += useAmount;
    remainingToPay -= useAmount;
  }

  return { creditsUsed, remainingToPay };
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
export async function getUserReferrals(userId: string): Promise<
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

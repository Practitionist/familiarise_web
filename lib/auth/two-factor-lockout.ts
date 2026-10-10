import type { PrismaLike } from "@/lib/prisma";

/** Same budget as the twoFactor plugin's account lockout (its defaults). */
export const TWO_FACTOR_MAX_FAILED_ATTEMPTS = 10;
export const TWO_FACTOR_LOCK_MS = 15 * 60 * 1000;

/**
 * Account lockout for second-factor checks made with a live session (step-up).
 * The plugin only counts failures for pending sign-in challenges, so a session
 * holder would otherwise get unlimited guesses. Shares the plugin's columns, so
 * sign-in and step-up failures draw down one budget.
 */
export async function isTwoFactorLocked(
  db: PrismaLike,
  userId: string,
  now = new Date(),
): Promise<boolean> {
  const row = await db.twoFactor.findUnique({
    where: { userId },
    select: { lockedUntil: true },
  });
  return !!row?.lockedUntil && row.lockedUntil.getTime() > now.getTime();
}

/** Counts one wrong code; locks the account once the budget is spent. */
export async function recordTwoFactorFailure(
  db: PrismaLike,
  userId: string,
  now = new Date(),
): Promise<void> {
  const row = await db.twoFactor.update({
    where: { userId },
    data: { failedVerificationCount: { increment: 1 } },
    select: { failedVerificationCount: true },
  });
  if (row.failedVerificationCount >= TWO_FACTOR_MAX_FAILED_ATTEMPTS) {
    await db.twoFactor.updateMany({
      where: {
        userId,
        failedVerificationCount: { gte: TWO_FACTOR_MAX_FAILED_ATTEMPTS },
      },
      data: {
        lockedUntil: new Date(now.getTime() + TWO_FACTOR_LOCK_MS),
        failedVerificationCount: 0,
      },
    });
  }
}

/** A correct code resets the consecutive-failure count. */
export async function resetTwoFactorFailures(
  db: PrismaLike,
  userId: string,
): Promise<void> {
  await db.twoFactor.updateMany({
    where: { userId },
    data: { failedVerificationCount: 0 },
  });
}

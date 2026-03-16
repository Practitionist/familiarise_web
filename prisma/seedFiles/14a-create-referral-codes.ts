import { faker } from "@faker-js/faker";
import prisma from "../../lib/prisma";

/**
 * Creates referral codes for seed users and some sample referrals + credits.
 */
export async function createReferralCodes() {
  console.log("Creating referral codes...");

  // Get all users
  const users = await prisma.user.findMany({
    select: { id: true, name: true },
    take: 30,
  });

  if (users.length === 0) {
    console.log("No users found. Skipping referral codes.");
    return;
  }

  let codesCreated = 0;
  let referralsCreated = 0;
  let creditsCreated = 0;

  // Create referral codes for ~60% of users
  const usersWithCodes = users.slice(0, Math.ceil(users.length * 0.6));

  for (const user of usersWithCodes) {
    try {
      const namePart = (user.name ?? "user")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 8);
      const code = `${namePart}${faker.string.alphanumeric(4).toLowerCase()}`;

      await prisma.referralCode.create({
        data: {
          userId: user.id,
          code,
          referrerReward: 50000, // 500 INR
          refereeReward: 20000, // 200 INR
          isActive: true,
        },
      });
      codesCreated++;
    } catch {
      // Skip if user already has a referral code (unique constraint)
    }
  }

  // Create some referrals between users
  const referralCodes = await prisma.referralCode.findMany({
    take: 10,
  });

  const usersWithoutCodes = users.filter(
    (u) => !usersWithCodes.some((wc) => wc.id === u.id),
  );

  for (
    let i = 0;
    i < Math.min(referralCodes.length, usersWithoutCodes.length);
    i++
  ) {
    try {
      const status = faker.helpers.arrayElement([
        "SIGNED_UP",
        "QUALIFIED",
        "REWARDED",
      ] as const);

      await prisma.referral.create({
        data: {
          referralCodeId: referralCodes[i].id,
          referredUserId: usersWithoutCodes[i].id,
          status,
          ...(status === "QUALIFIED" || status === "REWARDED"
            ? {
                qualifiedAt: faker.date.recent({ days: 14 }),
                qualifyingAction: "first_paid_booking",
              }
            : {}),
          ...(status === "REWARDED"
            ? {
                referrerRewardAmount: 50000,
                refereeRewardAmount: 20000,
              }
            : {}),
        },
      });
      referralsCreated++;
    } catch {
      // Skip duplicates
    }
  }

  // Create some referral credits for users who earned rewards
  const rewardedReferrals = await prisma.referral.findMany({
    where: { status: "REWARDED" },
    include: { referralCode: true },
  });

  for (const referral of rewardedReferrals) {
    try {
      // Credit for referrer
      await prisma.referralCredit.create({
        data: {
          userId: referral.referralCode.userId,
          amount: 50000,
          remainingAmount: faker.helpers.arrayElement([50000, 30000, 0]),
          currency: "INR",
          source: "REFERRAL_BONUS",
          expiresAt: faker.date.future({ years: 0.5 }),
        },
      });
      creditsCreated++;

      // Credit for referee
      await prisma.referralCredit.create({
        data: {
          userId: referral.referredUserId,
          amount: 20000,
          remainingAmount: faker.helpers.arrayElement([20000, 10000, 0]),
          currency: "INR",
          source: "REFEREE_BONUS",
          expiresAt: faker.date.future({ years: 0.5 }),
        },
      });
      creditsCreated++;
    } catch {
      // Skip
    }
  }

  console.log(
    `Created ${codesCreated} referral codes, ${referralsCreated} referrals, ${creditsCreated} credits`,
  );
}

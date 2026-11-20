/** What a checkout consumed (referral credit, code use, programme engagement), seeded and read back. */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { recordBookingUtilization } from "../../../lib/api/organizations/program-helpers";

const DAY_MS = 24 * 3_600_000;
export const CREDIT_PAISE = 20_000;

/** A member's licensed-seat assignment with no cap: one engagement per booking. */
async function seedAssignment(userId: string) {
  const org = await prisma.organization.create({
    data: { name: "Database tier org", slug: `db-tier-${randomUUID()}` },
  });
  const account = await prisma.billingAccount.create({
    data: {
      ownerOrgId: org.id,
      billingEmail: `${randomUUID()}@db-tier.example.invalid`,
      fundingSource: "LICENSE",
    },
  });
  const contract = await prisma.contract.create({
    data: {
      organizationId: org.id,
      billingAccountId: account.id,
      effectiveFrom: new Date(Date.now() - DAY_MS),
    },
  });
  const program = await prisma.program.create({
    data: { contractId: contract.id, type: "LICENSED_SEAT", name: "Seat" },
  });
  const membership = await prisma.membership.create({
    data: { userId, organizationId: org.id, role: "LEARNER" },
  });
  return prisma.programAssignment.create({
    data: {
      programId: program.id,
      membershipId: membership.id,
      periodStart: new Date(Date.now() - DAY_MS),
      periodEnd: new Date(Date.now() + 30 * DAY_MS),
    },
  });
}

/** The payment's checkout spent ₹200 of referral credit, one code use and one engagement. */
export async function seedCheckoutConsumption(
  userId: string,
  paymentId: string,
  pricePaise: number,
) {
  const credit = await prisma.referralCredit.create({
    data: {
      userId,
      amount: BigInt(CREDIT_PAISE),
      usedAmount: BigInt(CREDIT_PAISE),
      remainingAmount: BigInt(0),
      source: "REFEREE_BONUS",
      state: "VESTED",
      vestedAt: new Date(),
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 90 * DAY_MS),
      idempotencyKey: `dbtier-credit:${randomUUID()}`,
    },
  });
  await prisma.referralCreditUsage.create({
    data: {
      creditId: credit.id,
      paymentId,
      amount: BigInt(CREDIT_PAISE),
      originalAmount: BigInt(CREDIT_PAISE),
    },
  });
  const code = await prisma.discountCode.create({
    data: {
      code: `DBTIER-${randomUUID().slice(0, 8)}`,
      description: "db tier",
      discountType: "PERCENTAGE",
      discountValue: 10,
      maxUses: 5,
      currentUses: 1,
    },
  });
  await prisma.payment.update({
    where: { id: paymentId },
    data: { discountCodeId: code.id },
  });
  const assignment = await seedAssignment(userId);
  await prisma.$transaction((tx) =>
    recordBookingUtilization(tx, {
      programAssignmentId: assignment.id,
      paymentId,
      engagementsConsumed: 1,
      priceAtBookingPaise: pricePaise,
    }),
  );
  return {
    paymentId,
    creditId: credit.id,
    codeId: code.id,
    assignmentId: assignment.id,
  };
}

export type SeededConsumption = Awaited<
  ReturnType<typeof seedCheckoutConsumption>
>;

/** The buyer's and the organisation's view of what the checkout still holds. */
export async function consumedBy(seeded: SeededConsumption) {
  const credit = await prisma.referralCredit.findUniqueOrThrow({
    where: { id: seeded.creditId },
    select: { remainingAmount: true, usedAmount: true },
  });
  const usages = await prisma.referralCreditUsage.count({
    where: { paymentId: seeded.paymentId },
  });
  const code = await prisma.discountCode.findUniqueOrThrow({
    where: { id: seeded.codeId },
    select: { currentUses: true },
  });
  const assignment = await prisma.programAssignment.findUniqueOrThrow({
    where: { id: seeded.assignmentId },
    select: { engagementsUsed: true },
  });
  return {
    credit: {
      remaining: Number(credit.remainingAmount),
      used: Number(credit.usedAmount),
      usages,
    },
    codeUses: code.currentUses,
    engagementsUsed: assignment.engagementsUsed,
  };
}

export const RETURNED = {
  credit: { remaining: CREDIT_PAISE, used: 0, usages: 0 },
  codeUses: 0,
  engagementsUsed: 0,
};
export const STILL_SPENT = {
  credit: { remaining: 0, used: CREDIT_PAISE, usages: 1 },
  codeUses: 1,
  engagementsUsed: 1,
};

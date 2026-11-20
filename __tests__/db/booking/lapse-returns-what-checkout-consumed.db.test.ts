/**
 * A lapsed approved request gives back what its open order's checkout consumed
 * (the referral credit, the discount-code use and the programme engagement),
 * through the real lapse callers on real Postgres:
 *  - the pay-link sweep and the consultant's Withdraw each return all three;
 *  - a request whose order was captured, or is already EXPIRED, returns none;
 *  - a second lapse, sequential or concurrent, returns nothing more.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { seedConsultee, seedHost, seedOneToOne } from "./harness";

jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(),
  cancelPaymentIntent: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/booking/expiry-notices", () => ({
  __esModule: true,
  notifyConsulteeRequestExpired: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === "then" ? undefined : prop === "__esModule" ? true : noop,
    },
  );
});
jest.mock("../../../lib/email", () => {
  const noop = jest.fn(async () => ({ success: true }));
  return new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === "then" ? undefined : prop === "__esModule" ? true : noop,
    },
  );
});

import {
  lapseApprovedRequest,
  withdrawApproval,
} from "../../../lib/booking/lapse-approved-request";
import { cleanupExpiredApprovalPendingPayments } from "../../../scripts/payments/cleanup-abandoned-payments";
import { recordBookingUtilization } from "../../../lib/api/organizations/program-helpers";

const MIN = 60_000;
const CREDIT_PAISE = 20_000;
const PRICE_PAISE = 80_000;

type PaymentStatusSeed = "PENDING" | "SUCCEEDED" | "EXPIRED";

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
      effectiveFrom: new Date(Date.now() - 24 * 60 * MIN),
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
      periodStart: new Date(Date.now() - 24 * 60 * MIN),
      periodEnd: new Date(Date.now() + 30 * 24 * 60 * MIN),
    },
  });
}

/**
 * An approved, unpaid request whose order used ₹200 of the buyer's referral
 * credit, one use of a discount code and one engagement of a programme seat.
 */
async function seedApprovedWithCredit(status: PaymentStatusSeed) {
  const host = await seedHost();
  const consultee = await seedConsultee();
  const startsAt = new Date(Date.now() + 3 * 24 * 60 * MIN);
  startsAt.setUTCMinutes(0, 0, 0);
  const request = await seedOneToOne(
    "consultation",
    host,
    consultee,
    { startsAt, endsAt: new Date(startsAt.getTime() + 60 * MIN) },
    {
      status: "APPROVED_PENDING_PAYMENT",
      bookingSource: "REQUEST_SUBMITTED",
      isTentative: true,
      // Lapsed: the sweep's cohort reads a PENDING order past its window.
      payment: {
        status,
        amount: PRICE_PAISE,
        expiresAt: new Date(Date.now() - MIN),
      },
    },
  );
  const credit = await prisma.referralCredit.create({
    data: {
      userId: consultee.userId,
      amount: BigInt(CREDIT_PAISE),
      usedAmount: BigInt(CREDIT_PAISE),
      remainingAmount: BigInt(0),
      source: "REFEREE_BONUS",
      state: "VESTED",
      vestedAt: new Date(),
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * MIN),
      idempotencyKey: `dbtier-credit:${randomUUID()}`,
    },
  });
  await prisma.referralCreditUsage.create({
    data: {
      creditId: credit.id,
      paymentId: request.payment!.id,
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
    where: { id: request.payment!.id },
    data: { discountCodeId: code.id },
  });
  const assignment = await seedAssignment(consultee.userId);
  await prisma.$transaction((tx) =>
    recordBookingUtilization(tx, {
      programAssignmentId: assignment.id,
      paymentId: request.payment!.id,
      engagementsConsumed: 1,
      priceAtBookingPaise: PRICE_PAISE,
    }),
  );
  return {
    host,
    consultee,
    request,
    creditId: credit.id,
    codeId: code.id,
    assignmentId: assignment.id,
  };
}

type Seeded = Awaited<ReturnType<typeof seedApprovedWithCredit>>;

/** What the order's checkout consumed, as the buyer and the organisation read it. */
async function consumed(seeded: Seeded) {
  const paymentId = seeded.request.payment!.id;
  const credit = await prisma.referralCredit.findUniqueOrThrow({
    where: { id: seeded.creditId },
    select: { remainingAmount: true, usedAmount: true },
  });
  const usages = await prisma.referralCreditUsage.count({
    where: { paymentId },
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

const RETURNED = {
  credit: { remaining: CREDIT_PAISE, used: 0, usages: 0 },
  codeUses: 0,
  engagementsUsed: 0,
};
const STILL_SPENT = {
  credit: { remaining: 0, used: CREDIT_PAISE, usages: 1 },
  codeUses: 1,
  engagementsUsed: 1,
};

const passthroughLock = <T>(_id: string, fn: (lock: unknown) => Promise<T>) =>
  fn(null);
const withdrawBy = (seeded: Seeded) =>
  withdrawApproval({
    id: seeded.request.consultationId!,
    actor: {
      userId: seeded.host.userId,
      consultantProfileId: seeded.host.consultantProfileId,
      privileged: false,
    },
    lock: passthroughLock,
    renewLock: async () => undefined,
  });

describe("a lapsed approved request returns what its order's checkout consumed", () => {
  it("the pay-link sweep returns it once, however often it runs", async () => {
    const seeded = await seedApprovedWithCredit("PENDING");

    const first = await cleanupExpiredApprovalPendingPayments();
    const second = await cleanupExpiredApprovalPendingPayments();

    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(await consumed(seeded)).toEqual(RETURNED);
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: seeded.request.payment!.id },
      select: { paymentStatus: true },
    });
    expect(payment.paymentStatus).toBe("EXPIRED");
  }, 30_000);

  it("the consultant's Withdraw returns it", async () => {
    const seeded = await seedApprovedWithCredit("PENDING");
    await expect(withdrawBy(seeded)).resolves.toEqual({ status: "CANCELLED" });
    expect(await consumed(seeded)).toEqual(RETURNED);
  }, 30_000);

  it("two concurrent lapses of one request return it once", async () => {
    const seeded = await seedApprovedWithCredit("PENDING");
    const lapse = () =>
      prisma.$transaction((tx) =>
        lapseApprovedRequest(tx, {
          kind: "consultation",
          id: seeded.request.consultationId!,
          reason: "PAYMENT_LAPSED",
          actorUserId: null,
        }),
      );
    const outcomes = await Promise.all([lapse(), lapse()]);
    expect(outcomes.map((o) => o.moved).sort()).toEqual([0, 1]);
    expect(await consumed(seeded)).toEqual(RETURNED);
  }, 30_000);

  it("a captured order keeps everything spent: the request does not lapse", async () => {
    const seeded = await seedApprovedWithCredit("SUCCEEDED");
    await expect(withdrawBy(seeded)).rejects.toMatchObject({
      code: "REQUEST_CHANGED_ELSEWHERE",
    });
    expect(await consumed(seeded)).toEqual(STILL_SPENT);
  }, 30_000);

  it("an order already EXPIRED is not claimed again, so the lapse returns nothing of it", async () => {
    const seeded = await seedApprovedWithCredit("EXPIRED");
    await expect(withdrawBy(seeded)).resolves.toEqual({ status: "CANCELLED" });
    expect(await consumed(seeded)).toEqual(STILL_SPENT);
  }, 30_000);
});

/**
 * A lapsed approved request gives the buyer back the referral credit its open
 * order used, through the real lapse callers on real Postgres:
 *  - the pay-link sweep and the consultant's Withdraw each return it;
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

const MIN = 60_000;
const CREDIT_PAISE = 20_000;
const PRICE_PAISE = 80_000;

type PaymentStatusSeed = "PENDING" | "SUCCEEDED" | "EXPIRED";

/** An approved, unpaid request whose order used ₹200 of the buyer's referral credit. */
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
  return { host, consultee, request, creditId: credit.id };
}

async function creditState(creditId: string, paymentId: string) {
  const credit = await prisma.referralCredit.findUniqueOrThrow({
    where: { id: creditId },
    select: { remainingAmount: true, usedAmount: true },
  });
  const usages = await prisma.referralCreditUsage.count({
    where: { paymentId },
  });
  return {
    remaining: Number(credit.remainingAmount),
    used: Number(credit.usedAmount),
    usages,
  };
}

const RETURNED = { remaining: CREDIT_PAISE, used: 0, usages: 0 };
const STILL_SPENT = { remaining: 0, used: CREDIT_PAISE, usages: 1 };

const passthroughLock = <T>(_id: string, fn: (lock: unknown) => Promise<T>) =>
  fn(null);
const withdrawBy = (
  seeded: Awaited<ReturnType<typeof seedApprovedWithCredit>>,
) =>
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

describe("a lapsed approved request returns its referral credit", () => {
  it("the pay-link sweep returns the credit once, however often it runs", async () => {
    const seeded = await seedApprovedWithCredit("PENDING");
    const paymentId = seeded.request.payment!.id;

    const first = await cleanupExpiredApprovalPendingPayments();
    const second = await cleanupExpiredApprovalPendingPayments();

    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(await creditState(seeded.creditId, paymentId)).toEqual(RETURNED);
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { paymentStatus: true },
    });
    expect(payment.paymentStatus).toBe("EXPIRED");
  }, 30_000);

  it("the consultant's Withdraw returns the credit", async () => {
    const seeded = await seedApprovedWithCredit("PENDING");
    await expect(withdrawBy(seeded)).resolves.toEqual({ status: "CANCELLED" });
    expect(
      await creditState(seeded.creditId, seeded.request.payment!.id),
    ).toEqual(RETURNED);
  }, 30_000);

  it("two concurrent lapses of one request return the credit once", async () => {
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
    expect(
      await creditState(seeded.creditId, seeded.request.payment!.id),
    ).toEqual(RETURNED);
  }, 30_000);

  it("a captured order keeps its credit spent: the request does not lapse", async () => {
    const seeded = await seedApprovedWithCredit("SUCCEEDED");
    await expect(withdrawBy(seeded)).rejects.toMatchObject({
      code: "REQUEST_CHANGED_ELSEWHERE",
    });
    expect(
      await creditState(seeded.creditId, seeded.request.payment!.id),
    ).toEqual(STILL_SPENT);
  }, 30_000);

  it("an order already EXPIRED is not claimed again, so its credit is not returned by the lapse", async () => {
    const seeded = await seedApprovedWithCredit("EXPIRED");
    await expect(withdrawBy(seeded)).resolves.toEqual({ status: "CANCELLED" });
    expect(
      await creditState(seeded.creditId, seeded.request.payment!.id),
    ).toEqual(STILL_SPENT);
  }, 30_000);
});

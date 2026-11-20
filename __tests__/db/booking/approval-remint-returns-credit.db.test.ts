/**
 * An approval that re-mints a checkout order which used referral credit charges
 * the full price on the new order, so the credit goes back to the buyer at once
 * and the tombstone keeping the old order holds none. A late capture on that old
 * order is refunded and returns no credit a second time.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { seedConsultee, seedHost, seedOneToOne } from "./harness";

jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(async () => {
    const id = `order_${randomUUID()}`;
    return { id, client_secret: id };
  }),
  cancelPaymentIntent: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    {
      // Not a thenable: the mint loads these modules with a dynamic import.
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
      // Not a thenable: the mint loads these modules with a dynamic import.
      get: (_target, prop) =>
        prop === "then" ? undefined : prop === "__esModule" ? true : noop,
    },
  );
});

import { mintApprovalPaymentAfterCommit } from "../../../lib/booking/approve-request";
import { handlePaymentSuccess } from "../../../lib/payments/webhooks/handlers";
import { refundBookingPayment } from "../../../lib/payments/operations/booking-refund";
import { reverseCreditsForPayment } from "../../../lib/referrals/service";

const MIN = 60_000;
const PRICE_PAISE = 100_000;
const CREDIT_PAISE = 20_000;

/** An approved request whose open checkout order is ₹1,000 less ₹200 of referral credit. */
async function seedApprovedCheckoutWithCredit() {
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
      bookingSource: "DIRECT_CHECKOUT",
      isTentative: true,
      payment: { status: "PENDING", amount: PRICE_PAISE },
    },
  );
  const paymentId = request.payment!.id;
  const charged = BigInt(PRICE_PAISE - CREDIT_PAISE);
  await prisma.$transaction([
    prisma.payment.update({
      where: { id: paymentId },
      data: { amount: charged },
    }),
    prisma.paymentLeg.updateMany({
      where: { paymentId },
      data: { amountPaise: charged },
    }),
  ]);
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
      paymentId,
      amount: BigInt(CREDIT_PAISE),
      originalAmount: BigInt(CREDIT_PAISE),
    },
  });
  return {
    request,
    creditId: credit.id,
    oldIntent: request.payment!.paymentIntent,
  };
}

async function creditBalance(creditId: string) {
  const credit = await prisma.referralCredit.findUniqueOrThrow({
    where: { id: creditId },
    select: { remainingAmount: true, usedAmount: true },
  });
  const usages = await prisma.referralCreditUsage.count({
    where: { creditId },
  });
  return {
    remaining: Number(credit.remainingAmount),
    used: Number(credit.usedAmount),
    usages,
  };
}

const RETURNED = { remaining: CREDIT_PAISE, used: 0, usages: 0 };

describe("an approval re-mint returns the credit the replaced order used", () => {
  it("returns it at once, and a late capture on the old order returns none again", async () => {
    const seeded = await seedApprovedCheckoutWithCredit();
    const paymentId = seeded.request.payment!.id;

    const outcome = await mintApprovalPaymentAfterCommit({
      kind: "consultation",
      id: seeded.request.consultationId!,
    });

    expect(outcome.status).not.toBe("mint_failed");
    expect(await creditBalance(seeded.creditId)).toEqual(RETURNED);
    const live = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { paymentStatus: true, amount: true, paymentIntent: true },
    });
    expect(live.paymentStatus).toBe("PENDING");
    expect(Number(live.amount)).toBeGreaterThanOrEqual(PRICE_PAISE);
    expect(live.paymentIntent).not.toBe(seeded.oldIntent);
    const tombstone = await prisma.payment.findUniqueOrThrow({
      where: { paymentIntent: seeded.oldIntent },
      select: { id: true, paymentStatus: true, appointmentId: true },
    });
    expect(tombstone).toMatchObject({
      paymentStatus: "EXPIRED",
      appointmentId: null,
    });

    const refund = refundBookingPayment as jest.Mock;
    refund.mockClear();
    await handlePaymentSuccess(
      seeded.oldIntent,
      seeded.request.captureMetadata,
      PRICE_PAISE - CREDIT_PAISE,
    );
    expect(refund).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: tombstone.id }),
    );
    // The refund's own credit step on the tombstone finds nothing left to give.
    const again = await prisma.$transaction((tx) =>
      reverseCreditsForPayment(tombstone.id, tx),
    );
    expect(again).toBe(0);
    expect(await creditBalance(seeded.creditId)).toEqual(RETURNED);
  }, 30_000);
});

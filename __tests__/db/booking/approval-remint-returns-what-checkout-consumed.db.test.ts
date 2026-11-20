/**
 * An approval that re-mints a checkout order charges the full price on the new
 * order, so what the old one consumed goes back at once: the referral credit,
 * and a still-counted discount-code use, with the code dropped from the row. The
 * tombstone keeping the old order holds neither, and a late capture on it is
 * refunded and returns nothing a second time. A dead order, whose exit already
 * gave its use back, has the code dropped without a second return.
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
import { returnDiscountUse } from "../../../lib/payments/checkout/discount-use";

const MIN = 60_000;
const PRICE_PAISE = 100_000;
const CREDIT_PAISE = 20_000;

/**
 * An approved request whose checkout order is ₹1,000 less ₹200 of referral credit
 * and carries a discount code. Another buyer holds one more use of that code.
 */
async function seedApprovedCheckoutWithCredit(
  status: "PENDING" | "EXPIRED" = "PENDING",
) {
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
      payment: { status, amount: PRICE_PAISE },
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
  // A PENDING order's use is still counted; a dead one gave it back when it ended.
  const code = await prisma.discountCode.create({
    data: {
      code: `DBTIER-${randomUUID().slice(0, 8)}`,
      description: "db tier",
      discountType: "PERCENTAGE",
      discountValue: 10,
      maxUses: 5,
      currentUses: status === "PENDING" ? 2 : 1,
    },
  });
  await prisma.payment.update({
    where: { id: paymentId },
    data: { discountCodeId: code.id },
  });
  return {
    request,
    creditId: credit.id,
    codeId: code.id,
    oldIntent: request.payment!.paymentIntent,
  };
}

const usesOf = async (codeId: string) =>
  (await prisma.discountCode.findUniqueOrThrow({ where: { id: codeId } }))
    .currentUses;

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

describe("an approval re-mint returns what the replaced order consumed", () => {
  it("returns the credit and the code use at once, and a late capture on the old order returns neither again", async () => {
    const seeded = await seedApprovedCheckoutWithCredit();
    const paymentId = seeded.request.payment!.id;

    const outcome = await mintApprovalPaymentAfterCommit({
      kind: "consultation",
      id: seeded.request.consultationId!,
    });

    expect(outcome.status).not.toBe("mint_failed");
    expect(await creditBalance(seeded.creditId)).toEqual(RETURNED);
    expect(await usesOf(seeded.codeId)).toBe(1);
    const live = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: {
        paymentStatus: true,
        amount: true,
        paymentIntent: true,
        discountCodeId: true,
      },
    });
    expect(live.discountCodeId).toBeNull();
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
    // Neither the tombstone nor the full-price order still carries the code.
    await prisma.$transaction(async (tx) => {
      await returnDiscountUse(tx, tombstone.id);
      await returnDiscountUse(tx, paymentId);
    });
    expect(await usesOf(seeded.codeId)).toBe(1);
  }, 30_000);

  it("drops the code from a dead order without returning the use its exit already gave back", async () => {
    const seeded = await seedApprovedCheckoutWithCredit("EXPIRED");

    const outcome = await mintApprovalPaymentAfterCommit({
      kind: "consultation",
      id: seeded.request.consultationId!,
    });

    expect(outcome.status).not.toBe("mint_failed");
    expect(await usesOf(seeded.codeId)).toBe(1);
    const live = await prisma.payment.findUniqueOrThrow({
      where: { id: seeded.request.payment!.id },
      select: { paymentStatus: true, discountCodeId: true },
    });
    expect(live).toEqual({ paymentStatus: "PENDING", discountCodeId: null });
  }, 30_000);
});

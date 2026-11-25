/**
 * Money owed back on a payment keeps its earning out of a payout, on real
 * Postgres: a batch leaves a READY earning whose payment carries an owed-refund
 * marker and pays the expert's other earning; a marker that lands on an earning
 * already batched blocks the claim before anything is sent; once the markers
 * clear, a later batch picks the earning up. An earning the heal sweep writes
 * after its payment's dispute opened stays PENDING past its hold and out of
 * the batch until the dispute is decided.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { HOUR_MS, seedConsultee, seedHost, seedOneToOne } from "./harness";

jest.mock("../../../lib/redis", () => ({
  ...jest.requireActual("../../../lib/redis"),
  acquireLock: jest.fn(async () => "tok"),
  releaseLock: jest.fn(async () => undefined),
  isMockRedis: jest.fn(() => false),
  checkRedisHealth: jest.fn(async () => true),
}));
jest.mock("../../../lib/feature-flags", () => ({
  ...jest.requireActual("../../../lib/feature-flags"),
  ENABLE_LIVE_PAYOUTS: true,
}));
jest.mock("../../../lib/payments/payouts/balance-preflight", () => ({
  __esModule: true,
  assertPayoutBalance: jest.fn(async () => ({ ok: true })),
}));

import { stampRefundOwed } from "../../../lib/payments/operations/refund-owed";
import { releaseEarningsFromHold } from "../../../scripts/earnings/release-earnings";
import { syncPaymentEarnings } from "../../../scripts/earnings/sync-payment-earnings";
import {
  checkPayoutEligibility,
  createPayoutBatch,
  processPayoutById,
} from "../../../lib/payments/payouts/payout-service";

const SHARE = 40_000;

/** An expert with a verified default account and one READY earning on each of two card payments. */
async function seedTwoReadyEarnings() {
  const host = await seedHost();
  const buyer = await seedConsultee();
  await prisma.payoutAccount.create({
    data: {
      consultantProfileId: host.consultantProfileId,
      provider: "RAZORPAY",
      accountType: "BANK_ACCOUNT",
      razorpayFundAccId: `fa_dbtier_${randomUUID()}`,
      isVerified: true,
      isDefault: true,
    },
  });
  const earning = async () => {
    const payment = await prisma.payment.create({
      data: {
        amount: BigInt(50_000),
        originalAmount: BigInt(50_000),
        paymentMethod: "card",
        paymentIntent: `order_dbtier_${randomUUID()}`,
        paymentGateway: "RAZORPAY",
        paymentStatus: "SUCCEEDED",
        userId: buyer.userId,
        isMockPayment: true,
        legs: { create: [{ source: "CARD", amountPaise: BigInt(50_000) }] },
        expiresAt: null,
      },
    });
    const row = await prisma.consultantEarnings.create({
      data: {
        consultantProfileId: host.consultantProfileId,
        paymentId: payment.id,
        grossAmount: BigInt(50_000),
        platformFeePaise: BigInt(10_000),
        consultantSharePaise: BigInt(SHARE),
        status: "READY",
        holdUntil: new Date(Date.now() - 60_000),
      },
    });
    return { paymentId: payment.id, earningId: row.id };
  };
  return { host, owed: await earning(), clean: await earning() };
}

const earningOf = (id: string) =>
  prisma.consultantEarnings.findUniqueOrThrow({
    where: { id },
    select: { status: true, payoutId: true },
  });

const clearMarker = (paymentId: string) =>
  prisma.payment.update({
    where: { id: paymentId },
    data: {
      refundOwedKey: null,
      refundOwedPaise: null,
      refundOwedReason: null,
      refundOwedAt: null,
    },
  });

it("a stamped marker keeps a READY earning out of the batch and blocks the claim of one already batched", async () => {
  const { host, owed, clean } = await seedTwoReadyEarnings();
  const cp = host.consultantProfileId;

  const stamped = await prisma.$transaction((tx) =>
    stampRefundOwed(tx, {
      paymentId: owed.paymentId,
      amountPaise: 15_000,
      key: `dbtier-owed:${owed.paymentId}`,
      reason: "database tier",
    }),
  );
  expect(stamped).toBe(true);

  expect((await checkPayoutEligibility(cp)).readyAmount).toBe(SHARE);
  const first = await createPayoutBatch([cp]);
  expect(first).toMatchObject({ minted: 1, failed: 0 });
  const payout = await prisma.consultantPayout.findFirstOrThrow({
    where: { consultantProfileId: cp, batchId: first.batchId },
    select: { id: true, amount: true, status: true },
  });
  expect(payout).toMatchObject({ amount: SHARE, status: "APPROVED" });
  expect(await earningOf(owed.earningId)).toEqual({
    status: "READY",
    payoutId: null,
  });
  expect(await earningOf(clean.earningId)).toEqual({
    status: "BATCHED",
    payoutId: payout.id,
  });

  // A marker written past the stamping door's own cancel: the claim is the last gate.
  await prisma.payment.update({
    where: { id: clean.paymentId },
    data: {
      refundOwedKey: `dbtier-late:${clean.paymentId}`,
      refundOwedPaise: BigInt(5_000),
      refundOwedReason: "database tier",
      refundOwedAt: new Date(),
    },
  });
  const blocked = await processPayoutById(payout.id);
  expect(blocked).toMatchObject({ success: false, skipped: true });
  expect(
    await prisma.consultantPayout.findUniqueOrThrow({
      where: { id: payout.id },
      select: { status: true, providerPayoutId: true },
    }),
  ).toEqual({ status: "APPROVED", providerPayoutId: null });
  expect((await earningOf(clean.earningId)).status).toBe("BATCHED");

  await clearMarker(owed.paymentId);
  const second = await createPayoutBatch([cp]);
  expect(second).toMatchObject({ minted: 1, failed: 0 });
  expect((await earningOf(owed.earningId)).status).toBe("BATCHED");
});

it("an earning written after its payment's dispute opened is neither released nor batched until the dispute is decided", async () => {
  const { host, owed, clean } = await seedTwoReadyEarnings();
  const cp = host.consultantProfileId;
  const buyer = await seedConsultee();
  const past = new Date(Date.now() - 10 * 24 * HOUR_MS);
  const booking = await seedOneToOne(
    "consultation",
    host,
    buyer,
    { startsAt: past, endsAt: new Date(past.getTime() + HOUR_MS) },
    {
      status: "COMPLETED",
      isTentative: false,
      completionStatus: "COMPLETED",
      payment: { status: "SUCCEEDED", expiresAt: null, amount: 50_000 },
    },
  );
  const paymentId = booking.payment!.id;
  // A gateway capture whose earnings write never landed: the heal sweep's cohort.
  await prisma.payment.update({
    where: { id: paymentId },
    data: { isMockPayment: false },
  });
  const dispute = await prisma.dispute.create({
    data: {
      paymentId,
      amountPaise: BigInt(50_000),
      reason: "database tier",
      status: "NEEDS_RESPONSE",
      disputeId: `disp_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
    },
  });

  await syncPaymentEarnings();
  const late = await prisma.consultantEarnings.findFirstOrThrow({
    where: { paymentId, consultantProfileId: cp },
    select: { id: true, status: true },
  });
  expect(late.status).toBe("PENDING");
  await prisma.consultantEarnings.update({
    where: { id: late.id },
    data: { holdUntil: new Date(Date.now() - HOUR_MS) },
  });

  await releaseEarningsFromHold();
  expect((await earningOf(late.id)).status).toBe("PENDING");

  const batch = await createPayoutBatch([cp]);
  expect(batch).toMatchObject({ minted: 1, failed: 0 });
  expect((await earningOf(late.id)).payoutId).toBeNull();
  expect((await earningOf(owed.earningId)).status).toBe("BATCHED");
  expect((await earningOf(clean.earningId)).status).toBe("BATCHED");

  await prisma.dispute.update({
    where: { id: dispute.id },
    data: { status: "WON" },
  });
  await releaseEarningsFromHold();
  expect((await earningOf(late.id)).status).toBe("READY");
});

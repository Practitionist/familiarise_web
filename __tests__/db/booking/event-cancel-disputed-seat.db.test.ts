/**
 * One seat's payment dispute does not block cancelling a class, on real
 * Postgres. Every undisputed seat is refunded from its ledger, the disputed
 * seat's owed refund is stamped in the cancel's commit and waits, and the
 * dispute's outcome settles it: won, the retry sweep refunds the stamped
 * share; lost, the sweep clears the marker with nothing more refunded.
 */
import "./harness-cancel-route";
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { seedHost } from "./harness";
import {
  hostCancels,
  seatClassBuyer,
  seedClassUnderWay,
} from "./harness-class-series";
import { refundedPaise, refundOnRowsEachTest } from "./harness-refunds";

import { retryAutoRefunds } from "../../../scripts/payments/retry-auto-refunds";

/** 8 sessions for ₹8,000 a seat (₹1,000 a session), 3 already delivered. */
const SHAPE = { price: 800_000, sessions: 8, delivered: 3 };
const UNDELIVERED = (SHAPE.price / SHAPE.sessions) * 5;

refundOnRowsEachTest();

const openDispute = (paymentId: string) =>
  prisma.dispute.create({
    data: {
      paymentId,
      amountPaise: BigInt(SHAPE.price),
      reason: "fraud",
      status: "NEEDS_RESPONSE",
      disputeId: `disp_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
    },
  });

const markerOf = (paymentId: string) =>
  prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    select: {
      refundOwedKey: true,
      refundOwedPaise: true,
      refundOwedAttempts: true,
    },
  });

/** The sweep's grace has passed for this payment's marker. */
const pastGrace = (paymentId: string) =>
  prisma.payment.update({
    where: { id: paymentId },
    data: { refundOwedAt: new Date(Date.now() - 20 * 60_000) },
  });

/** A class under way with one clear seat and one disputed seat, cancelled by its host. */
async function cancelWithDisputedSeat() {
  const host = await seedHost();
  const cls = await seedClassUnderWay(host, SHAPE);
  const clear = await seatClassBuyer(cls, SHAPE);
  const disputed = await seatClassBuyer(cls, SHAPE);
  const dispute = await openDispute(disputed.paymentId);

  const res = await hostCancels(host, cls.appointmentId);

  return { cls, clear, disputed, dispute, res };
}

describe("a class cancel with one seat under a payment dispute", () => {
  it("cancels for every seat, refunds the clear seat, and leaves the disputed seat's refund owed and waiting", async () => {
    const { cls, clear, disputed, res } = await cancelWithDisputedSeat();

    expect(res.status).toBe(200);
    const row = await prisma.class.findUniqueOrThrow({
      where: { id: cls.classId },
      select: { status: true },
    });
    expect(row.status).toBe("CANCELLED");
    expect(await refundedPaise(clear.paymentId)).toBe(UNDELIVERED);
    expect(await refundedPaise(disputed.paymentId)).toBe(0);
    expect(await markerOf(disputed.paymentId)).toEqual({
      refundOwedKey: `event-cancel:${cls.classId}:pay:${disputed.paymentId}`,
      refundOwedPaise: UNDELIVERED,
      refundOwedAttempts: 0,
    });

    // While the dispute is open the sweep leaves the marker alone and spends no attempt.
    await pastGrace(disputed.paymentId);
    await retryAutoRefunds({ limit: 50 });
    expect(await refundedPaise(disputed.paymentId)).toBe(0);
    expect((await markerOf(disputed.paymentId)).refundOwedAttempts).toBe(0);
  });

  it("dispute won: the sweep refunds the seat its stamped share and clears the marker", async () => {
    const { cls, disputed, dispute } = await cancelWithDisputedSeat();
    await prisma.dispute.update({
      where: { id: dispute.id },
      data: { status: "WON" },
    });
    await pastGrace(disputed.paymentId);

    await retryAutoRefunds({ limit: 50 });

    expect(await refundedPaise(disputed.paymentId)).toBe(UNDELIVERED);
    const refunds = await prisma.refund.findMany({
      where: { paymentId: disputed.paymentId },
      select: { dedupeKey: true },
    });
    expect(refunds).toEqual([
      { dedupeKey: `event-cancel:${cls.classId}:pay:${disputed.paymentId}` },
    ]);
    expect((await markerOf(disputed.paymentId)).refundOwedKey).toBeNull();
  });

  it("dispute lost: the bank already returned the money, so the sweep clears the marker and refunds nothing", async () => {
    const { disputed, dispute } = await cancelWithDisputedSeat();
    await prisma.dispute.update({
      where: { id: dispute.id },
      data: { status: "LOST" },
    });
    await pastGrace(disputed.paymentId);

    await retryAutoRefunds({ limit: 50 });

    expect(await refundedPaise(disputed.paymentId)).toBe(0);
    expect(await markerOf(disputed.paymentId)).toEqual({
      refundOwedKey: null,
      refundOwedPaise: null,
      refundOwedAttempts: 0,
    });
  });
});

/**
 * Two doors confirming one capture take turns on the order's advisory lock:
 * the second waits for the first to commit, then finds the payment confirmed
 * and does nothing; a wait past the capture's lock timeout fails cleanly with
 * 55P03 and leaves nothing written.
 */
import { Prisma } from "@prisma/client";
import prisma from "../../../lib/prisma";
import { isLockTimeout } from "../../../lib/db/pg-errors";
import {
  futureAt,
  gate,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";

/** Parks the first capture inside its transaction, after its confirm write, lock held. */
const referralGate = { current: null as ReturnType<typeof gate> | null };
jest.mock("../../../lib/referrals/capture", () => {
  const actual = jest.requireActual("../../../lib/referrals/capture");
  return {
    ...actual,
    recordReferralCaptureInSavepoint: async (...args: unknown[]) => {
      const g = referralGate.current;
      if (g) {
        referralGate.current = null;
        await g.park();
      }
      return actual.recordReferralCaptureInSavepoint(...args);
    },
  };
});
jest.mock("../../../lib/novu/stage-then-attempt", () =>
  jest.requireActual("./harness-edges").noFlushMock(),
);
jest.mock("../../../lib/payments/billing/consumer-invoice", () => ({
  __esModule: true,
  mintConsumerInvoiceBestEffort: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/payments/webhooks/ensure-channels", () => ({
  __esModule: true,
  ensureChannelsForAppointment: jest.fn(async () => ({ ensured: true })),
}));

import { handlePaymentSuccess } from "../../../lib/payments/webhooks/handlers";

async function seedLiveCheckout() {
  const startsAt = futureAt(4, 9);
  const buyer = await seedConsultee();
  const booking = await seedOneToOne(
    "consultation",
    await seedHost(),
    buyer,
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: "APPROVED_PENDING_PAYMENT",
      bookingSource: "REQUEST_SUBMITTED",
      isTentative: true,
      payment: { status: "PENDING" },
    },
  );
  return { booking, payment: booking.payment!, buyerId: buyer.userId };
}

const capture = (
  booking: Awaited<ReturnType<typeof seedLiveCheckout>>["booking"],
) =>
  handlePaymentSuccess(
    booking.payment!.paymentIntent,
    booking.captureMetadata,
    Number(booking.payment!.amount),
  );

/** Resolves once some backend waits on an advisory lock. */
async function untilAdvisoryWaiter(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>(
      Prisma.sql`SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
    );
    if (waiting > 0) return;
    if (Date.now() > deadline) {
      throw new Error("No backend waited on an advisory lock");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("the second door waits on the order's advisory lock, then finds it confirmed", async () => {
  const { booking, payment, buyerId } = await seedLiveCheckout();
  const paused = gate();
  referralGate.current = paused;

  const first = capture(booking);
  await paused.arrived;
  const second = capture(booking);
  await untilAdvisoryWaiter();
  paused.open();

  expect(await Promise.all([first, second])).toEqual(["confirmed", null]);
  const row = await prisma.payment.findUniqueOrThrow({
    where: { id: payment.id },
    select: { paymentStatus: true },
  });
  expect(row.paymentStatus).toBe("SUCCEEDED");
  expect(
    await prisma.consultantEarnings.count({ where: { paymentId: payment.id } }),
  ).toBe(1);
  expect(
    await prisma.ledgerTransaction.count({
      where: { paymentId: payment.id, kind: "BOOKING" },
    }),
  ).toBe(1);
  expect(
    await prisma.notificationOutbox.count({
      where: { workflowId: "appointment-booked", recipients: { has: buyerId } },
    }),
  ).toBe(1);
}, 30_000);

it("a door kept waiting past the lock timeout fails with 55P03 and writes nothing", async () => {
  const { booking, payment } = await seedLiveCheckout();
  const held = gate();
  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-capture:${payment.paymentIntent}`}, 42))`;
      await held.park();
    },
    { timeout: 20_000 },
  );
  await held.arrived;

  const startedAt = Date.now();
  const failure = await capture(booking).catch((err: unknown) => err);
  const waitedMs = Date.now() - startedAt;
  held.open();
  await holder;

  expect(isLockTimeout(failure)).toBe(true);
  expect(waitedMs).toBeGreaterThanOrEqual(4_000);
  expect(waitedMs).toBeLessThan(5_000);
  const row = await prisma.payment.findUniqueOrThrow({
    where: { id: payment.id },
    select: { paymentStatus: true },
  });
  expect(row.paymentStatus).toBe("PENDING");
  // Once the holder commits, the next door confirms the capture.
  expect(await capture(booking)).toBe("confirmed");
}, 30_000);

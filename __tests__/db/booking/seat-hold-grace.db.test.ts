/**
 * A seat's gateway window closes at 12 minutes and the seat keeps counting
 * until Payment.expiresAt (15 minutes), so a late UPI capture the gateway
 * accepted inside its window still lands on a counted seat. After the grace
 * the seat stops counting at once; a capture that lands after someone else
 * took the place is parked and refunded.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  liveSeatCount,
  seatCheckoutInput,
  seedSeatBuyer,
  seedWebinar,
  type SeededWebinar,
} from "./harness-seats";

jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(async () => ({
    id: `order_${randomUUID()}`,
    client_secret: null,
  })),
  cancelPaymentIntent: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn(async () => true),
}));
jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});

import { handleCheckout } from "../../../lib/payments/checkout";
import { handlePaymentSuccess } from "../../../lib/payments/webhooks/handlers";
import {
  SEAT_CAPTURE_GRACE_MS,
  SEAT_CHECKOUT_HOLD_MS,
  SEAT_GATEWAY_TIMEOUT_MS,
} from "../../../lib/payments/constants";

const MIN = 60_000;

/** Buyer A holds the last seat; its payment's deadline is moved to `expiresAt`. */
async function lastSeatHeldUntil(expiresAt: Date) {
  const webinar = await seedWebinar({ capacity: 1 });
  const first = await seedSeatBuyer();
  await handleCheckout(
    seatCheckoutInput(webinar, `grace-${randomUUID()}`),
    first.userId,
  );
  const payment = await prisma.payment.findFirstOrThrow({
    where: { userId: first.userId, appointmentId: webinar.appointmentId },
  });
  await prisma.payment.update({
    where: { id: payment.id },
    data: { expiresAt },
  });
  return { webinar, first, payment };
}

const captureFor = (
  webinar: SeededWebinar,
  userId: string,
  payment: { paymentIntent: string; amount: number | bigint },
) =>
  handlePaymentSuccess(
    payment.paymentIntent,
    {
      appointmentId: "pending",
      appointmentType: "WEBINAR",
      userId,
      planId: webinar.planId,
      eventId: webinar.webinarId,
    },
    Number(payment.amount),
  );

const seatOf = (appointmentId: string, userId: string) =>
  prisma.appointmentParticipant.findFirstOrThrow({
    where: { appointmentId, userId, role: "CONSULTEE" },
  });

it("sizes the hold as the gateway window plus the capture grace", () => {
  expect(SEAT_GATEWAY_TIMEOUT_MS).toBe(12 * MIN);
  expect(SEAT_CAPTURE_GRACE_MS).toBe(3 * MIN);
  expect(SEAT_CHECKOUT_HOLD_MS).toBe(15 * MIN);
});

it("inside the grace the seat still counts: the next buyer is refused and the late capture confirms it", async () => {
  // Minute 13: the gateway window has closed, the hold has not.
  const { webinar, first, payment } = await lastSeatHeldUntil(
    new Date(Date.now() + 2 * MIN),
  );
  const second = await seedSeatBuyer();

  const refusal = await handleCheckout(
    seatCheckoutInput(webinar, `grace-${randomUUID()}`),
    second.userId,
  ).catch((error: unknown) => error);
  expect((refusal as { code?: string }).code).toMatch(
    /^EVENT_(SOLD_OUT|FULL)$/,
  );

  await captureFor(webinar, first.userId, payment);

  const settled = await prisma.payment.findUniqueOrThrow({
    where: { id: payment.id },
  });
  expect(settled.paymentStatus).toBe("SUCCEEDED");
  expect(settled.description ?? "").not.toMatch(/^Auto-refund pending:/);
  expect((await seatOf(webinar.appointmentId, first.userId)).status).toBe(
    "CONFIRMED",
  );
  expect(await liveSeatCount(webinar.appointmentId)).toBe(1);
});

it("after the grace the seat stops counting: the next buyer takes it and the late capture is parked for a refund", async () => {
  // Minute 16: past Payment.expiresAt.
  const { webinar, first, payment } = await lastSeatHeldUntil(
    new Date(Date.now() - MIN),
  );
  const second = await seedSeatBuyer();

  await handleCheckout(
    seatCheckoutInput(webinar, `grace-${randomUUID()}`),
    second.userId,
  );
  await captureFor(webinar, first.userId, payment);

  const settled = await prisma.payment.findUniqueOrThrow({
    where: { id: payment.id },
  });
  expect(settled.paymentStatus).toBe("SUCCEEDED");
  // Parked for an auto-refund (pending, or already refunded by the door).
  expect(settled.description ?? "").toMatch(/^Auto-refund(ed| pending):/);
  expect((await seatOf(webinar.appointmentId, first.userId)).status).not.toBe(
    "CONFIRMED",
  );
  expect((await seatOf(webinar.appointmentId, second.userId)).status).toBe(
    "HELD",
  );
  expect(await liveSeatCount(webinar.appointmentId)).toBe(1);
});

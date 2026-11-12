/**
 * A seat leave stamps the refund it owes in the same commit that releases the
 * seat, so an instance that dies right after that commit (before any refund
 * call) loses nothing: retry-auto-refunds finds the marker and drives the
 * refund under the seat door's own key, once.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { seedHeldSeat, seedWebinar } from "./harness-seats";

jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});
jest.mock("../../../lib/stream/access-revocation", () => ({
  revokeEndedSeatAccess: jest.fn(async () => undefined),
  persistSeatRevocation: jest.fn(async () => undefined),
  persistSeatRevocationInTx: jest.fn(async () => null),
}));
/** The instance dies after the release commit, before its refund call returns. */
jest.mock("../../../lib/payments/operations/event-refunds", () => ({
  ...jest.requireActual("../../../lib/payments/operations/event-refunds"),
  refundRemovedAttendeeSeat: jest.fn(async () => {
    throw new Error("instance died after the release commit");
  }),
}));

import { leaveEventSeat } from "../../../lib/booking/seat-leave";
import { retryAutoRefunds } from "../../../scripts/payments/retry-auto-refunds";
import { refundBookingPayment } from "../../../lib/payments/operations/booking-refund";

const refund = refundBookingPayment as jest.Mock;

describe("seat leave crash → re-drive", () => {
  it("the release commit carries the owed marker; the sweep refunds it once under the seat key", async () => {
    const webinar = await seedWebinar({ capacity: 10 });
    const { buyer, payment } = await seedHeldSeat(webinar, {
      status: "SUCCEEDED",
      expiresAt: null,
    });

    await expect(
      leaveEventSeat({
        kind: "webinar",
        eventId: webinar.webinarId,
        userId: buyer.userId,
        actorUserId: webinar.host.userId,
        isSelfLeave: false,
      }),
    ).rejects.toThrow(/instance died/);

    // The seat is released and the refund it owes is durable.
    const seat = await prisma.appointmentParticipant.findFirstOrThrow({
      where: { appointmentId: webinar.appointmentId, userId: buyer.userId },
      select: { id: true, status: true },
    });
    expect(["HELD", "CONFIRMED"]).not.toContain(seat.status);
    const marked = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
      select: { refundOwedKey: true },
    });
    expect(marked.refundOwedKey).toContain(`seat-leave:${seat.id}`);

    // Time passes past the sweep's grace; the sweep re-drives the marker.
    await prisma.payment.update({
      where: { id: payment.id },
      data: { refundOwedAt: new Date(Date.now() - 20 * 60_000) },
    });
    refund.mockReset();
    refund.mockResolvedValue({
      refundId: `rf_${randomUUID()}`,
      amountRefundedPaise: Number(payment.amount),
      status: "SUCCEEDED",
    });
    await retryAutoRefunds({ limit: 50 });

    const ours = refund.mock.calls.filter(
      ([args]) => (args as { paymentId: string }).paymentId === payment.id,
    );
    expect(ours).toHaveLength(1);
    expect(ours[0][0]).toMatchObject({
      paymentId: payment.id,
      dedupeKey: marked.refundOwedKey,
    });
    const cleared = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
      select: { refundOwedKey: true },
    });
    expect(cleared.refundOwedKey).toBeNull();
  }, 45_000);
});

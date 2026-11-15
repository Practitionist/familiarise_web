/**
 * A seat leave owns the refund it drives: its marker commits with the release,
 * or the release does not happen.
 *  - another door's refund still owed on the seat's payment refuses the leave
 *    (409 REFUND_IN_PROGRESS, or REFUND_NEEDS_SUPPORT when that marker spent
 *    its attempts) and the seat stays;
 *  - a leave that commits and dies before the refund leaves its marker for
 *    the retry sweep.
 */
import prisma from "../../../lib/prisma";
import { isRefusal } from "../../../lib/errors/refusal";
import { seedHeldSeat, seedWebinar } from "./harness-seats";

jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});
/** The seat intent is written for real; only the Stream drive is stubbed. */
jest.mock("../../../lib/stream/access-revocation", () => ({
  revokeEndedSeatAccess: jest.fn(async () => undefined),
  persistSeatRevocation: jest.fn(async () => undefined),
  persistSeatRevocationInTx: jest.requireActual(
    "../../../lib/stream/access-revocation",
  ).persistSeatRevocationInTx,
}));
/** The seat refund door; a test makes it die after the release committed. */
jest.mock("../../../lib/payments/operations/event-refunds", () => ({
  ...jest.requireActual("../../../lib/payments/operations/event-refunds"),
  refundRemovedAttendeeSeat: jest.fn(async () => ({
    amountRefundedPaise: 0,
    refundPct: 100,
    rail: null,
  })),
}));

import { leaveEventSeat } from "../../../lib/booking/seat-leave";

const seatDoor = jest.requireMock(
  "../../../lib/payments/operations/event-refunds",
) as { refundRemovedAttendeeSeat: jest.Mock };

async function seatedBuyer() {
  const webinar = await seedWebinar({ capacity: 5 });
  const { buyer, payment } = await seedHeldSeat(webinar, {
    status: "SUCCEEDED",
    expiresAt: null,
  });
  return { webinar, buyer, payment };
}

const leave = (webinarId: string, userId: string) =>
  leaveEventSeat({
    kind: "webinar",
    eventId: webinarId,
    userId,
    actorUserId: userId,
    isSelfLeave: true,
  });

const openSeatIntents = (appointmentId: string, userId: string) =>
  prisma.streamRevocationRetry.count({
    where: {
      kind: "SEAT_ACCESS_REVOKE",
      planId: appointmentId,
      userId,
      status: { not: "SUCCEEDED" },
    },
  });

const seatStatus = async (appointmentId: string, userId: string) =>
  (
    await prisma.appointmentParticipant.findFirstOrThrow({
      where: { appointmentId, userId, role: "CONSULTEE" },
      select: { status: true },
    })
  ).status;

describe("seat leave and a refund another door owes", () => {
  it.each([
    [1, "REFUND_IN_PROGRESS"],
    [3, "REFUND_NEEDS_SUPPORT"],
  ])(
    "a held marker with %i attempts refuses with %s and keeps the seat",
    async (attempts, code) => {
      const { webinar, buyer, payment } = await seatedBuyer();
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          refundOwedKey: `incident:inc-1:occ-1:${buyer.userId}`,
          refundOwedPaise: BigInt(10_000),
          refundOwedReason: "incident refund",
          refundOwedAt: new Date(),
          refundOwedAttempts: attempts,
        },
      });

      const refused = await leave(webinar.webinarId, buyer.userId).catch(
        (error: unknown) => error,
      );

      expect(isRefusal(refused) && refused.code).toBe(code);
      expect(await seatStatus(webinar.appointmentId, buyer.userId)).toBe(
        "CONFIRMED",
      );
      expect(
        (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }))
          .refundOwedKey,
      ).toBe(`incident:inc-1:occ-1:${buyer.userId}`);
      expect(seatDoor.refundRemovedAttendeeSeat).not.toHaveBeenCalled();
      // The seat intent was written before the refusal and rolled back with it.
      expect(await openSeatIntents(webinar.appointmentId, buyer.userId)).toBe(
        0,
      );
    },
  );

  it("a leave that dies after its commit leaves its own marker for the sweep", async () => {
    const { webinar, buyer, payment } = await seatedBuyer();
    seatDoor.refundRemovedAttendeeSeat.mockRejectedValueOnce(
      new Error("instance recycled"),
    );

    await expect(leave(webinar.webinarId, buyer.userId)).rejects.toThrow(
      "instance recycled",
    );

    expect(await seatStatus(webinar.appointmentId, buyer.userId)).not.toBe(
      "CONFIRMED",
    );
    const row = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(row.refundOwedKey).toMatch(/^seat-leave:.*:pay:/);
    expect(await openSeatIntents(webinar.appointmentId, buyer.userId)).toBe(1);
  });
});

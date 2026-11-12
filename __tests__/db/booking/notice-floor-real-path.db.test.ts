/**
 * The reschedule notice floor through the real doors: the consultee moves a
 * session with short notice (the release writes its record, the auto-confirm
 * re-places the session and the released row is gone), then cancels the moved
 * session far ahead. The shorter notice they gave when moving it is the notice
 * that prices the cancel.
 */
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { HOUR_MS, seedConsultee, seedHost, seedOneToOne } from "./harness";
import { publishEveryHour } from "./harness-host";

const sessionUser = { current: null as null | Record<string, unknown> };
jest.mock("../../../lib/auth-helpers", () => ({
  ...jest.requireActual("../../../lib/auth-helpers"),
  requireApiAuth: async () => ({ session: { user: sessionUser.current } }),
  isPrivileged: () => false,
}));
jest.mock("../../../lib/rate-limit", () => ({
  ...jest.requireActual("../../../lib/rate-limit"),
  applyRateLimit: async () => null,
}));
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

import { POST as reschedule } from "../../../app/api/appointments/[appointmentId]/reschedule/route";
import { POST as cancel } from "../../../app/api/appointments/[appointmentId]/cancel/route";

/** 72 h or more: full refund; less: a quarter. */
async function seedLadder() {
  return prisma.cancellationPolicy.create({
    data: {
      organizationId: null,
      version: 900 + Math.floor(Math.random() * 1_000_000),
      // A booking keeps the version it was sold under, archived or not.
      status: "ARCHIVED",
      consultantInitiatedBps: 10_000,
      tiers: {
        create: [
          { hoursBefore: 72, refundBps: 10_000 },
          { hoursBefore: 0, refundBps: 2_500 },
        ],
      },
    },
  });
}

const HALF_HOUR_MS = HOUR_MS / 2;

/** An hour-aligned instant `hours` from now. */
const hoursAhead = (hours: number) =>
  new Date(Math.ceil((Date.now() + hours * HOUR_MS) / HOUR_MS) * HOUR_MS);

const post = (
  handler: typeof cancel,
  url: string,
  appointmentId: string,
  body: unknown,
) =>
  handler(
    new NextRequest(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ appointmentId }) },
  );

describe("reschedule notice floor, end to end", () => {
  it("prices the cancel of a moved session at the notice the move gave", async () => {
    const host = await seedHost();
    const buyer = await seedConsultee();
    await publishEveryHour(host);
    const startsAt = hoursAhead(30);
    const booking = await seedOneToOne(
      "consultation",
      host,
      buyer,
      { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
      {
        status: "APPROVED",
        isTentative: false,
        payment: { status: "SUCCEEDED", expiresAt: null },
      },
    );
    const ladder = await seedLadder();
    await prisma.appointment.update({
      where: { id: booking.appointmentId },
      data: { cancellationPolicyId: ladder.id },
    });
    sessionUser.current = {
      id: buyer.userId,
      role: "CONSULTEE",
      consulteeProfileId: buyer.consulteeProfileId,
      consultantProfileId: null,
      name: "Buyer",
    };

    // The buyer moves the session 30 h out to a week out.
    const newStart = hoursAhead(24 * 7);
    const moved = await post(
      reschedule,
      `http://localhost/api/appointments/${booking.appointmentId}/reschedule?type=CONSULTATION`,
      booking.appointmentId,
      {
        reason: "travel",
        // The hour as its two 30-minute slots.
        proposedSlots: [0, 1].map((half) => ({
          startsAt: new Date(
            newStart.getTime() + half * HALF_HOUR_MS,
          ).toISOString(),
          endsAt: new Date(
            newStart.getTime() + (half + 1) * HALF_HOUR_MS,
          ).toISOString(),
        })),
      },
    );
    const movedBody = await moved.json();
    expect(moved.status < 300 ? "moved" : JSON.stringify(movedBody)).toBe(
      "moved",
    );

    const request = await prisma.rescheduleRequest.findFirstOrThrow({
      where: { appointmentId: booking.appointmentId },
    });
    expect(request.releasedSessions).toEqual([
      { ordinal: 1, startsAt: startsAt.toISOString() },
    ]);
    // Inside the host's published hours, a consultee proposal confirms
    // itself: the released row is replaced by the new one.
    expect(request.status).toBe("AUTO_ACCEPTED");
    const live = await prisma.appointmentOccurrence.findMany({
      where: { appointmentId: booking.appointmentId, deletedAt: null },
      select: { startsAt: true, completionStatus: true },
    });
    expect(live).toEqual([
      { startsAt: newStart, completionStatus: "SCHEDULED" },
    ]);

    // A week ahead would be the full-refund tier; the move gave 30 h.
    const res = await post(
      cancel,
      `http://localhost/api/appointments/${booking.appointmentId}/cancel`,
      booking.appointmentId,
      { reason: "SCHEDULE_CONFLICT" },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refund.refundPct).toBe(25);
    const refundDoor = jest.requireMock(
      "../../../lib/payments/operations/booking-refund",
    ) as { refundBookingPayment: jest.Mock };
    expect(refundDoor.refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: booking.payment!.id,
        amountPaise: 25_000,
      }),
    );
  });
});

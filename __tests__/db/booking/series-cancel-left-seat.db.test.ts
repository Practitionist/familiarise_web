/**
 * A host cancelling a class series pays each seat only what it is still owed:
 *  - a seat that already left (ladder leave, or the free leave a re-time opens)
 *    gets nothing more, whatever it was refunded on the way out;
 *  - a seat still in the class gets every undelivered session back.
 * Real Postgres, the real cancel route, a refund door that writes Refund rows.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { HOUR_MS, seedHost, type SeededHost } from "./harness";
import { seedSeatBuyer } from "./harness-seats";

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
  revokeEndedBookingChatAccess: jest.fn(async () => undefined),
  revokeEndedEventChatAccess: jest.fn(async () => undefined),
}));

import { POST as cancel } from "../../../app/api/appointments/[appointmentId]/cancel/route";
import { occurrenceRefundsPaise } from "../../../lib/booking/class-series";
import { leaveEventSeat } from "../../../lib/booking/seat-leave";
import { refundOnRows, refundedPaise } from "./harness-refunds";

const refundDoor = jest.requireMock(
  "../../../lib/payments/operations/booking-refund",
) as { refundBookingPayment: jest.Mock };

const DAY_MS = 24 * HOUR_MS;
const PRICE = 10_000;
const SESSIONS = 10;
const DELIVERED = 3;

beforeEach(() => {
  refundDoor.refundBookingPayment.mockImplementation(refundOnRows);
});

/** A class of ten sessions, three already delivered, bought twenty days ago. */
async function seedClassUnderWay(host: SeededHost) {
  const now = Date.now();
  const plan = await prisma.classPlan.create({
    data: {
      title: `Database tier class ${randomUUID().slice(0, 8)}`,
      price: BigInt(PRICE),
      totalSessions: SESSIONS,
      consultantProfileId: host.consultantProfileId,
    },
  });
  const cls = await prisma.class.create({
    data: { classPlanId: plan.id, status: "SCHEDULED" },
  });
  const appointment = await prisma.appointment.create({
    data: { appointmentType: "CLASS", classId: cls.id },
  });
  for (let i = 0; i < SESSIONS; i += 1) {
    const offsetDays = i < DELIVERED ? i - 10 : i + 2;
    const startsAt = new Date(now + offsetDays * DAY_MS);
    await prisma.appointmentOccurrence.create({
      data: {
        appointmentId: appointment.id,
        ordinal: i + 1,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR_MS),
        isTentative: false,
        consultantProfileId: host.consultantProfileId,
        completionStatus: i < DELIVERED ? "COMPLETED" : "SCHEDULED",
      },
    });
  }
  await prisma.appointmentParticipant.create({
    data: {
      appointmentId: appointment.id,
      userId: host.userId,
      role: "CONSULTANT",
      status: "CONFIRMED",
    },
  });
  return { classId: cls.id, appointmentId: appointment.id };
}

async function seatBuyer(cls: { appointmentId: string }) {
  const buyer = await seedSeatBuyer();
  const boughtAt = new Date(Date.now() - 20 * DAY_MS);
  const payment = await prisma.payment.create({
    data: {
      amount: BigInt(PRICE),
      originalAmount: BigInt(PRICE),
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "SUCCEEDED",
      userId: buyer.userId,
      appointmentId: cls.appointmentId,
      isMockPayment: true,
      createdAt: boughtAt,
      legs: { create: [{ source: "CARD", amountPaise: BigInt(PRICE) }] },
    },
  });
  await prisma.appointmentParticipant.create({
    data: {
      appointmentId: cls.appointmentId,
      userId: buyer.userId,
      role: "CONSULTEE",
      status: "CONFIRMED",
      paymentId: payment.id,
      sessionsPurchased: SESSIONS,
      createdAt: boughtAt,
    },
  });
  return { userId: buyer.userId, paymentId: payment.id };
}

const leave = (classId: string, userId: string) =>
  leaveEventSeat({
    kind: "class",
    eventId: classId,
    userId,
    actorUserId: userId,
    isSelfLeave: true,
  });

async function hostCancels(host: SeededHost, appointmentId: string) {
  sessionUser.current = {
    id: host.userId,
    role: "CONSULTANT",
    consultantProfileId: host.consultantProfileId,
    consulteeProfileId: null,
    name: "Host",
  };
  const res = await cancel(
    new NextRequest(
      `http://localhost/api/appointments/${appointmentId}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ reason: "SCHEDULE_CONFLICT" }),
        headers: { "Content-Type": "application/json" },
      },
    ),
    { params: Promise.resolve({ appointmentId }) },
  );
  expect(res.status).toBe(200);
}

const UNDELIVERED = (PRICE / SESSIONS) * (SESSIONS - DELIVERED);

describe("series cancel after a seat already left", () => {
  it("pays a seat that left on the ladder nothing more, and a staying seat its undelivered sessions", async () => {
    const host = await seedHost();
    const cls = await seedClassUnderWay(host);
    const leaver = await seatBuyer(cls);
    const stayer = await seatBuyer(cls);

    await leave(cls.classId, leaver.userId);
    const paidOnLeave = await refundedPaise(leaver.paymentId);
    expect(paidOnLeave).toBeGreaterThan(0);
    expect(paidOnLeave).toBeLessThanOrEqual(UNDELIVERED);
    // The leave's refund counts as sessions already returned on this payment.
    expect(await occurrenceRefundsPaise(prisma, leaver.paymentId)).toBe(
      paidOnLeave,
    );

    await hostCancels(host, cls.appointmentId);

    expect(await refundedPaise(leaver.paymentId)).toBe(paidOnLeave);
    expect(await refundedPaise(stayer.paymentId)).toBe(UNDELIVERED);
    const markers = await prisma.payment.findMany({
      where: { id: { in: [leaver.paymentId, stayer.paymentId] } },
      select: { refundOwedKey: true },
    });
    expect(markers.every((m) => m.refundOwedKey === null)).toBe(true);
  });

  it("pays a seat that took the re-time free leave nothing more", async () => {
    const host = await seedHost();
    const cls = await seedClassUnderWay(host);
    const leaver = await seatBuyer(cls);
    const stayer = await seatBuyer(cls);
    // The host moved the next session an hour ago; the free leave runs two days.
    const next = await prisma.appointmentOccurrence.findFirstOrThrow({
      where: {
        appointmentId: cls.appointmentId,
        completionStatus: "SCHEDULED",
      },
      orderBy: { startsAt: "asc" },
    });
    await prisma.appointmentOccurrence.update({
      where: { id: next.id },
      data: { movedAt: new Date(Date.now() - HOUR_MS) },
    });
    await prisma.class.update({
      where: { id: cls.classId },
      data: { retimeBy: new Date(Date.now() + 2 * DAY_MS) },
    });

    await leave(cls.classId, leaver.userId);
    expect(await refundedPaise(leaver.paymentId)).toBe(UNDELIVERED);

    await hostCancels(host, cls.appointmentId);

    expect(await refundedPaise(leaver.paymentId)).toBe(UNDELIVERED);
    expect(await refundedPaise(stayer.paymentId)).toBe(UNDELIVERED);
  });
});

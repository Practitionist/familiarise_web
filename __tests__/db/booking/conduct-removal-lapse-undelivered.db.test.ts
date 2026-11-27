/**
 * A conduct removal that lapses undecided refunds only what the seat was not
 * delivered, on real Postgres, measured at the removal: a session that had
 * ended by then keeps its pay, and a session under way or later is refunded.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { HOUR_MS, seedHost, type SeededHost } from "./harness";
import { seedSeatBuyer, seedWebinar } from "./harness-seats";
import { refundOnRows, refundedPaise } from "./harness-refunds";

jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/stage-then-attempt", () =>
  jest.requireActual("./harness-edges").noFlushMock(),
);
jest.mock("../../../lib/stream-client", () => ({
  ...jest.requireActual("../../../lib/stream-client"),
  isStreamConfigured: () => false,
}));
jest.mock("../../../lib/stream/event-channel-service", () => ({
  ...jest.requireActual("../../../lib/stream/event-channel-service"),
  removeUsersFromEventChannel: jest.fn(async () => ({ failedUserIds: [] })),
}));

import { removeAttendeeForConduct } from "../../../lib/booking/conduct-removal";
import { sweepConductRemovalDeadlines } from "../../../lib/support/conduct-removal-case";
import { refundBookingPayment } from "../../../lib/payments/operations/booking-refund";

const refundDoor = refundBookingPayment as jest.Mock;
const DAY_MS = 24 * HOUR_MS;
/** 8 sessions for ₹8,000 a seat: ₹1,000 a session. */
const SESSIONS = 8;
const SEAT = 800_000;
const UNIT = SEAT / SESSIONS;

beforeEach(() => {
  jest.clearAllMocks();
  refundDoor.mockReset();
  refundDoor.mockImplementation(refundOnRows);
});

/**
 * A class of 8 hour-long sessions, one a day so no two of the host's confirmed
 * sessions overlap: `delivered` held on past days, then (optionally) one under
 * way right now, the rest from two days out.
 */
async function seedClass(shape: { delivered: number; underWay?: boolean }) {
  const host = await seedHost();
  const now = Date.now();
  const plan = await prisma.classPlan.create({
    data: {
      title: `Database tier class ${randomUUID().slice(0, 8)}`,
      price: BigInt(SEAT),
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
  const startsAt: Date[] = [];
  for (let i = 0; i < SESSIONS; i += 1) {
    const held = i < shape.delivered;
    const live = shape.underWay && i === shape.delivered;
    const start = held
      ? new Date(now - (shape.delivered - i + 6) * DAY_MS)
      : live
        ? new Date(now - HOUR_MS / 2)
        : new Date(now + (i - shape.delivered + 2) * DAY_MS);
    startsAt.push(start);
    await prisma.appointmentOccurrence.create({
      data: {
        appointmentId: appointment.id,
        ordinal: i + 1,
        startsAt: start,
        endsAt: new Date(start.getTime() + HOUR_MS),
        isTentative: false,
        consultantProfileId: host.consultantProfileId,
        completionStatus: held ? "COMPLETED" : "SCHEDULED",
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
  return { host, appointmentId: appointment.id, startsAt };
}

/** A confirmed, card-paid seat bought at `boughtAt` for `sessions` of the event. */
async function seatOn(
  event: { host: SeededHost; appointmentId: string },
  seat: { paise: number; sessions: number | null; boughtAt: Date },
) {
  const buyer = await seedSeatBuyer();
  const payment = await prisma.payment.create({
    data: {
      amount: BigInt(seat.paise),
      originalAmount: BigInt(seat.paise),
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "SUCCEEDED",
      userId: buyer.userId,
      appointmentId: event.appointmentId,
      isMockPayment: true,
      expiresAt: null,
      createdAt: seat.boughtAt,
      legs: { create: [{ source: "CARD", amountPaise: BigInt(seat.paise) }] },
    },
  });
  await prisma.appointmentParticipant.create({
    data: {
      appointmentId: event.appointmentId,
      userId: buyer.userId,
      role: "CONSULTEE",
      status: "CONFIRMED",
      paymentId: payment.id,
      sessionsPurchased: seat.sessions,
      createdAt: seat.boughtAt,
    },
  });
  await prisma.consultantEarnings.create({
    data: {
      consultantProfileId: event.host.consultantProfileId,
      paymentId: payment.id,
      grossAmount: BigInt(seat.paise),
      platformFeePaise: BigInt(seat.paise / 5),
      consultantSharePaise: BigInt(seat.paise - seat.paise / 5),
      status: "PENDING",
      holdUntil: null,
    },
  });
  return { userId: buyer.userId, paymentId: payment.id };
}

/** The host removes the learner now; support does not decide, and the sweep runs 73 hours on. */
async function removeAndLapse(
  event: { host: SeededHost; appointmentId: string },
  userId: string,
) {
  const removed = await removeAttendeeForConduct({
    appointmentId: event.appointmentId,
    targetUserId: userId,
    actorUserId: event.host.userId,
    reason: "HARASSMENT",
    authorizeTx: async () => true,
    note: "Abusive messages in chat",
  });
  const errors: string[] = [];
  await sweepConductRemovalDeadlines({
    limit: 50,
    now: new Date(Date.now() + 73 * HOUR_MS),
    errors,
  });
  expect(errors).toEqual([]);
  return removed!.caseId;
}

const longAgo = () => new Date(Date.now() - 30 * DAY_MS);

describe("a lapsed conduct removal on a class seat", () => {
  it("removed after session 3 of 8: ₹5,000 back under the case's key, the three taught sessions kept", async () => {
    const cls = await seedClass({ delivered: 3 });
    const seat = await seatOn(cls, {
      paise: SEAT,
      sessions: SESSIONS,
      boughtAt: longAgo(),
    });

    const caseId = await removeAndLapse(cls, seat.userId);

    const refunds = await prisma.refund.findMany({
      where: { paymentId: seat.paymentId },
      select: { amountPaise: true, dedupeKey: true },
    });
    expect(refunds).toMatchObject([
      {
        amountPaise: 5 * UNIT,
        dedupeKey: `conduct-removal:${caseId}:pay:${seat.paymentId}`,
      },
    ]);
  });

  it("removed while session 4 is under way: that session is refunded with the rest, ₹5,000", async () => {
    const cls = await seedClass({ delivered: 3, underWay: true });
    const seat = await seatOn(cls, {
      paise: SEAT,
      sessions: SESSIONS,
      boughtAt: longAgo(),
    });

    await removeAndLapse(cls, seat.userId);

    expect(await refundedPaise(seat.paymentId)).toBe(5 * UNIT);
  });

  it("removed before any session: the whole ₹8,000", async () => {
    const cls = await seedClass({ delivered: 0 });
    const seat = await seatOn(cls, {
      paise: SEAT,
      sessions: SESSIONS,
      boughtAt: longAgo(),
    });

    await removeAndLapse(cls, seat.userId);

    expect(await refundedPaise(seat.paymentId)).toBe(SEAT);
  });

  it("a late joiner who bought sessions 3 to 8 for ₹6,000, removed after session 4: ₹4,000", async () => {
    const cls = await seedClass({ delivered: 4 });
    // Bought after session 2 ended and before session 3 began.
    const boughtAt = new Date(cls.startsAt[1].getTime() + 2 * HOUR_MS);
    const seat = await seatOn(cls, { paise: 6 * UNIT, sessions: 6, boughtAt });

    await removeAndLapse(cls, seat.userId);

    expect(await refundedPaise(seat.paymentId)).toBe(4 * UNIT);
  });
});

describe("a lapsed conduct removal on a webinar seat", () => {
  const WEBINAR_SEAT = 100_000;
  const webinarSeat = async (startsAt: Date) => {
    const webinar = await seedWebinar({
      capacity: 10,
      price: WEBINAR_SEAT,
      startsAt,
    });
    const seat = await seatOn(webinar, {
      paise: WEBINAR_SEAT,
      sessions: null,
      boughtAt: longAgo(),
    });
    return { webinar, seat };
  };

  it("removed mid-webinar: refunded in full", async () => {
    const { webinar, seat } = await webinarSeat(
      new Date(Date.now() - HOUR_MS / 2),
    );

    await removeAndLapse(webinar, seat.userId);

    expect(await refundedPaise(seat.paymentId)).toBe(WEBINAR_SEAT);
  });

  it("removed after the webinar ended: nothing is refunded and no refund is left owed", async () => {
    const { webinar, seat } = await webinarSeat(
      new Date(Date.now() - 3 * HOUR_MS),
    );

    await removeAndLapse(webinar, seat.userId);

    expect(await refundedPaise(seat.paymentId)).toBe(0);
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: seat.paymentId },
      select: { refundOwedKey: true },
    });
    expect(payment.refundOwedKey).toBeNull();
  });
});

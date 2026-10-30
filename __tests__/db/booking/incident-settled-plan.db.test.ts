/**
 * An incident declared after a plan or series was settled makes the learner
 * whole exactly once:
 *  - a session a cancelled plan billed as delivered is voided with its unit
 *    stamped owed under the incident key, and the remedy refunds that unit once;
 *  - a cancelled class pays each seat that held the session one unit, and
 *    nothing to a seat that had left before it;
 *  - a live plan still gets its extension and no cash.
 * Real Postgres, a refund door that writes Refund rows.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { HOUR_MS, seedConsultee, seedHost, seedOneToOne } from "./harness";
import { seedSeatBuyer } from "./harness-seats";
import { refundOnRows, refundedPaise } from "./harness-refunds";

jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});

import { enumerateIncident } from "../../../lib/booking/platform-incidents";
import { incidentRefundKey } from "../../../lib/booking/incident-keys";
import { refundIncidentSeat } from "../../../lib/payments/operations/incident-refunds";

const refundDoor = jest.requireMock(
  "../../../lib/payments/operations/booking-refund",
) as { refundBookingPayment: jest.Mock };

beforeEach(() => {
  refundDoor.refundBookingPayment.mockImplementation(refundOnRows);
});

const DAY_MS = 24 * HOUR_MS;

/** A short session `daysAgo` back at a random early-hours instant, so no other row or run overlaps it. */
function pastWindow(daysAgo: number) {
  const startsAt = new Date(Date.now() - daysAgo * DAY_MS);
  startsAt.setUTCHours(
    2,
    Math.floor(Math.random() * 55),
    Math.floor(Math.random() * 60),
    Math.floor(Math.random() * 1000),
  );
  return { startsAt, endsAt: new Date(startsAt.getTime() + 3 * 60_000) };
}

async function declareOver(
  window: { startsAt: Date; endsAt: Date },
  userId: string,
) {
  const incident = await prisma.platformIncident.create({
    data: {
      startsAt: new Date(window.startsAt.getTime() + 60_000),
      endsAt: new Date(window.startsAt.getTime() + 2 * 60_000),
      reason: `db tier ${randomUUID()}`,
      declaredByUserId: userId,
    },
  });
  const failures: unknown[] = [];
  const complete = await enumerateIncident(
    incident,
    { limit: 10, pastDeadline: () => false, now: new Date() },
    {
      voided: 0,
      remediesCreated: 0,
      failed: (_id, error) => failures.push(error),
    },
  );
  expect(failures).toEqual([]);
  expect(complete).toBe(true);
  return incident.id;
}

/** A 1:1 plan of four sessions whose one session in `window` was delivered. */
async function seedDeliveredPlanSession(
  status: "CANCELLED" | "APPROVED",
  window: { startsAt: Date; endsAt: Date },
) {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const booking = await seedOneToOne("subscription", host, buyer, window, {
    status,
    isTentative: false,
    completionStatus: "COMPLETED",
    participantStatus: status === "CANCELLED" ? "CANCELLED" : "CONFIRMED",
    payment: { status: "SUCCEEDED", expiresAt: null },
  });
  const boughtAt = new Date(window.startsAt.getTime() - 10 * DAY_MS);
  await prisma.subscription.update({
    where: { id: booking.subscriptionId! },
    data: { sessionsTotal: 4 },
  });
  await prisma.payment.update({
    where: { id: booking.payment!.id },
    data: { createdAt: boughtAt },
  });
  await prisma.appointmentParticipant.updateMany({
    where: { appointmentId: booking.appointmentId },
    data: { createdAt: boughtAt },
  });
  return { host, buyer, booking, paymentId: booking.payment!.id };
}

const remediesOf = (occurrenceId: string) =>
  prisma.incidentRemedy.findMany({
    where: { occurrenceId },
    select: { kind: true, userId: true, paymentId: true, incidentId: true },
  });

const markerOf = async (paymentId: string) => {
  const row = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    select: { refundOwedKey: true, refundOwedPaise: true },
  });
  return {
    refundOwedKey: row.refundOwedKey,
    refundOwedPaise: row.refundOwedPaise,
  };
};

describe("an incident after the plan was settled", () => {
  it("voids a cancelled plan's delivered session and refunds its unit exactly once", async () => {
    const window = pastWindow(6);
    const { host, buyer, booking, paymentId } = await seedDeliveredPlanSession(
      "CANCELLED",
      window,
    );

    const incidentId = await declareOver(window, host.userId);

    const occ = await prisma.appointmentOccurrence.findUniqueOrThrow({
      where: { id: booking.occurrenceId },
    });
    expect(occ.completionStatus).toBe("VOIDED");
    const key = incidentRefundKey(incidentId, occ.id, buyer.userId);
    expect(await markerOf(paymentId)).toEqual({
      refundOwedKey: key,
      refundOwedPaise: 25_000,
    });
    expect(await remediesOf(occ.id)).toEqual([
      { kind: "REFUND_NOW", userId: buyer.userId, paymentId, incidentId },
    ]);

    const seat = {
      incidentId,
      occurrenceId: occ.id,
      userId: buyer.userId,
      paymentId,
      trialId: null,
    };
    await expect(refundIncidentSeat(seat)).resolves.toEqual({
      kind: "done",
      refundedPaise: 25_000,
    });
    await refundIncidentSeat(seat);

    expect(await refundedPaise(paymentId)).toBe(25_000);
    expect((await markerOf(paymentId)).refundOwedKey).toBeNull();
  });

  it("gives a live plan its extension and stamps no cash", async () => {
    const window = pastWindow(5);
    const { host, booking, paymentId } = await seedDeliveredPlanSession(
      "APPROVED",
      window,
    );

    await declareOver(window, host.userId);

    expect((await remediesOf(booking.occurrenceId)).map((r) => r.kind)).toEqual(
      ["SUBSCRIPTION_EXTEND"],
    );
    expect((await markerOf(paymentId)).refundOwedKey).toBeNull();
  });

  it("pays each seat of a cancelled class that held the session one unit, and none that left before it", async () => {
    const window = pastWindow(4);
    const host = await seedHost();
    const plan = await prisma.classPlan.create({
      data: {
        title: `Database tier class ${randomUUID().slice(0, 8)}`,
        price: BigInt(10_000),
        totalSessions: 10,
        consultantProfileId: host.consultantProfileId,
      },
    });
    const cls = await prisma.class.create({
      data: { classPlanId: plan.id, status: "CANCELLED" },
    });
    const appointment = await prisma.appointment.create({
      data: { appointmentType: "CLASS", classId: cls.id },
    });
    const occurrence = await prisma.appointmentOccurrence.create({
      data: {
        appointmentId: appointment.id,
        ordinal: 1,
        ...window,
        isTentative: false,
        consultantProfileId: host.consultantProfileId,
        completionStatus: "COMPLETED",
      },
    });
    const boughtAt = new Date(window.startsAt.getTime() - 10 * DAY_MS);
    const seat = async () => {
      const buyer = await seedSeatBuyer();
      const payment = await prisma.payment.create({
        data: {
          amount: BigInt(10_000),
          originalAmount: BigInt(10_000),
          paymentMethod: "card",
          paymentIntent: `order_dbtier_${randomUUID()}`,
          paymentGateway: "RAZORPAY",
          paymentStatus: "SUCCEEDED",
          userId: buyer.userId,
          appointmentId: appointment.id,
          isMockPayment: true,
          createdAt: boughtAt,
          legs: { create: [{ source: "CARD", amountPaise: BigInt(10_000) }] },
        },
      });
      const row = await prisma.appointmentParticipant.create({
        data: {
          appointmentId: appointment.id,
          userId: buyer.userId,
          role: "CONSULTEE",
          status: "CANCELLED",
          paymentId: payment.id,
          sessionsPurchased: 10,
          createdAt: boughtAt,
        },
      });
      return { userId: buyer.userId, paymentId: payment.id, seatId: row.id };
    };
    const held = await seat();
    const leftEarly = await seat();
    // Released a day before the session, so it never held it.
    await prisma.$executeRaw`UPDATE "AppointmentParticipant" SET "updatedAt" = ${new Date(window.startsAt.getTime() - DAY_MS)} WHERE id = ${leftEarly.seatId}`;

    const incidentId = await declareOver(window, host.userId);

    expect(await remediesOf(occurrence.id)).toEqual([
      {
        kind: "REFUND_NOW",
        userId: held.userId,
        paymentId: held.paymentId,
        incidentId,
      },
    ]);
    expect(await markerOf(held.paymentId)).toEqual({
      refundOwedKey: incidentRefundKey(incidentId, occurrence.id, held.userId),
      refundOwedPaise: 1_000,
    });
    expect((await markerOf(leftEarly.paymentId)).refundOwedKey).toBeNull();
  });
});

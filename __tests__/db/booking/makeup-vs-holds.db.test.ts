/**
 * A class make-up is refused on a host time that any live hold occupies —
 * a pending request, a live checkout, an unpaid approval, a reschedule hold or
 * a confirmed booking — and allowed once a checkout hold has lapsed. Real
 * Postgres, real occupancy predicates.
 */
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
  type SeededHost,
} from "./harness";

jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});

import {
  readHostedClass,
  scheduleClassMakeUp,
} from "../../../lib/booking/class-sessions";
import { BookingRuleError } from "../../../lib/booking/booking-rule-error";
import { quoteSeatLeave } from "../../../lib/booking/seat-leave";
import { seedSeatBuyer } from "./harness-seats";

/** A scheduled class of `host` whose first session the host cancelled (a miss). */
async function seedMissedClass(host: SeededHost) {
  const plan = await prisma.classPlan.create({
    data: {
      title: "Database tier class",
      price: BigInt(200_000),
      consultantProfileId: host.consultantProfileId,
    },
  });
  const cls = await prisma.class.create({
    data: { classPlanId: plan.id, status: "SCHEDULED" },
  });
  const appointment = await prisma.appointment.create({
    data: { appointmentType: "CLASS", classId: cls.id },
  });
  const source = await prisma.appointmentOccurrence.create({
    data: {
      appointmentId: appointment.id,
      ordinal: 1,
      startsAt: futureAt(1, 9),
      endsAt: futureAt(1, 10),
      isTentative: false,
      consultantProfileId: host.consultantProfileId,
      completionStatus: "CANCELLED",
      hostCancelledAt: new Date(),
    },
  });
  await prisma.appointmentParticipant.create({
    data: {
      appointmentId: appointment.id,
      userId: host.userId,
      role: "CONSULTANT",
      status: "CONFIRMED",
    },
  });
  return { appointmentId: appointment.id, sourceId: source.id };
}

async function makeUpAt(host: SeededHost, startsAt: Date) {
  const { appointmentId, sourceId } = await seedMissedClass(host);
  const hosted = await readHostedClass(appointmentId);
  if (!hosted.found) throw new Error("class not found");
  return scheduleClassMakeUp(hosted, sourceId, startsAt).then(
    () => "scheduled" as const,
    (error: unknown) => error,
  );
}

const WINDOW = () => ({ startsAt: futureAt(4, 9), endsAt: futureAt(4, 10) });
const LIVE_PAYMENT = () => ({
  status: "PENDING" as const,
  expiresAt: new Date(Date.now() + 30 * 60_000),
});

describe("make-up × every hold kind on the host's time", () => {
  it.each([
    [
      "a pending request hold",
      {
        status: "PENDING" as const,
        bookingSource: "REQUEST_SUBMITTED" as const,
        isTentative: true,
      },
    ],
    [
      "a live direct-checkout hold",
      {
        status: "PENDING" as const,
        bookingSource: "DIRECT_CHECKOUT" as const,
        isTentative: true,
        payment: LIVE_PAYMENT(),
      },
    ],
    [
      "an unpaid approval",
      {
        status: "APPROVED_PENDING_PAYMENT" as const,
        bookingSource: "REQUEST_SUBMITTED" as const,
        isTentative: true,
        payment: LIVE_PAYMENT(),
      },
    ],
    [
      "a reschedule hold",
      {
        status: "APPROVED" as const,
        isTentative: true,
        completionStatus: "RESCHEDULED" as const,
        payment: { status: "SUCCEEDED" as const, expiresAt: null },
      },
    ],
    [
      "a confirmed booking",
      {
        status: "APPROVED" as const,
        isTentative: false,
        payment: { status: "SUCCEEDED" as const, expiresAt: null },
      },
    ],
  ])(
    "is refused on %s",
    async (_label, shape) => {
      const host = await seedHost();
      await seedOneToOne(
        "consultation",
        host,
        await seedConsultee(),
        WINDOW(),
        shape,
      );
      const outcome = await makeUpAt(host, WINDOW().startsAt);
      expect(outcome).toBeInstanceOf(BookingRuleError);
      expect((outcome as BookingRuleError).code).toBe("SCHEDULE_CONFLICT");
      expect((outcome as BookingRuleError).httpStatus).toBe(409);
      expect(
        await prisma.appointmentOccurrence.count({
          where: {
            consultantProfileId: host.consultantProfileId,
            startsAt: WINDOW().startsAt,
            appointment: { classId: { not: null } },
          },
        }),
      ).toBe(0);
    },
    30_000,
  );

  it("is allowed once a checkout hold has lapsed", async () => {
    const host = await seedHost();
    await seedOneToOne("consultation", host, await seedConsultee(), WINDOW(), {
      status: "PENDING",
      bookingSource: "DIRECT_CHECKOUT",
      isTentative: true,
      payment: { status: "PENDING", expiresAt: new Date(Date.now() - HOUR_MS) },
    });
    expect(await makeUpAt(host, WINDOW().startsAt)).toBe("scheduled");
  }, 30_000);
});

describe("make-up × the attendee's free leave", () => {
  it("lets a seat bought before the make-up leave with every undelivered session refunded", async () => {
    const host = await seedHost();
    const { appointmentId, sourceId } = await seedMissedClass(host);
    const cls = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
      select: { classId: true, class: { select: { classPlanId: true } } },
    });
    const classId = cls.classId ?? "";
    // The whole run sits inside the plan's refund window.
    await prisma.classPlan.update({
      where: { id: cls.class?.classPlanId ?? "" },
      data: { refundWindowHours: 400 },
    });
    await prisma.appointmentOccurrence.create({
      data: {
        appointmentId,
        ordinal: 2,
        startsAt: futureAt(6, 9),
        endsAt: futureAt(6, 10),
        isTentative: false,
        consultantProfileId: host.consultantProfileId,
      },
    });
    const buyer = await seedSeatBuyer();
    const price = BigInt(200_000);
    const payment = await prisma.payment.create({
      data: {
        amount: price,
        originalAmount: price,
        paymentMethod: "card",
        paymentIntent: `order_dbtier_makeup_${appointmentId}`,
        paymentGateway: "RAZORPAY",
        paymentStatus: "SUCCEEDED",
        userId: buyer.userId,
        appointmentId,
        isMockPayment: true,
        legs: { create: [{ source: "CARD", amountPaise: price }] },
      },
    });
    await prisma.appointmentParticipant.create({
      data: {
        appointmentId,
        userId: buyer.userId,
        role: "CONSULTEE",
        status: "CONFIRMED",
        paymentId: payment.id,
      },
    });

    expect(await quoteSeatLeave("class", classId, buyer.userId)).toMatchObject({
      seated: true,
      refused: true,
    });

    const hosted = await readHostedClass(appointmentId);
    if (!hosted.found) throw new Error("class not found");
    await scheduleClassMakeUp(hosted, sourceId, futureAt(5, 9));

    expect(await quoteSeatLeave("class", classId, buyer.userId)).toMatchObject({
      seated: true,
      refused: false,
      estimatedRefundPaise: 200_000,
    });
  }, 30_000);
});

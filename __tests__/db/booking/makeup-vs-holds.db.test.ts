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
  const hosted = await readHostedClass(appointmentId, {
    userId: host.userId,
    consultantProfileId: host.consultantProfileId,
    isPrivileged: false,
  });
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

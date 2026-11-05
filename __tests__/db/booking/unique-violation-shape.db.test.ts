/**
 * Unique violations are classified by constraint on the real Prisma 7 +
 * adapter-pg error shape: the idempotency key and the live-ordinal index are
 * told apart, and createAppointments turns a live-ordinal clash into a typed
 * ALREADY_ALLOCATED instead of a taken slot or a fault.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";
import { isUniqueViolationOn } from "../../../lib/db/unique-violation";
import { createAppointments } from "../../../lib/booking/allocation/commit/create-appointments";
import { AllocationConflictError } from "../../../utils/scheduling-engine/errors";

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a unique violation");
}

describe("unique violations by constraint (real Postgres)", () => {
  async function seedBooking(day: number) {
    const host = await seedHost();
    return seedOneToOne(
      "consultation",
      host,
      await seedConsultee(),
      { startsAt: futureAt(day, 9), endsAt: futureAt(day, 10) },
      {
        status: "PENDING",
        bookingSource: "REQUEST_SUBMITTED",
        isTentative: true,
      },
    ).then((booking) => ({ ...booking, host }));
  }

  it("names the idempotency key, not the ordinal", async () => {
    const key = `alloc-${randomUUID()}`;
    const first = await seedBooking(5);
    const second = await seedBooking(6);
    await prisma.appointment.update({
      where: { id: first.appointmentId },
      data: { allocationIdempotencyKey: key },
    });
    const error = await caught(() =>
      prisma.appointment.update({
        where: { id: second.appointmentId },
        data: { allocationIdempotencyKey: key },
      }),
    );
    expect(isUniqueViolationOn(error, "allocationIdempotencyKey")).toBe(true);
    expect(isUniqueViolationOn(error, "ordinal")).toBe(false);
  });

  it("names the live ordinal, not the idempotency key", async () => {
    const booking = await seedBooking(7);
    const error = await caught(() =>
      prisma.appointmentOccurrence.create({
        data: {
          appointmentId: booking.appointmentId,
          ordinal: 1,
          startsAt: futureAt(8, 9),
          endsAt: new Date(futureAt(8, 9).getTime() + HOUR_MS),
          isTentative: true,
          consultantProfileId: booking.host.consultantProfileId,
        },
      }),
    );
    expect(isUniqueViolationOn(error, "ordinal")).toBe(true);
    expect(isUniqueViolationOn(error, "allocationIdempotencyKey")).toBe(false);
  });

  it("createAppointments answers a live-ordinal clash as ALREADY_ALLOCATED", async () => {
    const host = await seedHost();
    const plan = await prisma.consultationPlan.create({
      data: {
        title: "Ordinal clash",
        price: BigInt(0),
        consultantProfileId: host.consultantProfileId,
        durationInHours: 1,
      },
    });
    const consultation = await prisma.consultation.create({
      data: {
        consultationPlanId: plan.id,
        requestedById: (await seedConsultee()).consulteeProfileId,
        status: "PENDING",
      },
    });
    const wrapper = await prisma.appointment.create({
      data: {
        appointmentType: "CONSULTATION",
        consultationId: consultation.id,
      },
    });
    // A live row already holds ordinal 1 on the wrapper.
    await prisma.appointmentOccurrence.create({
      data: {
        appointmentId: wrapper.id,
        ordinal: 1,
        startsAt: futureAt(8, 9),
        endsAt: futureAt(8, 10),
        isTentative: false,
        consultantProfileId: host.consultantProfileId,
      },
    });
    const starts = [
      futureAt(9, 9),
      new Date(futureAt(9, 9).getTime() + 30 * 60_000),
    ];

    const error = await caught(() =>
      prisma.$transaction((tx) =>
        createAppointments(
          tx,
          "consultation",
          consultation.id,
          starts,
          host.userId,
          undefined,
          { durationInHours: 1 },
          null,
          wrapper.id,
          undefined,
          [1],
        ),
      ),
    );

    expect(error).toBeInstanceOf(AllocationConflictError);
    expect((error as AllocationConflictError).errorCode).toBe(
      "ALREADY_ALLOCATED",
    );
  });
});

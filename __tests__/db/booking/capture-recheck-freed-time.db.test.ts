/**
 * The capture's confirm-time recheck uses every reader's row predicate: a
 * returned (CANCELLED) or host-cancelled row has freed its time, so a buyer
 * who paid for that time is confirmed, not refunded. A live confirmed row
 * still blocks.
 */
import { Prisma } from "@prisma/client";
import prisma from "../../../lib/prisma";
import { confirmExistingAppointment } from "../../../lib/payments/webhooks/handlers";
import {
  futureAt,
  HOUR_MS,
  overlappingOccupyingPairs,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";

async function capture(appointmentId: string, payerUserId: string) {
  return prisma.$transaction(
    (tx) => confirmExistingAppointment(tx, appointmentId, payerUserId),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function seedPaidHold(
  host: Awaited<ReturnType<typeof seedHost>>,
  startsAt: Date,
) {
  const buyer = await seedConsultee();
  const hold = await seedOneToOne(
    "consultation",
    host,
    buyer,
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: "PENDING",
      bookingSource: "DIRECT_CHECKOUT",
      isTentative: true,
      payment: { status: "PENDING" },
    },
  );
  return { buyer, hold };
}

describe("capture recheck × freed host time", () => {
  it("confirms a capture into a session the previous client returned", async () => {
    const host = await seedHost();
    const startsAt = futureAt(5, 10);
    await seedOneToOne(
      "subscription",
      host,
      await seedConsultee(),
      { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
      { status: "APPROVED", isTentative: false, completionStatus: "CANCELLED" },
    );
    const { buyer, hold } = await seedPaidHold(host, startsAt);

    const result = await capture(hold.appointmentId, buyer.userId);

    expect(result.doubleBookingBlocked).toBeFalsy();
    const row = await prisma.appointmentOccurrence.findUniqueOrThrow({
      where: { id: hold.occurrenceId },
    });
    expect(row.isTentative).toBe(false);
    expect(await overlappingOccupyingPairs(host.consultantProfileId)).toBe(0);
  });

  it("confirms a capture into a session the host cancelled", async () => {
    const host = await seedHost();
    const startsAt = futureAt(6, 10);
    const freed = await seedOneToOne(
      "subscription",
      host,
      await seedConsultee(),
      { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
      { status: "APPROVED", isTentative: false },
    );
    // The class-session cancel's shape: the confirmed row stays, stamped cancelled by the host.
    await prisma.$executeRaw`UPDATE "AppointmentOccurrence" SET "hostCancelledAt" = now(), "completionStatus" = 'CANCELLED' WHERE id = ${freed.occurrenceId}`;
    const { buyer, hold } = await seedPaidHold(host, startsAt);

    const result = await capture(hold.appointmentId, buyer.userId);

    expect(result.doubleBookingBlocked).toBeFalsy();
  });

  it("still blocks a capture onto a live confirmed session", async () => {
    const host = await seedHost();
    const startsAt = futureAt(7, 10);
    await seedOneToOne(
      "subscription",
      host,
      await seedConsultee(),
      { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
      { status: "APPROVED", isTentative: false },
    );
    const { buyer, hold } = await seedPaidHold(host, startsAt);

    const result = await capture(hold.appointmentId, buyer.userId);

    expect(result.doubleBookingBlocked).toBe(true);
  });
});

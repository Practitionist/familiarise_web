/**
 * A paid consultation parked after a failed restore, on real Postgres: the
 * expiry run leaves it alone inside both deadlines, and cancels it with a full
 * refund owed in the same commit once 48 h pass after the released session's
 * original start; a strike lands only when the consultant started the move.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { HOUR_MS, seedConsultee, seedHost, seedOneToOne } from "./harness";
import { refundedPaise, refundOnRowsEachTest } from "./harness-refunds";

jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/service", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);

import { cancelAgedParkedConsultations } from "../../../lib/booking/parked-consultation-sweep";

refundOnRowsEachTest();

const PRICE = 150_000;

/** A paid consultation whose only session was released and never re-placed. */
async function seedParked(opts: {
  startsInHours: number;
  resolvedHoursAgo: number;
  initiator: "CONSULTEE" | "CONSULTANT";
}) {
  const host = await seedHost();
  const consultee = await seedConsultee();
  const startsAt = new Date(Date.now() + opts.startsInHours * HOUR_MS);
  const booking = await seedOneToOne(
    "consultation",
    host,
    consultee,
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: "APPROVED",
      isTentative: true,
      completionStatus: "RESCHEDULED",
      participantStatus: "CONFIRMED",
      payment: { status: "SUCCEEDED", amount: PRICE, expiresAt: null },
    },
  );
  await prisma.rescheduleRequest.create({
    data: {
      appointmentId: booking.appointmentId,
      initiatorRole: opts.initiator,
      initiatedById:
        opts.initiator === "CONSULTANT" ? host.userId : consultee.userId,
      status: "DECLINED",
      releasedOccurrenceIds: [booking.occurrenceId],
      releasedSessions: [{ ordinal: 1, startsAt: startsAt.toISOString() }],
      originStatus: "APPROVED",
      expiresAt: new Date(Date.now() - opts.resolvedHoursAgo * HOUR_MS),
      resolvedAt: new Date(Date.now() - opts.resolvedHoursAgo * HOUR_MS),
      reason: `db tier ${randomUUID().slice(0, 6)}`,
    },
  });
  return { host, consultee, booking };
}

async function strikesFor(consultantProfileId: string) {
  return prisma.systemEvent.count({
    where: { correlationId: `expert-reliability:${consultantProfileId}` },
  });
}

describe("the parked-consultation sweep", () => {
  it("leaves a park inside both deadlines alone", async () => {
    const { booking } = await seedParked({
      startsInHours: 72,
      resolvedHoursAgo: 24,
      initiator: "CONSULTANT",
    });

    await cancelAgedParkedConsultations();

    const row = await prisma.consultation.findUniqueOrThrow({
      where: { id: booking.consultationId ?? "" },
      select: { status: true },
    });
    expect(row.status).toBe("APPROVED");
  });

  it("cancels 48 h past the original start with a full refund and a strike on a consultant-started move", async () => {
    const { host, booking } = await seedParked({
      startsInHours: -50,
      resolvedHoursAgo: 24,
      initiator: "CONSULTANT",
    });

    const result = await cancelAgedParkedConsultations();

    expect(result.cancelled).toBeGreaterThanOrEqual(1);
    const row = await prisma.consultation.findUniqueOrThrow({
      where: { id: booking.consultationId ?? "" },
      select: { status: true },
    });
    expect(row.status).toBe("CANCELLED");
    const released = await prisma.appointmentOccurrence.findUniqueOrThrow({
      where: { id: booking.occurrenceId },
      select: { completionStatus: true },
    });
    expect(released.completionStatus).toBe("CANCELLED");
    expect(await refundedPaise(booking.payment?.id ?? "")).toBe(PRICE);
    expect(await strikesFor(host.consultantProfileId)).toBe(1);
  });

  it("cancels 7 days after the park with no strike on a consultee-started move", async () => {
    const { host, booking } = await seedParked({
      startsInHours: 24 * 10,
      resolvedHoursAgo: 24 * 7 + 1,
      initiator: "CONSULTEE",
    });

    await cancelAgedParkedConsultations();

    const row = await prisma.consultation.findUniqueOrThrow({
      where: { id: booking.consultationId ?? "" },
      select: { status: true },
    });
    expect(row.status).toBe("CANCELLED");
    expect(await refundedPaise(booking.payment?.id ?? "")).toBe(PRICE);
    expect(await strikesFor(host.consultantProfileId)).toBe(0);
  });
});

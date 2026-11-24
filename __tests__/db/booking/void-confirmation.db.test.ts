/**
 * The 14-day void refund on real Postgres waits for a negative verdict's
 * confirmation: an unconfirmed host-attributed void is not in the cohort, and a
 * confirmed one, an outage void and a void with no outcome are.
 */
import type { OccurrenceOutcome } from "@prisma/client";
import prisma from "../../../lib/prisma";
import { settleCancelledSessionForOne } from "../../../scripts/appointments/settle-cancelled-sessions";
import { refundOnRowsEachTest } from "./harness-refunds";
import { HOUR_MS, seedConsultee, seedHost, seedOneToOne } from "./harness";

jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/stage-then-attempt", () => ({
  __esModule: true,
  flushNotificationsAfter: jest.fn(async () => undefined),
}));

refundOnRowsEachTest();

const DAY_MS = 24 * HOUR_MS;

/** A paid consultation whose one session was voided 15 days ago with `outcome`. */
async function seedVoid(outcome: OccurrenceOutcome | null, confirmed: boolean) {
  const endsAt = new Date(Date.now() - 16 * DAY_MS);
  const booking = await seedOneToOne(
    "consultation",
    await seedHost(),
    await seedConsultee(),
    { startsAt: new Date(endsAt.getTime() - HOUR_MS), endsAt },
    {
      status: "APPROVED",
      isTentative: false,
      completionStatus: "VOIDED",
      payment: { status: "SUCCEEDED", expiresAt: null },
    },
  );
  // The seat and its payment predate the session, so the session is one the seat held.
  const bought = new Date(endsAt.getTime() - 4 * DAY_MS);
  await prisma.appointmentParticipant.updateMany({
    where: { appointmentId: booking.appointmentId },
    data: { createdAt: bought },
  });
  await prisma.payment.update({
    where: { id: booking.payment!.id },
    data: { createdAt: bought },
  });
  const voidedAt = new Date(Date.now() - 15 * DAY_MS);
  await prisma.appointmentOccurrence.update({
    where: { id: booking.occurrenceId },
    data: {
      outcome,
      outcomeAt: voidedAt,
      voidedAt,
      outcomeConfirmedAt: confirmed ? voidedAt : null,
    },
  });
  return booking;
}

const settledOne = async (occurrenceId: string) => {
  const run = await settleCancelledSessionForOne(occurrenceId);
  const row = await prisma.appointmentOccurrence.findUniqueOrThrow({
    where: { id: occurrenceId },
    select: { seatsSettledAt: true },
  });
  return { scanned: run.scanned, settled: row.seatsSettledAt !== null };
};

it("leaves an unconfirmed host-attributed void out, and settles a confirmed one, an outage void and an outcome-less void", async () => {
  const weak = await seedVoid("HOST_ABSENT", false);
  const cutShort = await seedVoid("CUT_SHORT", false);
  const opsWritten = await seedVoid("HOST_ABSENT", true);
  const outage = await seedVoid("PLATFORM_OUTAGE", false);
  const noOutcome = await seedVoid(null, false);

  expect(await settledOne(weak.occurrenceId)).toEqual({
    scanned: 0,
    settled: false,
  });
  expect(await settledOne(cutShort.occurrenceId)).toEqual({
    scanned: 0,
    settled: false,
  });
  for (const booking of [opsWritten, outage, noOutcome]) {
    expect(await settledOne(booking.occurrenceId)).toEqual({
      scanned: 1,
      settled: true,
    });
  }
  // The ops-written void, confirmed when it was written, is refunded in full.
  const refunds = await prisma.refund.findMany({
    where: { paymentId: opsWritten.payment!.id },
    select: { dedupeKey: true, amountPaise: true },
  });
  expect(refunds.map((r) => [r.dedupeKey, Number(r.amountPaise)])).toEqual([
    [`occ:${opsWritten.occurrenceId}:pay:${opsWritten.payment!.id}`, 100_000],
  ]);
  expect(
    await prisma.refund.count({ where: { paymentId: weak.payment!.id } }),
  ).toBe(0);
});

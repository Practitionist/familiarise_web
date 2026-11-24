/**
 * A host-attributed class void counts toward the exit right and the host's
 * reliability flag only once its verdict is confirmed, on real Postgres: the
 * sweep's unconfirmed void raises nothing, ops Confirm raises both once, and an
 * outage void counts toward the exit right as before with no flag.
 */
import "./harness-cancel-route";
import prisma from "../../../lib/prisma";
import { onClassSessionVoided } from "../../../lib/booking/class-sessions";
import { confirmSessionOutcome } from "../../../lib/backoffice/session-outcomes";
import { seriesLedger } from "../../../lib/booking/class-series";
import { HOUR_MS, seedHost } from "./harness";
import {
  CLASS_UNDER_WAY as SHAPE,
  seatClassBuyer,
  seedClassUnderWay,
} from "./harness-class-series";

const DAY_MS = 24 * HOUR_MS;

/** Three upcoming sessions voided over the last three days with `outcome`; the first two confirmed. */
async function seedThreeVoids(outcome: "HOST_ABSENT" | "PLATFORM_OUTAGE") {
  const host = await seedHost();
  const cls = await seedClassUnderWay(host, SHAPE);
  await seatClassBuyer(cls, SHAPE);
  const voided = cls.occurrenceIds.slice(SHAPE.delivered, SHAPE.delivered + 3);
  for (const [i, id] of voided.entries()) {
    const at = new Date(Date.now() - (3 - i) * DAY_MS);
    await prisma.appointmentOccurrence.update({
      where: { id },
      data: {
        completionStatus: "VOIDED",
        voidedAt: at,
        outcome,
        outcomeAt: at,
        outcomeConfirmedAt: i < 2 && outcome === "HOST_ABSENT" ? at : null,
      },
    });
  }
  return { cls, third: voided[2] };
}

/** The sweep's hook for the third void, in its own transaction, as the slot pass calls it. */
const sweepVoids = (cls: { appointmentId: string }, occurrenceId: string) =>
  prisma.$transaction((tx) =>
    onClassSessionVoided(tx, {
      appointmentId: cls.appointmentId,
      occurrenceId,
      startsAt: new Date(),
      voidedAt: new Date(),
      hostAttributed: true,
    }),
  );

const flags = (classId: string) =>
  prisma.systemEvent.count({
    where: { correlationId: `class-reliability:${classId}` },
  });

it("raises neither the flag nor the exit bells on an unconfirmed host void, and both once on its confirmation", async () => {
  const { cls, third } = await seedThreeVoids("HOST_ABSENT");

  const swept = await sweepVoids(cls, third);
  expect(swept.exitEmailArgs).toBeNull();
  expect(await flags(cls.classId)).toBe(0);
  expect(await seriesLedger(prisma, cls.appointmentId)).toMatchObject({
    misses: 2,
    hostMisses: 2,
    exitRight: false,
  });

  const confirmed = await prisma.$transaction((tx) =>
    confirmSessionOutcome(tx, { occurrenceId: third, outcome: "HOST_ABSENT" }),
  );
  expect(confirmed.afterCommit).toBeDefined();
  expect(await flags(cls.classId)).toBe(1);
  expect(await seriesLedger(prisma, cls.appointmentId)).toMatchObject({
    misses: 3,
    hostMisses: 3,
    exitRight: true,
  });
});

it("an unconfirmed host void after ops cleared the flag raises it again only on its confirmation", async () => {
  const { cls, third } = await seedThreeVoids("HOST_ABSENT");
  await prisma.$transaction((tx) =>
    confirmSessionOutcome(tx, { occurrenceId: third, outcome: "HOST_ABSENT" }),
  );
  // Ops cleared the flag the three confirmed misses raised.
  await prisma.systemEvent.create({
    data: {
      category: "BOOKING",
      message: "Class reliability flag cleared",
      context: { cleared: true },
      correlationId: `class-reliability:${cls.classId}`,
    },
  });
  const fourth = cls.occurrenceIds[SHAPE.delivered + 3];
  const at = new Date();
  await prisma.appointmentOccurrence.update({
    where: { id: fourth },
    data: {
      completionStatus: "VOIDED",
      voidedAt: at,
      outcome: "CUT_SHORT",
      outcomeAt: at,
    },
  });

  await sweepVoids(cls, fourth);
  expect(await flags(cls.classId)).toBe(2);

  await prisma.$transaction((tx) =>
    confirmSessionOutcome(tx, { occurrenceId: fourth, outcome: "CUT_SHORT" }),
  );
  expect(await flags(cls.classId)).toBe(3);
});

it("counts an outage void toward the exit right at once, and never toward the flag", async () => {
  const { cls, third } = await seedThreeVoids("PLATFORM_OUTAGE");

  const swept = await prisma.$transaction((tx) =>
    onClassSessionVoided(tx, {
      appointmentId: cls.appointmentId,
      occurrenceId: third,
      startsAt: new Date(),
      voidedAt: new Date(),
      hostAttributed: false,
    }),
  );

  expect(swept.exitEmailArgs).not.toBeNull();
  expect(await flags(cls.classId)).toBe(0);
  expect(await seriesLedger(prisma, cls.appointmentId)).toMatchObject({
    misses: 3,
    hostMisses: 0,
    exitRight: true,
  });
});

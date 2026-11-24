/**
 * The class exit right is derived from the misses, so an ops correction that
 * removes a miss (an un-void of a session that was not the host's fault) can
 * withdraw a right the learner has not used yet. A right already used is final:
 * the learner's exit refund stays, and a replayed exit is a no-op rather than a
 * fresh check. Concurrent misses are serialised on the class without
 * deadlocking against the history rows their writes insert, so the exit email
 * goes out once and a miss racing the whole-event cancel lets both commit. Real Postgres, the real seat-leave door.
 */
import "./harness-cancel-route";
import prisma from "../../../lib/prisma";
import { HOUR_MS, seedHost } from "./harness";

import type { Tx } from "../../../lib/prisma";
import { onClassSessionVoided } from "../../../lib/booking/class-sessions";
import { transitionOccurrenceCompletion } from "../../../lib/booking/transitions";
import { leaveEventSeat } from "../../../lib/booking/seat-leave";
import {
  CLASS_UNDER_WAY as SHAPE,
  hostCancels,
  seatClassBuyer,
  seedClassUnderWay,
} from "./harness-class-series";
import { refundedPaise, refundOnRowsEachTest } from "./harness-refunds";

refundOnRowsEachTest();

const exit = (classId: string, userId: string) =>
  leaveEventSeat({
    kind: "class",
    eventId: classId,
    userId,
    actorUserId: userId,
    isSelfLeave: true,
    exit: true,
  });

it("an ops un-void withdraws an unused exit right; a used one stays final", async () => {
  const host = await seedHost();
  const cls = await seedClassUnderWay(host, SHAPE);
  const used = await seatClassBuyer(cls, SHAPE);
  const unused = await seatClassBuyer(cls, SHAPE);
  // Three upcoming sessions voided as host-absent within the last three days.
  const voided = cls.occurrenceIds.slice(SHAPE.delivered, SHAPE.delivered + 3);
  for (const [i, id] of voided.entries()) {
    await prisma.appointmentOccurrence.update({
      where: { id },
      data: {
        completionStatus: "VOIDED",
        voidedAt: new Date(Date.now() - (i + 1) * 24 * HOUR_MS),
        outcome: "HOST_ABSENT",
        // Confirmed, so each void counts toward the exit right.
        outcomeConfirmedAt: new Date(),
      },
    });
  }

  expect(await exit(cls.classId, used.userId)).not.toBeNull();
  const paidOnExit = await refundedPaise(used.paymentId);
  expect(paidOnExit).toBeGreaterThan(0);

  // Ops overturns one void: the session was held after all.
  await prisma.appointmentOccurrence.update({
    where: { id: voided[2] },
    data: { completionStatus: "COMPLETED", voidedAt: null, outcome: "HELD" },
  });

  await expect(exit(cls.classId, unused.userId)).rejects.toMatchObject({
    code: "EXIT_NOT_AVAILABLE",
  });
  expect(await refundedPaise(unused.paymentId)).toBe(0);

  // The used right is not re-checked: a replay finds no seat and moves nothing.
  expect(await exit(cls.classId, used.userId)).toBeNull();
  expect(await refundedPaise(used.paymentId)).toBe(paidOnExit);
});

/** An outcome-sweep outage void through the real write helper, which also writes the history row; it needs no confirmation to count. */
const voidAsSweep = (tx: Tx, occurrenceId: string, at: Date) =>
  transitionOccurrenceCompletion(tx, {
    where: { id: occurrenceId, voidedAt: null },
    to: "VOIDED",
    fromIn: ["SCHEDULED"],
    data: { outcome: "PLATFORM_OUTAGE", outcomeAt: at, voidedAt: at },
    reason: "session-outcome:PLATFORM_OUTAGE",
  });

const voidedMiss = (
  tx: Tx,
  appointmentId: string,
  occurrenceId: string,
  at: Date,
) =>
  onClassSessionVoided(tx, {
    appointmentId,
    occurrenceId,
    startsAt: at,
    voidedAt: at,
    hostAttributed: false,
  });

/** A class two host misses short of nothing: the next miss trips the exit right. */
async function classOneMissFromExit() {
  const host = await seedHost();
  const cls = await seedClassUnderWay(host, SHAPE);
  await seatClassBuyer(cls, SHAPE);
  const [first, second, ...rest] = cls.occurrenceIds.slice(SHAPE.delivered);
  await prisma.$transaction((tx) => voidAsSweep(tx, first, new Date()));
  await prisma.$transaction((tx) => voidAsSweep(tx, second, new Date()));
  return { host, cls, rest };
}

it("two misses landing together both commit and send the exit email once", async () => {
  const { cls, rest } = await classOneMissFromExit();
  const [a, b] = rest;
  // Both voids are written (history rows included) before either reads the ledger.
  let release!: () => void;
  const bothWritten = new Promise<void>((r) => (release = r));
  let written = 0;
  const land = (id: string) =>
    prisma.$transaction(async (tx) => {
      const now = new Date();
      await voidAsSweep(tx, id, now);
      written += 1;
      if (written === 2) release();
      await bothWritten;
      return voidedMiss(tx, cls.appointmentId, id, now);
    });
  const results = await Promise.allSettled([land(a), land(b)]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  const emails = results.flatMap((r) =>
    r.status === "fulfilled" && r.value.exitEmailArgs ? [r.value] : [],
  );
  expect(emails).toHaveLength(1);
});

it("a miss racing the whole-event cancel: both commit", async () => {
  const { host, cls, rest } = await classOneMissFromExit();
  let written!: () => void;
  const voidWritten = new Promise<void>((r) => (written = r));
  const miss = prisma.$transaction(
    async (tx) => {
      const now = new Date();
      await voidAsSweep(tx, rest[0], now);
      written();
      // The cancel takes its history row's key-share lock, then waits on this session's row.
      await new Promise((r) => setTimeout(r, 2_000));
      return voidedMiss(tx, cls.appointmentId, rest[0], now);
    },
    { timeout: 20_000 },
  );
  await voidWritten;
  const cancelled = hostCancels(host, cls.appointmentId);
  const [missResult, cancelResult] = await Promise.allSettled([
    miss,
    cancelled,
  ]);
  expect(missResult.status).toBe("fulfilled");
  expect(cancelResult).toMatchObject({
    status: "fulfilled",
    value: { status: 200 },
  });
});

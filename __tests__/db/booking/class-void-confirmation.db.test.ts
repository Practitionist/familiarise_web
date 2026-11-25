/**
 * A host-attributed class void counts toward the exit right and the host's
 * reliability flag only once its verdict is confirmed, on real Postgres: the
 * sweep's unconfirmed void raises nothing, ops Confirm raises both once, and an
 * outage void counts toward the exit right as before with no flag.
 */
import "./harness-cancel-route";

const mockFlush = jest.fn();
jest.mock("../../../lib/booking/session-outcome-sweep", () => {
  const actual = jest.requireActual(
    "../../../lib/booking/session-outcome-sweep",
  );
  return {
    ...actual,
    flushClassVoidNotices: (...a: unknown[]) => {
      mockFlush(...a);
      return actual.flushClassVoidNotices(...a);
    },
  };
});
import prisma from "../../../lib/prisma";
import { onClassSessionVoided } from "../../../lib/booking/class-sessions";
import {
  confirmSessionOutcome,
  overturnSessionOutcome,
} from "../../../lib/backoffice/session-outcomes";
import { seriesLedger } from "../../../lib/booking/class-series";
import { leaveEventSeat } from "../../../lib/booking/seat-leave";
import { refundedPaise, refundOnRowsEachTest } from "./harness-refunds";
import { HOUR_MS, seedConsultee, seedHost } from "./harness";
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
  // No make-up window has started, so the seats are promised no date yet.
  expect(swept.cancelEmailArgs).toBeNull();
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

it("ops relabelling an unconfirmed host void to an outage counts the miss and sends the exit notices after the commit, with no flag", async () => {
  const { cls, third } = await seedThreeVoids("HOST_ABSENT");
  // The door overturns only a session that has ended.
  await prisma.appointmentOccurrence.update({
    where: { id: third },
    data: {
      startsAt: new Date(Date.now() - DAY_MS - HOUR_MS),
      endsAt: new Date(Date.now() - DAY_MS),
    },
  });
  mockFlush.mockClear();

  await overturnSessionOutcome({
    occurrenceId: third,
    outcome: "PLATFORM_OUTAGE",
    actorUserId: (await seedConsultee()).userId,
  });

  expect(await seriesLedger(prisma, cls.appointmentId)).toMatchObject({
    misses: 3,
    hostMisses: 2,
    exitRight: true,
  });
  expect(mockFlush).toHaveBeenCalledTimes(1);
  expect(mockFlush.mock.calls[0][0]).toMatchObject({
    exitEmailArgs: { appointmentId: cls.appointmentId },
  });
  expect(await flags(cls.classId)).toBe(0);
});

describe("the learner's exit while a void's verdict is unconfirmed", () => {
  refundOnRowsEachTest();

  it("is refused with the session and its settle time, moving nothing, and runs at the full quote once the verdict is confirmed", async () => {
    const host = await seedHost();
    const cls = await seedClassUnderWay(host, SHAPE);
    const buyer = await seatClassBuyer(cls, SHAPE);
    // Three confirmed host voids give the exit right; a fourth, cut short, is still unconfirmed.
    const voided = cls.occurrenceIds.slice(
      SHAPE.delivered,
      SHAPE.delivered + 4,
    );
    for (const [i, id] of voided.entries()) {
      const at = new Date(Date.now() - (4 - i) * DAY_MS);
      await prisma.appointmentOccurrence.update({
        where: { id },
        data: {
          completionStatus: "VOIDED",
          voidedAt: at,
          outcome: i < 3 ? "HOST_ABSENT" : "CUT_SHORT",
          outcomeAt: at,
          outcomeConfirmedAt: i < 3 ? at : null,
        },
      });
    }
    const exit = () =>
      leaveEventSeat({
        kind: "class",
        eventId: cls.classId,
        userId: buyer.userId,
        actorUserId: buyer.userId,
        isSelfLeave: true,
        exit: true,
      });
    const seatStatus = async () =>
      (
        await prisma.appointmentParticipant.findFirstOrThrow({
          where: { appointmentId: cls.appointmentId, userId: buyer.userId },
          select: { status: true },
        })
      ).status;

    await expect(exit()).rejects.toMatchObject({
      code: "EXIT_WAITS_FOR_VERDICT",
      // The cut-short void's window, opened a day ago, is still open.
      message: expect.stringContaining(
        "You can leave the series once it's settled; the report window closes ",
      ),
    });
    expect(await refundedPaise(buyer.paymentId)).toBe(0);
    expect(await seatStatus()).toBe("CONFIRMED");

    await prisma.$transaction((tx) =>
      confirmSessionOutcome(tx, {
        occurrenceId: voided[3],
        outcome: "CUT_SHORT",
      }),
    );
    expect(await exit()).not.toBeNull();
    // Seven of ten sessions undelivered (three scheduled, four voided) at ₹10 each.
    expect(await refundedPaise(buyer.paymentId)).toBe(7_000);
  });
});

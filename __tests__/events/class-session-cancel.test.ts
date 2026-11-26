/**
 * @jest-environment node
 */

/**
 * #1780 row 4 (E-2, E-3) — the host cancels one future session (no deletedAt,
 * so it stays a miss) and schedules its make-up on the same ordinal within 14
 * days; the third miss flags the class once.
 */

import { Prisma } from "@prisma/client";

const transition = jest.fn();
// The database's host-time locks are pinned in host-time-locks.test.ts.
jest.mock("../../lib/booking/allocation/host-time-locks", () => ({
  lockHostTimeInTx: jest.fn(async () => undefined),
}));
jest.mock("../../lib/booking/transitions", () => ({
  transitionOccurrenceCompletion: (...a: unknown[]) => transition(...a),
}));
const recordSystemError = jest.fn();
jest.mock("../../lib/enterprise/system-events", () => {
  return {
    recordSystemError: (...a: unknown[]) => recordSystemError(...a),
    recordSystemErrorSafe: (...a: unknown[]) => recordSystemError(...a),
  };
});
jest.mock("../../lib/novu/stage-bell", () => ({ stageBell: jest.fn() }));
jest.mock("../../lib/payments/payouts/earnings-hold", () => ({
  recomputeEarningsHold: jest.fn(),
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));
jest.mock("../../utils/appointmentlock", () => ({
  withAppointmentLock: (_id: string, fn: () => unknown) => fn(),
  withEventCheckoutLock: (_key: unknown, fn: () => unknown) => fn(),
  tryLockSlotBatch: jest.fn(async () => ({ ok: true, grant: [] })),
  extendSlotInterval: jest.fn(async () => true),
  unlockSlotInterval: jest.fn(async () => undefined),
}));
// The make-up's host check: the calendar is free unless a test says otherwise.
const hostFree = { current: true };
jest.mock("../../utils/scheduling-engine/ScheduleValidationService", () => ({
  ScheduleValidationService: jest.fn().mockImplementation(() => ({
    revalidateConflicts: async () => ({
      isValid: hostFree.current,
      errors: hostFree.current ? [] : ["busy"],
      warnings: [],
    }),
  })),
}));

const cancelledAt = new Date(Date.now() - 86_400_000);
const missAt = (misses: number, i: number) =>
  new Date(
    cancelledAt.getTime() - db.missGapDays * (misses - 1 - i) * 86_400_000,
  );
const occurrences = (misses: number) =>
  Array.from({ length: db.N }, (_, i) => {
    // The newest miss may be a void with an outcome (a relabel's target).
    const voided = i === misses - 1 && db.lastMissVoid !== null;
    return {
      id: `occ-${i + 1}`,
      ordinal: i + 1,
      startsAt: new Date(Date.now() + (i + 1) * 86_400_000),
      endsAt: new Date(Date.now() + (i + 1) * 86_400_000 + 3_600_000),
      completionStatus:
        i < misses ? (voided ? "VOIDED" : "CANCELLED") : "SCHEDULED",
      movedAt: null,
      hostCancelledAt: i < misses && !voided ? missAt(misses, i) : null,
      voidedAt: voided ? missAt(misses, i) : null,
      outcome: voided ? db.lastMissVoid : null,
    };
  });
const db = {
  misses: 3,
  N: 12,
  /** Days between consecutive host misses; the newest lands at `cancelledAt`. */
  missGapDays: 0,
  /** The newest miss's void outcome, or null when it is a host cancel. */
  lastMissVoid: null as string | null,
  flagged: null as Record<string, unknown> | null,
  /** The plan's team, as the recipients helper reads it. */
  team: [] as string[],
  occurrenceCreate: jest.fn(),
  /** The class wrapper's row lock the miss ledger takes. */
  rowLock: jest.fn(async (..._a: unknown[]) => 1),
  /** The missed session's own host profile, as the make-up's pre-read sees it. */
  sourceProfile: null as string | null,
};
jest.mock("../../lib/prisma", () => {
  const tx = {
    $executeRaw: (...a: unknown[]) => db.rowLock(...a),
    appointmentOccurrence: {
      findUniqueOrThrow: async () => ({ startsAt: new Date() }),
      findMany: async () => occurrences(db.misses),
      findFirst: async () => ({
        ordinal: 5,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 3_600_000),
        completionStatus: "CANCELLED",
        hostCancelledAt: cancelledAt,
        seatsSettledAt: null,
        consultantProfileId: "cp-1",
      }),
      create: (...a: unknown[]) => db.occurrenceCreate(...a),
    },
    appointment: {
      findUnique: async () => ({
        class: { classPlan: { totalSessions: db.N } },
      }),
      // The attendee's own calendar is free at the make-up time.
      findFirst: async () => null,
    },
    consultantProfile: { findMany: async () => [] },
    collaborator: {
      // Answers the recipients read only; the batch and calendar reads see no co-host.
      findMany: async (args: {
        select: { consultantProfile?: { select: { userId?: boolean } } };
      }) =>
        args.select.consultantProfile?.select.userId
          ? db.team.map((userId) => ({ consultantProfile: { userId } }))
          : [],
    },
    class: {
      updateMany: async () => ({ count: 1 }),
      // The free leave a make-up opens is read back after it is written.
      findUnique: async () => ({ retimeBy: null }),
    },
    appointmentParticipant: { findMany: async () => [{ userId: "u-1" }] },
    systemEvent: { findFirst: async () => db.flagged },
    user: { findMany: async () => [] },
    failedEmail: { create: async () => ({ id: "fe-1" }) },
  };
  return {
    __esModule: true,
    default: {
      $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
      appointmentOccurrence: {
        findFirst: async () => ({
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 3_600_000),
          consultantProfileId: db.sourceProfile,
        }),
      },
      collaborator: { findMany: async () => [] },
      user: { findMany: async () => [] },
      failedEmail: { create: async () => ({ id: "fe-1" }) },
    },
  };
});

import prisma from "@/lib/prisma";
import {
  cancelClassSession,
  onClassSessionVoided,
  reliabilityFlagDue,
  scheduleClassMakeUp,
  type HostedClass,
} from "@/lib/booking/class-sessions";

const hosted = {
  found: true,
  appointment: { id: "apt-1", organizationId: null },
  cls: {
    id: "cls-1",
    classPlan: {
      id: "plan-1",
      title: "Python",
      consultantProfileId: "cp-1",
      consultantProfile: { user: { id: "u-host", name: "Host" } },
    },
  },
} as unknown as HostedClass;

beforeEach(() => {
  jest.clearAllMocks();
  db.misses = 3;
  db.N = 12;
  db.missGapDays = 0;
  db.lastMissVoid = null;
  db.flagged = null;
  db.team = [];
  db.sourceProfile = null;
  hostFree.current = true;
});

it("refuses a session that is no longer SCHEDULED and in the future", async () => {
  transition.mockResolvedValue(0);
  await expect(
    cancelClassSession(hosted, "occ-5", "u-host"),
  ).rejects.toMatchObject({
    code: "SESSION_NOT_CANCELLABLE",
  });
});

it("cancels without deletedAt, and the third miss flags the class exactly once", async () => {
  transition.mockResolvedValue(1);
  await cancelClassSession(hosted, "occ-3", "u-host");
  const args = transition.mock.calls[0][1];
  expect(args.fromIn).toEqual(["SCHEDULED"]);
  expect(args.where.startsAt).toEqual({ gt: expect.any(Date) });
  expect(args.data).toEqual({ hostCancelledAt: expect.any(Date) });
  expect(recordSystemError).toHaveBeenCalledTimes(1);

  db.flagged = { id: "evt-1" };
  db.misses = 4;
  await cancelClassSession(hosted, "occ-4", "u-host");
  expect(recordSystemError).toHaveBeenCalledTimes(1);
});

/** The learners' exit-right bells staged by the last cancel. */
const exitBells = () =>
  (
    jest.requireMock("../../lib/novu/stage-bell") as { stageBell: jest.Mock }
  ).stageBell.mock.calls.filter(
    ([, bell]) => bell.workflowId === "class-exit-available",
  );

it("tells the learners once: on the miss that first trips the exit right", async () => {
  transition.mockResolvedValue(1);
  db.misses = 3;
  const tripped = await cancelClassSession(hosted, "occ-3", "u-host");
  expect(tripped).toMatchObject({ misses: 3, exitRight: true });
  expect(exitBells()).toHaveLength(1);

  jest.clearAllMocks();
  db.misses = 4;
  const later = await cancelClassSession(hosted, "occ-4", "u-host");
  expect(later).toMatchObject({ misses: 4, exitRight: true });
  expect(exitBells()).toHaveLength(0);
});

it("a 100-session class: 3 host misses a month apart give no exit right, 3 inside 30 days do", async () => {
  transition.mockResolvedValue(1);
  db.N = 100;
  db.misses = 3;
  db.missGapDays = 31;
  const spread = await cancelClassSession(hosted, "occ-3", "u-host");
  expect(spread).toMatchObject({ exitRight: false });
  expect(exitBells()).toHaveLength(0);
  expect(recordSystemError).not.toHaveBeenCalled();

  db.missGapDays = 10;
  const clustered = await cancelClassSession(hosted, "occ-3", "u-host");
  expect(clustered).toMatchObject({ exitRight: true });
  expect(exitBells()).toHaveLength(1);
  expect(recordSystemError).toHaveBeenCalledTimes(1);
});

it("a 100-session class with misses spread out trips at the 15th miss, not the 14th", async () => {
  transition.mockResolvedValue(1);
  db.N = 100;
  db.missGapDays = 31;
  db.misses = 14;
  expect(await cancelClassSession(hosted, "occ-14", "u-host")).toMatchObject({
    exitRight: false,
  });
  db.misses = 15;
  expect(await cancelClassSession(hosted, "occ-15", "u-host")).toMatchObject({
    exitRight: true,
  });
  expect(exitBells()).toHaveLength(1);
});

it("takes the class wrapper's row lock before reading the miss ledger", async () => {
  transition.mockResolvedValue(1);
  await cancelClassSession(hosted, "occ-3", "u-host");
  const [sql] = db.rowLock.mock.calls[0] as [TemplateStringsArray];
  expect(sql.join("?")).toMatch(
    /FROM "Appointment" WHERE id = \? FOR NO KEY UPDATE/,
  );
});

const relabel = (occurrenceId: string) =>
  prisma.$transaction((tx) =>
    onClassSessionVoided(tx, {
      appointmentId: "apt-1",
      occurrenceId,
      startsAt: new Date(),
      voidedAt: new Date(),
      hostAttributed: true,
      relabelled: true,
    }),
  );

it("an ops relabel that blames an existing void on the host trips the 30-day window once", async () => {
  db.N = 100;
  db.misses = 3;
  db.missGapDays = 5;
  db.lastMissVoid = "HOST_ABSENT";
  const tripped = await relabel("occ-3");
  expect(tripped.exitEmailArgs).not.toBeNull();
  expect(exitBells()).toHaveLength(1);
});

it("a relabel on a class whose right already stood sends nothing", async () => {
  db.N = 100;
  db.misses = 4;
  db.missGapDays = 5;
  db.lastMissVoid = "HOST_ABSENT";
  const again = await relabel("occ-4");
  expect(again.exitEmailArgs).toBeNull();
  expect(exitBells()).toHaveLength(0);
});

// #1771 — after an ops clear, a later host cancellation re-flags; none does not.
it("re-flags after a clear only on a later host cancellation", async () => {
  transition.mockResolvedValue(1);
  const clearedAt = new Date(Date.now() - 3_600_000);
  db.flagged = { createdAt: clearedAt, context: { cleared: true } };
  db.misses = 4;
  await cancelClassSession(hosted, "occ-4", "u-host");
  expect(recordSystemError).toHaveBeenCalledTimes(1);
  const before = new Date(clearedAt.getTime() - 60_000);
  expect(
    reliabilityFlagDue(
      { createdAt: clearedAt, context: { cleared: true } },
      before,
    ),
  ).toBe(false);
});

it("makes up on the source ordinal; a second make-up and a late one are refused", async () => {
  const inDays = (d: number) =>
    // Make-up starts sit on the half-hour grid, like every host-set time.
    new Date(
      Math.ceil((cancelledAt.getTime() + d * 86_400_000) / 1_800_000) *
        1_800_000,
    );
  db.occurrenceCreate.mockResolvedValue({ id: "occ-make-up" });
  await scheduleClassMakeUp(hosted, "occ-5", inDays(5));
  expect(db.occurrenceCreate.mock.calls[0][0].data.ordinal).toBe(5);

  db.occurrenceCreate.mockRejectedValue(
    new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "7",
    }),
  );
  await expect(
    scheduleClassMakeUp(hosted, "occ-5", inDays(5)),
  ).rejects.toMatchObject({ code: "MAKEUP_EXISTS" });
  await expect(
    scheduleClassMakeUp(hosted, "occ-5", inDays(15)),
  ).rejects.toMatchObject({ code: "MAKEUP_WINDOW_LAPSED" });
});

it("tells the plan's team of a cancelled session and of its make-up, once and never as a required notice", async () => {
  // "u-1" also holds a seat, so the seat's bell is the one it gets.
  db.team = ["u-cohost", "u-1"];
  const { stageBell } = jest.requireMock("../../lib/novu/stage-bell") as {
    stageBell: jest.Mock;
  };
  const teamBells = () =>
    stageBell.mock.calls
      .map(([, bell]) => bell)
      .filter((bell) => bell.recipients.includes("u-cohost"));

  await cancelClassSession(hosted, "occ-4", "u-host");
  expect(teamBells()).toEqual([
    expect.objectContaining({
      workflowId: "class-session-cancelled",
      recipients: ["u-cohost"],
    }),
  ]);
  expect(teamBells()[0]).not.toHaveProperty("required");
  // The team's own sentence: no make-up deadline or refund is promised to it.
  expect(teamBells()[0].payload).toMatchObject({ forTeam: true });

  stageBell.mockClear();
  db.occurrenceCreate.mockResolvedValue({ id: "occ-make-up" });
  await scheduleClassMakeUp(
    hosted,
    "occ-5",
    new Date(
      Math.ceil((cancelledAt.getTime() + 5 * 86_400_000) / 1_800_000) *
        1_800_000,
    ),
  );
  expect(teamBells()).toEqual([
    expect.objectContaining({
      workflowId: "class-makeup-scheduled",
      recipients: ["u-cohost"],
    }),
  ]);
  // The free-leave offer is the seats' alone.
  expect(teamBells()[0].payload).not.toHaveProperty("leaveBy");
});

it("tells the plan's team that a session did not count, in its own sentence and not as a required notice", async () => {
  db.team = ["u-cohost", "u-1"];
  const { stageBell } = jest.requireMock("../../lib/novu/stage-bell") as {
    stageBell: jest.Mock;
  };
  stageBell.mockClear();

  await relabel("occ-3");

  const toTeam = stageBell.mock.calls
    .map(([, bell]) => bell)
    .filter((bell) => bell.recipients.includes("u-cohost"));
  expect(toTeam).toEqual([
    expect.objectContaining({
      workflowId: "class-session-cancelled",
      recipients: ["u-cohost"],
      dedupeKey: "occ-void:occ-3:team",
      payload: expect.objectContaining({ forTeam: true, voided: true }),
    }),
  ]);
  expect(toTeam[0]).not.toHaveProperty("required");
  expect(toTeam[0].payload).not.toHaveProperty("makeUpBy");
});

it("refuses a make-up onto host time any other booking holds, and takes the host's atoms first", async () => {
  const lock = jest.requireMock("../../utils/appointmentlock") as {
    tryLockSlotBatch: jest.Mock;
  };
  const inDays = (d: number) =>
    // Make-up starts sit on the half-hour grid, like every host-set time.
    new Date(
      Math.ceil((cancelledAt.getTime() + d * 86_400_000) / 1_800_000) *
        1_800_000,
    );
  hostFree.current = false;
  await expect(
    scheduleClassMakeUp(hosted, "occ-5", inDays(5)),
  ).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT" });
  expect(db.occurrenceCreate).not.toHaveBeenCalled();
  const [entries] = lock.tryLockSlotBatch.mock.calls[0] as [
    { consultantProfileId: string; startsAt: Date }[],
  ];
  expect(entries).toEqual([
    expect.objectContaining({
      consultantProfileId: "cp-1",
      startsAt: inDays(5),
    }),
  ]);
});

it("refuses a make-up when the host's time is held by an in-flight booking", async () => {
  const lock = jest.requireMock("../../utils/appointmentlock") as {
    tryLockSlotBatch: jest.Mock;
  };
  lock.tryLockSlotBatch.mockResolvedValueOnce({ ok: false, heldKeys: ["k"] });
  const inDays = (d: number) =>
    // Make-up starts sit on the half-hour grid, like every host-set time.
    new Date(
      Math.ceil((cancelledAt.getTime() + d * 86_400_000) / 1_800_000) *
        1_800_000,
    );
  await expect(scheduleClassMakeUp(hosted, "occ-5", inDays(5))).rejects.toThrow(
    /being booked right now/,
  );
  expect(db.occurrenceCreate).not.toHaveBeenCalled();
});

it("locks the host the make-up is written under, not the plan's current owner", async () => {
  const lock = jest.requireMock("../../utils/appointmentlock") as {
    tryLockSlotBatch: jest.Mock;
  };
  db.sourceProfile = "cp-source-host";
  db.occurrenceCreate.mockResolvedValue({ id: "occ-make-up" });
  const inDays = (d: number) =>
    // Make-up starts sit on the half-hour grid, like every host-set time.
    new Date(
      Math.ceil((cancelledAt.getTime() + d * 86_400_000) / 1_800_000) *
        1_800_000,
    );

  await scheduleClassMakeUp(hosted, "occ-5", inDays(5));

  const [entries] = lock.tryLockSlotBatch.mock.calls[0] as [
    { consultantProfileId: string }[],
  ];
  expect(entries.map((e) => e.consultantProfileId)).toEqual(["cp-source-host"]);
});

it("a seat holder who cancels the session themself keeps their own switches", async () => {
  db.misses = 1;
  await cancelClassSession(hosted, "occ-1", "u-1");

  const { stageBell } = jest.requireMock("../../lib/novu/stage-bell") as {
    stageBell: jest.Mock;
  };
  const cancelBell = stageBell.mock.calls.find(
    ([, args]) => args.dedupeKey === "occ-cancel:occ-1",
  );
  expect(cancelBell?.[1].recipients).toEqual(["u-1"]);
  expect(cancelBell?.[1].required).toBeUndefined();
});

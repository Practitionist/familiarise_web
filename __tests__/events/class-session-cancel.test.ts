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
const occurrences = (misses: number) =>
  Array.from({ length: 12 }, (_, i) => ({
    ordinal: i + 1,
    startsAt: new Date(Date.now() + (i + 1) * 86_400_000),
    endsAt: new Date(Date.now() + (i + 1) * 86_400_000 + 3_600_000),
    completionStatus: i < misses ? "CANCELLED" : "SCHEDULED",
    movedAt: null,
    hostCancelledAt: i < misses ? cancelledAt : null,
  }));
const db = {
  misses: 3,
  flagged: null as Record<string, unknown> | null,
  occurrenceCreate: jest.fn(),
  /** The missed session's own host profile, as the make-up's pre-read sees it. */
  sourceProfile: null as string | null,
};
jest.mock("../../lib/prisma", () => {
  const tx = {
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
        class: { classPlan: { totalSessions: 12 } },
      }),
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

import {
  cancelClassSession,
  reliabilityFlagDue,
  scheduleClassMakeUp,
  type HostedClass,
} from "@/lib/booking/class-sessions";

const hosted = {
  found: true,
  isHost: true,
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
  db.flagged = null;
  db.sourceProfile = null;
  hostFree.current = true;
});

it("refuses a session that is no longer SCHEDULED and in the future", async () => {
  transition.mockResolvedValue(0);
  await expect(cancelClassSession(hosted, "occ-5")).rejects.toMatchObject({
    code: "SESSION_NOT_CANCELLABLE",
  });
});

it("cancels without deletedAt, and the third miss flags the class exactly once", async () => {
  transition.mockResolvedValue(1);
  await cancelClassSession(hosted, "occ-3");
  const args = transition.mock.calls[0][1];
  expect(args.fromIn).toEqual(["SCHEDULED"]);
  expect(args.where.startsAt).toEqual({ gt: expect.any(Date) });
  expect(args.data).toEqual({ hostCancelledAt: expect.any(Date) });
  expect(recordSystemError).toHaveBeenCalledTimes(1);

  db.flagged = { id: "evt-1" };
  db.misses = 4;
  await cancelClassSession(hosted, "occ-4");
  expect(recordSystemError).toHaveBeenCalledTimes(1);
});

// #1771 — after an ops clear, a later host cancellation re-flags; none does not.
it("re-flags after a clear only on a later host cancellation", async () => {
  transition.mockResolvedValue(1);
  const clearedAt = new Date(Date.now() - 3_600_000);
  db.flagged = { createdAt: clearedAt, context: { cleared: true } };
  db.misses = 4;
  await cancelClassSession(hosted, "occ-4");
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
    new Date(cancelledAt.getTime() + d * 86_400_000);
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

it("refuses a make-up onto host time any other booking holds, and takes the host's atoms first", async () => {
  const lock = jest.requireMock("../../utils/appointmentlock") as {
    tryLockSlotBatch: jest.Mock;
  };
  const inDays = (d: number) =>
    new Date(cancelledAt.getTime() + d * 86_400_000);
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
    new Date(cancelledAt.getTime() + d * 86_400_000);
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
    new Date(cancelledAt.getTime() + d * 86_400_000);

  await scheduleClassMakeUp(hosted, "occ-5", inDays(5));

  const [entries] = lock.tryLockSlotBatch.mock.calls[0] as [
    { consultantProfileId: string }[],
  ];
  expect(entries.map((e) => e.consultantProfileId)).toEqual(["cp-source-host"]);
});

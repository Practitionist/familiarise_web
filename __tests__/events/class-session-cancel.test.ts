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
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => recordSystemError(...a),
}));
jest.mock("../../lib/novu/stage-bell", () => ({ stageBell: jest.fn() }));
jest.mock("../../lib/payments/payouts/earnings-hold", () => ({
  recomputeEarningsHold: jest.fn(),
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));
jest.mock("../../utils/appointmentlock", () => ({
  withAppointmentLock: (_id: string, fn: () => unknown) => fn(),
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
  flagged: null as { id: string } | null,
  occurrenceCreate: jest.fn(),
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
  };
  return {
    __esModule: true,
    default: { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) },
  };
});

import {
  cancelClassSession,
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
      title: "Python",
      consultantProfileId: "cp-1",
      consultantProfile: { user: { name: "Host" } },
    },
  },
} as unknown as HostedClass;

beforeEach(() => {
  jest.clearAllMocks();
  db.flagged = null;
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

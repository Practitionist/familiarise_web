/**
 * #1766 — the next cycle of a subscription is APPENDED, never re-planned.
 *
 * A 12-session plan at 4 a week has finished its first cycle (4 COMPLETED
 * rows, nothing live). The consultant hand-places the next 4: the allocator
 * takes the additive arm — no delete step at all — and the new rows continue
 * the wrapper's ordinals at 5–8. The transaction mock has no delete members,
 * so a regression into the replan path throws instead of quietly passing.
 */

import "./setup";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    consultation: { findUnique: jest.fn() },
    subscription: { findUnique: jest.fn() },
    webinar: { findUnique: jest.fn() },
    class: { findUnique: jest.fn() },
    appointment: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    appointmentOccurrence: { count: jest.fn(), findFirst: jest.fn() },
    rescheduleRequest: { findFirst: jest.fn() },
  },
  ALLOCATION_TX_MAX_WAIT_MS: 8000,
  ALLOCATION_TX_TIMEOUT_MS: 30000,
}));

jest.mock("../../utils/appointmentlock", () => ({
  lockAutoAllocate: jest
    .fn()
    .mockResolvedValue({ key: "mock-key", value: "mock-value" }),
  unlockAutoAllocate: jest.fn().mockResolvedValue(undefined),
  lockConsulteeBooking: jest
    .fn()
    .mockResolvedValue({ key: "mock-consultee-key", value: "mock-value" }),
  unlockConsulteeBooking: jest.fn().mockResolvedValue(undefined),
}));

const mockValidateFn = jest.fn();
const mockRevalidateConflictsFn = jest.fn();
jest.mock("../../utils/scheduling-engine/ScheduleValidationService", () => ({
  ...jest.requireActual(
    "../../utils/scheduling-engine/ScheduleValidationService",
  ),
  ScheduleValidationService: jest.fn().mockImplementation(() => ({
    validate: mockValidateFn,
    revalidateConflicts: mockRevalidateConflictsFn,
  })),
}));

import prisma from "@/lib/prisma";
import { SchedulingService } from "@/utils/scheduling-engine/SchedulingService";
import { ScheduleType } from "@prisma/client";

const mockPrisma = prisma as unknown as {
  $transaction: jest.Mock;
  subscription: { findUnique: jest.Mock };
  appointment: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    findFirst: jest.Mock;
  };
  appointmentOccurrence: { count: jest.Mock };
};

const WRAPPER_ID = "apt-sub-cycle";
const HOUR = 60 * 60 * 1000;

/** One delivered 1-hour session (#1554: one row per call). */
function completedOccurrence(ordinal: number, startISO: string) {
  const startsAt = new Date(startISO);
  return {
    id: `occ-${ordinal}`,
    ordinal,
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    isTentative: false,
    completionStatus: "COMPLETED",
    deletedAt: null,
  };
}

const CYCLE_ONE = [
  completedOccurrence(1, "2025-01-06T09:00:00.000Z"),
  completedOccurrence(2, "2025-01-07T09:00:00.000Z"),
  completedOccurrence(3, "2025-01-08T09:00:00.000Z"),
  completedOccurrence(4, "2025-01-09T09:00:00.000Z"),
];

/** Four hand-picked 1-hour sessions on four days of the following week. */
const CYCLE_TWO_SLOTS = [13, 14, 15, 16].flatMap((day) => [
  `2025-01-${day}T09:00:00.000Z`,
  `2025-01-${day}T09:30:00.000Z`,
]);

const wrapper = {
  id: WRAPPER_ID,
  organizationId: null,
  cancellationPolicyId: null,
  payment: [],
  participants: [{ userId: "consultee-1" }],
  occurrences: CYCLE_ONE,
};

const subscription = {
  id: "sub-cycle",
  sessionsTotal: 12,
  schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00Z"),
  schedulingPeriodEndsAt: new Date("2025-01-12T23:59:59Z"),
  schedulingTimezone: "UTC",
  subscriptionPlan: {
    title: "Intensive",
    consultantProfileId: "consultant-profile-1",
    durationInMonths: 3,
    sessionsPerWeek: 4,
    sessionDurationInHours: 1,
    totalSessions: 12,
    consultantProfile: {
      user: { id: "consultant-1", name: "Consultant", timezone: "UTC" },
      scheduleType: ScheduleType.WEEKLY,
      availabilityWindowsWeekly: [],
      availabilityWindowsCustom: [],
    },
  },
  requestedBy: { user: { id: "consultee-1", name: "Consultee" } },
  appointment: wrapper,
};

/** No `delete`, `deleteMany` or `appointmentOccurrence.deleteMany` anywhere. */
const mockTx = {
  subscription: {
    findUnique: jest.fn().mockResolvedValue(subscription),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  consultantProfile: {
    findFirst: jest.fn().mockResolvedValue({ id: "consultant-profile-1" }),
  },
  appointment: {
    findUnique: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([wrapper]),
    findFirst: jest
      .fn()
      .mockResolvedValue({ id: WRAPPER_ID, cancellationPolicyId: null }),
    create: jest.fn(),
    update: jest
      .fn()
      .mockImplementation(
        ({
          data,
        }: {
          data: { occurrences: { create: { ordinal: number }[] } };
        }) =>
          Promise.resolve({
            id: WRAPPER_ID,
            occurrences: [
              ...CYCLE_ONE,
              ...data.occurrences.create.map((row) => ({
                ...row,
                id: `occ-${row.ordinal}`,
              })),
            ],
          }),
      ),
  },
  appointmentParticipant: {
    createMany: jest.fn().mockResolvedValue({ count: 2 }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    findMany: jest.fn().mockResolvedValue([{ userId: "consultee-1" }]),
  },
  bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  rescheduleRequest: { findMany: jest.fn().mockResolvedValue([]) },
  appointmentOccurrence: {
    findMany: jest.fn().mockResolvedValue([]),
    // The in-txn held-count re-check sees the same four delivered sessions.
    count: jest.fn().mockResolvedValue(4),
    aggregate: jest.fn().mockResolvedValue({ _max: { ordinal: 4 } }),
  },
  $executeRaw: jest.fn().mockResolvedValue(1),
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-01-10T00:00:00Z"));
  mockPrisma.$transaction.mockImplementation(
    (callback: (tx: typeof mockTx) => unknown) => callback(mockTx),
  );
  mockPrisma.subscription.findUnique.mockResolvedValue(subscription);
  mockPrisma.appointment.findMany.mockResolvedValue([wrapper]);
  mockPrisma.appointment.findFirst.mockResolvedValue(null);
  mockPrisma.appointmentOccurrence.count.mockResolvedValue(4);
  mockValidateFn.mockResolvedValue({ isValid: true, errors: [], warnings: [] });
  mockRevalidateConflictsFn.mockResolvedValue({
    isValid: true,
    errors: [],
    warnings: [],
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("#1766 manual allocation of a subscription's next cycle", () => {
  it("appends four sessions at ordinals 5–8 and deletes nothing", async () => {
    const result = await SchedulingService.allocate({
      eventType: "subscription",
      eventId: "sub-cycle",
      mode: "manual",
      slots: CYCLE_TWO_SLOTS,
      // What the allocate page sends today; a held subscription ignores it.
      initialAllocation: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(mockTx.appointment.create).not.toHaveBeenCalled();
    const created =
      mockTx.appointment.update.mock.calls[0][0].data.occurrences.create;
    expect(created).toHaveLength(4);
    expect(created.map((row: { ordinal: number }) => row.ordinal)).toEqual([
      5, 6, 7, 8,
    ]);
  });

  it("refuses a batch that is not exactly this cycle's size", async () => {
    const result = await SchedulingService.allocate({
      eventType: "subscription",
      eventId: "sub-cycle",
      mode: "manual",
      slots: CYCLE_TWO_SLOTS.slice(0, 2),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("This cycle takes exactly 4 session(s)");
    expect(mockTx.appointment.update).not.toHaveBeenCalled();
  });
});

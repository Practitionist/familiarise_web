/**
 * One definition of "tentative" and one of "confirmed", in one place.
 *
 * `SchedulingService` used to answer each concept three ways in the same file:
 *
 * - `tentativeSlotCountOf` / `assertExpectedTentativeSlotCountInTx` / the two
 *   mode entry points filtered bare `isTentative`, so a TOMBSTONED tentative row
 *   counted. Every client that produces `expectedTentativeSlotCount` reads
 *   occurrences filtered `deletedAt: null` (`lib/data/requests-inbox.ts`), so a
 *   tombstoned row could only ever produce a false 409
 *   RESCHEDULE_STATE_CHANGED.
 * - `existingConfirmedSessionCount` filtered `!isTentative && !isDeadOccurrence`,
 *   which is the canonical predicate — and therefore the one that won.
 * - `assertNoConfirmedSlots` filtered `deletedAt: null` only, so a confirmed but
 *   CANCELLED/RESCHEDULED row that was not tombstoned blocked a fresh
 *   `initialAllocation`, unlike its sibling `assertHeldSessionCountInTx`, which
 *   already spread the canonical `liveOccurrenceWhere`.
 *
 * One thing is deliberately NOT unified: a tentative row's `completionStatus`. A
 * reschedule releases a row IN PLACE as `isTentative: true` +
 * `RESCHEDULED`, so excluding completionStatus would drop exactly the rows the
 * stale-tab guard exists to protect and reject every reschedule as stale.
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
    appointment: { findMany: jest.fn(), findFirst: jest.fn() },
    // `probeConfirmedOverlap` reads `findFirst`; without it the probe throws
    // into its own catch and silently skips the pre-lock overlap check.
    appointmentOccurrence: {
      count: jest.fn(),
      findFirst: jest.fn(),
      updateManyAndReturn: jest.fn(),
    },
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

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  withScope: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockValidateFn = jest.fn();
const mockRevalidateConflictsFn = jest.fn();
jest.mock("../../utils/scheduling-engine/ScheduleValidationService", () => ({
  ...jest.requireActual("../../utils/scheduling-engine/ScheduleValidationService"),
  ScheduleValidationService: jest.fn().mockImplementation(() => ({
    validate: mockValidateFn,
    revalidateConflicts: mockRevalidateConflictsFn,
  })),
}));

import prisma from "@/lib/prisma";
import { SchedulingService } from "@/utils/scheduling-engine/SchedulingService";
import { ScheduleType } from "@prisma/client";

type Occurrence = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  isTentative: boolean;
  deletedAt: Date | null;
  completionStatus: string | null;
};

const mockPrisma = prisma as unknown as {
  $transaction: jest.Mock;
  subscription: { findUnique: jest.Mock };
  appointment: { findMany: jest.Mock; findFirst: jest.Mock };
  appointmentOccurrence: { count: jest.Mock; findFirst: jest.Mock };
};

/** One of the event's own appointments, as the delete path SELECTs it. */
function existingAppointment(occurrences: unknown[]) {
  return {
    id: "appt-1",
    // #1554 — the delete path reads the live seat holders off the wrapper, so
    // an appointment fixture without `participants` is not a thinner row: it
    // throws `undefined is not iterable` and the allocation answers 500.
    participants: [],
    occurrences,
  };
}

function occurrence(
  overrides: Partial<Occurrence> & { id: string },
): Occurrence {
  return {
    startsAt: new Date("2026-08-03T09:00:00.000Z"),
    endsAt: new Date("2026-08-03T10:00:00.000Z"),
    isTentative: false,
    deletedAt: null,
    completionStatus: null,
    ...overrides,
  };
}

const subscriptionRow = {
  sessionsTotal: null,
  subscriptionPlan: {
    consultantProfileId: "cp-1",
    durationInMonths: 1,
    sessionsPerWeek: 1,
    sessionDurationInHours: 1,
    totalSessions: 1,
    // `fetchEventData` reads the profile off the plan and refuses the whole
    // allocation with NOT_FOUND when it is absent, which is a 400 raised
    // BEFORE the guard under test — so a fixture without it makes every
    // assertion in this file pass or fail for the wrong reason.
    consultantProfile: {
      user: { id: "consultant-user-1", name: "Consultant", timezone: "UTC" },
      scheduleType: ScheduleType.CUSTOM,
      availabilityWindowsWeekly: [],
      availabilityWindowsCustom: [],
    },
  },
  requestedBy: { user: { id: "user-1", name: "Consultee" } },
  appointment: { occurrences: [], payment: [] },
  schedulingPeriodStartsAt: new Date("2026-08-02T00:00:00.000Z"),
  schedulingPeriodEndsAt: new Date("2026-08-29T23:59:59.000Z"),
  schedulingTimezone: "UTC",
};

const mockTx = {
  subscription: {
    findUnique: jest.fn(),
    // `updateEventStatus` ends a subscription's allocation through this CAS, and
    // a count-less `updateMany` returns undefined, so `res.count` throws and the
    // run answers 500 instead of the result its own assertions are about. One
    // matched row = the request really was APPROVED_PENDING_PAYMENT.
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  consultantProfile: { findFirst: jest.fn().mockResolvedValue({ id: "cp-1" }) },
  collaborator: { findMany: jest.fn().mockResolvedValue([]) },
  appointmentParticipant: {
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  appointment: {
    findUnique: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: "apt-1", occurrences: [] }),
    update: jest.fn().mockResolvedValue({ id: "apt-1", occurrences: [] }),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  appointmentOccurrence: {
    findFirst: jest.fn().mockResolvedValue(null),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    count: jest.fn().mockResolvedValue(0),
  },
  $executeRaw: jest.fn().mockResolvedValue(1),
};

/**
 * One fixture for BOTH reads of the event's own appointments: the pre-txn read
 * and the in-txn re-assert behind the advisory lock. A guard whose two halves
 * disagree about what a tentative row is can only be pinned by feeding them the
 * same rows.
 */
let existingAppointments: unknown[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-08-01T00:00:00Z"));
  jest.spyOn(console, "warn").mockImplementation(() => {});

  existingAppointments = [];
  mockPrisma.subscription.findUnique.mockResolvedValue(subscriptionRow);
  mockPrisma.appointment.findFirst.mockResolvedValue(null);
  mockPrisma.appointment.findMany.mockImplementation(
    async () => existingAppointments,
  );
  // The pre-lock overlap probe reads this; null is "no other appointment covers
  // the requested instants", which is what every fixture here means.
  mockPrisma.appointmentOccurrence.findFirst.mockResolvedValue(null);
  mockPrisma.appointmentOccurrence.count.mockResolvedValue(0);
  mockTx.appointment.findMany.mockImplementation(
    async () => existingAppointments,
  );
  (prisma.$transaction as jest.Mock).mockImplementation(
    async (callback: (tx: unknown) => unknown) => callback(mockTx),
  );
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


const allocateManual = (expectedTentativeSlotCount: number) =>
  SchedulingService.allocate({
    eventType: "subscription",
    eventId: "sub-1",
    mode: "manual",
    slots: ["2026-08-03T09:00:00.000Z", "2026-08-03T09:30:00.000Z"],
    expectedTentativeSlotCount,
  });

describe("a tombstoned tentative row is not a session the event carries", () => {
  it("does not trip the stale-tab guard", async () => {
    // What the consultant's page saw: one live tentative row. What the database
    // holds: that row, tombstoned by a cancellation the page has since seen.
    // Bare `isTentative` counted two and answered 409 RESCHEDULE_STATE_CHANGED
    // — a refusal the consultant could do nothing with.
    existingAppointments = [
      existingAppointment([
        occurrence({ id: "s1", isTentative: true }),
        occurrence({
          id: "s2",
          isTentative: true,
          deletedAt: new Date("2026-07-31T00:00:00.000Z"),
        }),
      ]),
    ];

    const result = await allocateManual(1);

    expect(result.errorCode).not.toBe("RESCHEDULE_STATE_CHANGED");
  });

  it("still counts a RELEASED row, which is the row a reschedule replaces", async () => {
    // The other half of the predicate, and the one a careless "unify to
    // isDeadOccurrence" would break: a released row is tentative + RESCHEDULED
    // and is exactly what the guard protects. Every reschedule goes through
    // here, so dropping it would 409 the whole feature.
    existingAppointments = [
      existingAppointment([
        occurrence({
          id: "s1",
          isTentative: true,
          completionStatus: "RESCHEDULED",
        }),
      ]),
    ];

    const result = await allocateManual(1);

    expect(result.errorCode).not.toBe("RESCHEDULE_STATE_CHANGED");
  });

  it("still refuses a genuine mismatch", async () => {
    // The guard must not have been defanged into never firing: another tab
    // really did place the session, so zero live tentative rows ≠ the page's 1.
    existingAppointments = [
      existingAppointment([
        occurrence({
          id: "s1",
          isTentative: false,
          endsAt: new Date("2026-08-03T11:00:00.000Z"),
        }),
      ]),
    ];

    const result = await allocateManual(1);

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    expect(result.errorCode).toBe("RESCHEDULE_STATE_CHANGED");
  });
});

describe("assertNoConfirmedSlots counts only live confirmed rows", () => {
  it("asks the database with the canonical live predicate", async () => {
    // The shape is the assertion: `liveOccurrenceWhere` is the same constant
    // `assertHeldSessionCountInTx` spreads, so a confirmed-but-voided row can no
    // longer block a fresh initialAllocation the way a deleted one does not.
    await SchedulingService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "auto",
      initialAllocation: true,
    });

    const where = mockPrisma.appointmentOccurrence.count.mock.calls.at(-1)?.[0]
      ?.where as Record<string, unknown>;
    expect(where).toMatchObject({
      isTentative: false,
      deletedAt: null,
      completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
    });
  });

  it("refuses the fresh allocation when a LIVE confirmed row exists", async () => {
    mockPrisma.appointmentOccurrence.count.mockResolvedValue(1);

    const result = await SchedulingService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "auto",
      initialAllocation: true,
    });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    expect(result.errorCode).toBe("ALREADY_ALLOCATED");
  });
});

/**
 * #1206 — top-up allocation.
 *
 * A partial allocation confirms N of M sessions and leaves the rest unplaced.
 * Re-running the ordinary auto path to recover them deletes every confirmed
 * appointment (and the Payment rows that cascade off it) and re-plans from
 * scratch, which is why the hourly sweep could never do it. `topUp: true`
 * places only the shortfall and touches nothing that exists.
 *
 * The transaction mock below has no delete members at all: any call into
 * `deleteExistingAppointments` throws instead of quietly passing.
 */

import "./setup";

// Mock prisma (relative path required — @/ aliases fail in jest.mock)
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    consultation: { findUnique: jest.fn() },
    subscription: { findUnique: jest.fn() },
    webinar: { findUnique: jest.fn() },
    class: { findUnique: jest.fn() },
    appointment: { findMany: jest.fn(), findUnique: jest.fn() },
    rescheduleRequest: { findFirst: jest.fn() },
  },
  ALLOCATION_TX_MAX_WAIT_MS: 8000,
  ALLOCATION_TX_TIMEOUT_MS: 30000,
}));

// Mock appointmentlock to avoid the @upstash/redis ESM import under Jest.
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

// Slot discovery stays REAL — the weekly-cap seeding and the booked-slot set
// are exactly what must keep the fixed sessions out of the search. Only the
// validators are stubbed, as elsewhere in this folder.
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
import { attemptTrigger, notifyAppointmentBooked } from "@/lib/novu";
import { SchedulingService } from "@/utils/scheduling-engine/SchedulingService";
import { ScheduleType, DayOfWeek } from "@prisma/client";

/** One 09:00–11:00 UTC window on `day`; the 1/day cap makes it one session. */
function morningOn(day: DayOfWeek) {
  return {
    id: `weekly-${day.toLowerCase()}-9`,
    startDay: day,
    endDay: day,
    startTimeUtc: 9 * 60,
    endTimeUtc: 11 * 60,
    utcOffsetMinutes: 0,
  };
}

const mockPrisma = prisma as unknown as {
  $transaction: jest.Mock;
  subscription: { findUnique: jest.Mock };
  appointment: { findMany: jest.Mock; findUnique: jest.Mock };
};

const notifyBooked = notifyAppointmentBooked as jest.Mock;
const STAGED_ROW = { id: "outbox-1" };

/** One 1-hour session = one confirmed occurrence row (#1554). */
function confirmedOccurrence(ordinal: number, startISO: string) {
  const startsAt = new Date(startISO);
  return {
    id: `occ-week-${ordinal}`,
    ordinal,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
    isTentative: false,
    completionStatus: "SCHEDULED",
  };
}

const WRAPPER_ID = "apt-sub-topup";

/** The subscription's ONE purchase wrapper carrying its held calls (#1554). */
function wrapperWith(occurrences: ReturnType<typeof confirmedOccurrence>[]) {
  return {
    id: WRAPPER_ID,
    organizationId: null,
    cancellationPolicyId: null,
    payment: [],
    // #1554 — the roster the delete branches harvest for the re-seat.
    participants: [{ userId: "consultee-1" }],
    occurrences,
  };
}

// #1766 — a 2-a-week, four-session plan: cycle one holds two sessions. The
// Monday of cycle one is booked and paid for; the Tuesday is still owed.
const WEEK_1 = confirmedOccurrence(1, "2025-01-06T09:00:00.000Z");
const WEEK_2 = confirmedOccurrence(2, "2025-01-07T09:00:00.000Z");
// What the whole plan looks like once both cycles have been placed.
const WEEK_3 = confirmedOccurrence(3, "2025-01-13T09:00:00.000Z");
const WEEK_4 = confirmedOccurrence(4, "2025-01-14T09:00:00.000Z");

function makeSubscription(
  occurrences: ReturnType<typeof confirmedOccurrence>[],
) {
  return {
    id: "sub-topup",
    sessionsTotal: 4,
    schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00Z"),
    schedulingPeriodEndsAt: new Date("2025-01-12T23:59:59Z"),
    schedulingTimezone: "UTC",
    subscriptionPlan: {
      title: "Weekly coaching",
      consultantProfileId: "consultant-profile-1",
      durationInMonths: 1,
      sessionsPerWeek: 2,
      sessionDurationInHours: 1,
      totalSessions: 4,
      consultantProfile: {
        user: { id: "consultant-1", name: "Consultant", timezone: "UTC" },
        scheduleType: ScheduleType.WEEKLY,
        availabilityWindowsWeekly: [
          morningOn(DayOfWeek.MONDAY),
          morningOn(DayOfWeek.TUESDAY),
        ],
        availabilityWindowsCustom: [],
      },
    },
    requestedBy: { user: { id: "consultee-1", name: "Consultee" } },
    appointment: wrapperWith(occurrences),
  };
}

/**
 * No `delete`, `deleteMany` or `appointmentOccurrence.deleteMany`: the top-up path
 * must never reach `deleteExistingAppointments`, and a call here is a
 * TypeError rather than a silent pass.
 */
function makeNoDeleteTx() {
  return {
    subscription: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    consultantProfile: {
      findFirst: jest.fn().mockResolvedValue({ id: "consultant-profile-1" }),
    },
    appointment: {
      // #1569 — the earnings-hold recompute reads the wrapper; none paid here.
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      // #1554 — createAppointments finds the purchase wrapper and attaches
      // the new rows to it (the #1499 policy read shares the same mock).
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
                WEEK_1,
                ...data.occurrences.create.map((row) => ({
                  ...row,
                  id: `occ-week-${row.ordinal}`,
                })),
              ],
            }),
        ),
    },
    appointmentParticipant: {
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      // #1554 — the top-up reads the surviving seats off the roster.
      findMany: jest.fn().mockResolvedValue([{ userId: "consultee-1" }]),
    },
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    appointmentOccurrence: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      // #1554 — nextOrdinal continues the wrapper's numbering.
      aggregate: jest.fn().mockResolvedValue({ _max: { ordinal: 1 } }),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
}

let mockTx: ReturnType<typeof makeNoDeleteTx>;

/** Start times, in order, of every occurrence this run attached to the wrapper. */
function createdSlotStarts(): string[] {
  return mockTx.appointment.update.mock.calls.flatMap(
    ([args]: [{ data: { occurrences: { create: { startsAt: Date }[] } } }]) =>
      args.data.occurrences.create.map((slot) => slot.startsAt.toISOString()),
  );
}

/** Let the fire-and-forget notification promise settle. */
async function flushNotifications(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));

  mockTx = makeNoDeleteTx();
  mockPrisma.$transaction.mockImplementation(
    (callback: (tx: typeof mockTx) => unknown) => callback(mockTx),
  );
  notifyBooked.mockResolvedValue([{ success: true, staged: STAGED_ROW }]);
  mockTx.subscription.findUnique.mockResolvedValue(makeSubscription([WEEK_1]));
  mockPrisma.subscription.findUnique.mockImplementation(() =>
    mockTx.subscription.findUnique(),
  );
  // One array answers all three reads: the event's own wrapper, the
  // consultant's occupancy scan and the consultee's. The confirmed session
  // therefore blocks its own interval, which is what a top-up requires.
  mockPrisma.appointment.findMany.mockResolvedValue([wrapperWith([WEEK_1])]);
  // #1766 — the in-txn held-count re-check sees the same one session.
  mockTx.appointmentOccurrence.count.mockResolvedValue(1);

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

describe("#1206 top-up allocation", () => {
  it("places only the missing session of the cycle and deletes nothing", async () => {
    const result = await SchedulingService.allocate({
      eventType: "subscription",
      eventId: "sub-topup",
      mode: "auto",
      topUp: true,
      allowPartial: true,
    });

    expect(result.success).toBe(true);
    expect(result.noChange).toBeUndefined();
    // #1554 — the wrapper is reused, never re-created; the session the cycle
    // was short continues its ordinals.
    expect(mockTx.appointment.create).not.toHaveBeenCalled();
    expect(result.appointments).toHaveLength(1);
    expect(
      mockTx.appointment.update.mock.calls[0][0].data.occurrences.create.map(
        (row: { ordinal: number }) => row.ordinal,
      ),
    ).toEqual([2]);
    // Monday is untouched: it already holds the day's one session and its
    // interval is in the booked set, so the search went to Tuesday — one
    // occurrence row per call (#1554). #1766 — cycle two is NOT pre-scheduled.
    expect(createdSlotStarts()).toEqual(["2025-01-07T09:00:00.000Z"]);
    // The cycle is whole again, so no partial notice is owed.
    expect(result.partial).toBeUndefined();
    // #1697 item 5 — the booked notice is staged INSIDE the write transaction
    // (the `tx` option), attempted after commit, and never leaks to the caller.
    expect(notifyBooked).toHaveBeenCalledTimes(1);
    expect(notifyBooked.mock.calls[0][2]).toEqual({ tx: mockTx });
    expect(result).not.toHaveProperty("stagedNotices");
    expect(attemptTrigger).toHaveBeenCalledWith(STAGED_ROW);
  });

  it("returns noChange and notifies nobody once the plan is complete", async () => {
    // Both cycles placed: all four sessions confirmed.
    const complete = [WEEK_1, WEEK_2, WEEK_3, WEEK_4];
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscription(complete),
    );
    mockPrisma.appointment.findMany.mockResolvedValue([wrapperWith(complete)]);

    const result = await SchedulingService.allocate({
      eventType: "subscription",
      eventId: "sub-topup",
      mode: "auto",
      topUp: true,
      allowPartial: true,
    });
    await flushNotifications();

    expect(result.success).toBe(true);
    expect(result.noChange).toBe(true);
    // Derived from the shortfall: a whole plan is not partial.
    expect(result.partial).toBe(false);
    expect(result.placedSessions).toBe(0);
    expect(result.requiredSessions).toBe(4);
    expect(result.unplacedSessions).toBe(0);
    // Nothing was written, and — the point of the suppressor — the consultee
    // is not paged by an hourly sweep that changed nothing.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(notifyBooked).not.toHaveBeenCalled();
  });

  it("without the flag, a held subscription still appends instead of re-planning (#1766)", async () => {
    // Before #1766 the ordinary auto path re-planned, which started by
    // deleting the paid session. A subscription with held sessions now takes
    // the additive arm whatever the flag says — and this transaction has no
    // delete members, so any regression throws instead of quietly passing.
    const result = await SchedulingService.allocate({
      eventType: "subscription",
      eventId: "sub-topup",
      mode: "auto",
    });

    expect(result.success).toBe(true);
    expect(mockTx.appointment.create).not.toHaveBeenCalled();
    expect(createdSlotStarts()).toEqual(["2025-01-07T09:00:00.000Z"]);
  });
});

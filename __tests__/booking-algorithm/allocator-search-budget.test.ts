/**
 * The allocator's search is bounded, and a bounded search answers.
 *
 * Two bounds, both of which used to be absent:
 *
 * 1. `isWithinAvailability`'s CUSTOM arm was a linear `.some()` over every
 *    published row with two `new Date()` allocations per row, called once per
 *    candidate start (≤ 48 per row), per matching row, per day of the scheduling
 *    window — while `fetchEventData` loads those rows with no `take` and no
 *    `where`. ~100 custom rows over a 12-month class was measured at ~13 s, and
 *    the ~26 s edge 504 is not far behind. It is now ONE merged interval list
 *    built per allocation and binary-searched, which is what makes the pins
 *    below about a build COUNT rather than about a stopwatch.
 *
 * 2. There was no time budget at all, so the search could run past the request
 *    ceiling — and past the 150 s `auto-allocate` grant, which is never renewed.
 *    Now the walk stops and falls through to the SAME `SlotShortageError` a full
 *    calendar produces, which `allowPartial` already knows how to turn into
 *    "place what fits". No new error type: the routes map this one already.
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

const addBreadcrumb = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  addBreadcrumb: (...args: unknown[]) => addBreadcrumb(...args),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  withScope: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
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

/**
 * The one hook that fires INSIDE the day sweep: the custom-availability index
 * is built on the first candidate the sweep asks about. `mockSpendMs` is how much
 * simulated time that first build costs, which is how a search that would take
 * 13 real seconds is reproduced in microseconds. (jest.mock factories may only
 * close over `mock`-prefixed bindings.)
 */
let mockIndexBuilds = 0;
let mockSpendMs = 0;
jest.mock("../../utils/scheduling-engine/availability-search", () => {
  const actual = jest.requireActual(
    "../../utils/scheduling-engine/availability-search",
  );
  return {
    ...actual,
    buildAvailabilityIndex: (rows: unknown) => {
      mockIndexBuilds += 1;
      if (mockIndexBuilds === 1 && mockSpendMs > 0) {
        jest.setSystemTime(Date.now() + mockSpendMs);
      }
      return actual.buildAvailabilityIndex(rows);
    },
  };
});

import prisma from "@/lib/prisma";
import { SchedulingService } from "@/utils/scheduling-engine/SchedulingService";
import {
  buildAvailabilityIndex,
  createSearchBudget,
  indexCoversAtom,
} from "@/utils/scheduling-engine/availability-search";
import { ScheduleType } from "@prisma/client";

const base = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const THIRTY_MIN_MS = 30 * 60 * 1000;
const at = (iso: string) => new Date(iso);

/** `count` non-overlapping two-hour rows, one per day, from `startIso`. */
function customRows(startIso: string, count: number) {
  const first = at(startIso).getTime();
  return Array.from({ length: count }, (_, i) => {
    const startsAt = new Date(first + i * 86_400_000);
    return {
      id: `custom-${i}`,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 2 * 60 * 60 * 1000),
    };
  });
}

/** A 12-month class: 8 sessions, 1/week, over a consultant with published days. */
function classWith(rows: ReturnType<typeof customRows>) {
  return {
    id: "class-1",
    classPlanId: "plan-1",
    classPlan: {
      id: "plan-1",
      consultantProfileId: "consultant-profile-1",
      organizationId: null,
      durationInMonths: 12,
      sessionsPerWeek: 1,
      sessionDurationInHours: 1,
      totalSessions: 8,
      consultantProfile: {
        user: { id: "consultant-user-1", timezone: "UTC" },
        scheduleType: ScheduleType.CUSTOM,
        availabilityWindowsWeekly: [],
        availabilityWindowsCustom: rows,
      },
    },
    // `stageAllocationNotices` re-reads the event inside the write transaction
    // and SELECTs the wrapper's `participants` and live `occurrences`, then
    // destructures `{ user }` off every participant — so a fixture that omits
    // the relation does not merely return a thinner row, it throws mid-txn and
    // the allocation answers 500 instead of its real result. Prisma always
    // returns the relation (empty here: nobody is booked yet).
    appointment: {
      id: "appt-existing",
      organizationId: null,
      participants: [],
      occurrences: [],
    },
    schedulingPeriodStartsAt: at("2025-06-01T00:00:00.000Z"),
    schedulingPeriodEndsAt: at("2026-05-31T23:59:59.000Z"),
    schedulingTimezone: "UTC",
  };
}

const mockTx = {
  class: {
    findUnique: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  consultantProfile: {
    findFirst: jest.fn().mockResolvedValue({ id: "consultant-profile-1" }),
  },
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

let warn: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-05-01T00:00:00Z"));
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  addBreadcrumb.mockClear();
  jest.clearAllMocks();
  mockIndexBuilds = 0;
  mockSpendMs = 0;

  (prisma.$transaction as jest.Mock).mockImplementation(
    async (callback: (tx: unknown) => unknown) => callback(mockTx),
  );
  base.appointment = mockTx.appointment;
  base.class.findUnique = mockTx.class.findUnique;
  base.rescheduleRequest.findFirst.mockResolvedValue(null);

  mockValidateFn.mockResolvedValue({ isValid: true, errors: [], warnings: [] });
  mockRevalidateConflictsFn.mockResolvedValue({
    isValid: true,
    errors: [],
    warnings: [],
  });
});

afterEach(() => {
  warn.mockRestore();
  jest.useRealTimers();
});

const budgetWarnings = () =>
  warn.mock.calls.filter((call) =>
    String(call[0]).includes("availability search hit its time budget"),
  );

/** Every occurrence row the write transaction was handed. */
function placedOccurrences(): { startsAt: Date }[] {
  return mockTx.appointment.create.mock.calls.flatMap(
    (call) =>
      (
        call[0] as {
          data?: { occurrences?: { create?: { startsAt: Date }[] } };
        }
      ).data?.occurrences?.create ?? [],
  );
}

describe("the merged custom-availability index", () => {
  it("answers containment exactly as the per-row scan did", () => {
    const index = buildAvailabilityIndex([
      {
        startsAt: at("2026-09-20T09:00:00Z"),
        endsAt: at("2026-09-20T11:00:00Z"),
      },
    ]);
    // Fits whole, the last atom that fits, and the row's exact edges.
    expect(indexCoversAtom(index, at("2026-09-20T09:00:00Z").getTime())).toBe(
      true,
    );
    expect(indexCoversAtom(index, at("2026-09-20T10:30:00Z").getTime())).toBe(
      true,
    );
    expect(indexCoversAtom(index, at("2026-09-20T08:30:00Z").getTime())).toBe(
      false,
    );
    // One millisecond past the end is outside — the atom must fit WHOLE.
    expect(
      indexCoversAtom(index, at("2026-09-20T10:30:00Z").getTime() + 1),
    ).toBe(false);
  });

  it("folds overlapping rows and leaves back-to-back ones separate", () => {
    const merged = buildAvailabilityIndex([
      {
        startsAt: at("2026-09-20T12:00:00Z"),
        endsAt: at("2026-09-20T13:00:00Z"),
      },
      {
        startsAt: at("2026-09-20T09:00:00Z"),
        endsAt: at("2026-09-20T10:00:00Z"),
      },
      {
        startsAt: at("2026-09-20T09:30:00Z"),
        endsAt: at("2026-09-20T11:00:00Z"),
      },
    ]);
    expect(merged).toEqual([
      [
        at("2026-09-20T09:00:00Z").getTime(),
        at("2026-09-20T11:00:00Z").getTime(),
      ],
      [
        at("2026-09-20T12:00:00Z").getTime(),
        at("2026-09-20T13:00:00Z").getTime(),
      ],
    ]);
    // An atom spanning the SEAM of two back-to-back rows is still refused: the
    // scan this replaces tested ONE row at a time, and a merge that crossed the
    // seam would silently widen what a consultant published.
    expect(indexCoversAtom(merged, at("2026-09-20T11:30:00Z").getTime())).toBe(
      false,
    );
  });

  it("drops a malformed row instead of throwing on it", () => {
    const index = buildAvailabilityIndex([
      { startsAt: "not-a-date", endsAt: at("2026-09-20T11:00:00Z") },
      {
        startsAt: at("2026-09-20T11:00:00Z"),
        endsAt: at("2026-09-20T09:00:00Z"),
      },
      {
        startsAt: at("2026-09-20T09:00:00Z"),
        endsAt: at("2026-09-20T11:00:00Z"),
      },
    ]);
    expect(index).toHaveLength(1);
    expect(indexCoversAtom(index, at("2026-09-20T09:00:00Z").getTime())).toBe(
      true,
    );
  });

  it("is built ONCE per allocation, not once per candidate", async () => {
    mockTx.class.findUnique.mockResolvedValue(
      classWith(customRows("2025-06-01T09:00:00.000Z", 30)),
    );

    await SchedulingService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "auto",
    });

    // 8 sessions over 30 published days, each day walked row by row and start by
    // start: the old arm re-scanned every row on every one of those candidates.
    // The index is still built exactly once.
    expect(mockIndexBuilds).toBe(1);
  });
});

describe("the search's time budget", () => {
  it("stops the day walk and answers with the ordinary shortage", async () => {
    mockTx.class.findUnique.mockResolvedValue(
      classWith(customRows("2025-06-01T09:00:00.000Z", 120)),
    );
    // The first index build — the first work the sweep does — costs more than
    // the whole budget.
    mockSpendMs = 30_000;

    const result = await SchedulingService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "auto",
    });

    // A shortage, NOT a timeout and NOT a new error type: the routes already map
    // SLOT_SHORTAGE and its placeable count.
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("SLOT_SHORTAGE");
    expect(result.httpStatus).toBe(400);
    // The first day's session was placed before the budget bit, and the count
    // says so: a partial answer beats an infrastructure timeout, and the count
    // is what lets the consultant be offered "place 1 now".
    expect(result.placeableSessions).toBe(1);
    expect(result.requiredSessions).toBe(8);
  });

  it("says it spent the budget, once, with the consultant and event named", async () => {
    mockTx.class.findUnique.mockResolvedValue(
      classWith(customRows("2025-06-01T09:00:00.000Z", 120)),
    );
    mockSpendMs = 30_000;

    await SchedulingService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "auto",
    });

    // Without this the truncated walk is indistinguishable from a genuinely full
    // calendar, and the next thing anyone would do is widen the search again.
    expect(budgetWarnings()).toHaveLength(1);
    expect(budgetWarnings()[0][1]).toMatchObject({
      budgetMs: 10_000,
      consultantUserId: "consultant-user-1",
      consultantProfileId: "consultant-profile-1",
      eventType: "class",
      eventId: "class-1",
      customRows: 120,
    });
    expect(addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "scheduling",
        level: "warning",
        data: expect.objectContaining({ eventId: "class-1" }),
      }),
    );
  });

  it("still honours allowPartial: a truncated search places what it found", async () => {
    mockTx.class.findUnique.mockResolvedValue(
      classWith(customRows("2025-06-01T09:00:00.000Z", 120)),
    );
    mockSpendMs = 30_000;

    const result = await SchedulingService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "auto",
      allowPartial: true,
    });

    // "No more room" and "the clock ran out" are the same answer to the
    // allocator, which is exactly why `allowPartial` needs no special case: the
    // budget changes only how many days were walked.
    expect(result.success).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.placedSessions).toBeGreaterThan(0);
    expect(result.placedSessions).toBeLessThan(8);
    expect(result.unplacedSessions).toBe(8 - (result.placedSessions ?? 0));
  });

  it("is never consulted when the search is cheap", async () => {
    mockTx.class.findUnique.mockResolvedValue(
      classWith(customRows("2025-06-01T09:00:00.000Z", 120)),
    );
    mockSpendMs = 0;

    const result = await SchedulingService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
    expect(result.partial).toBeUndefined();
    expect(placedOccurrences()).toHaveLength(8);
    expect(budgetWarnings()).toHaveLength(0);
  });

  it("keeps the grid on the truncated path too", async () => {
    // Rows published at 09:15: the truncated search still must not emit a start
    // the buyer path refuses.
    mockTx.class.findUnique.mockResolvedValue(
      classWith(customRows("2025-06-01T09:15:00.000Z", 120)),
    );
    mockSpendMs = 30_000;

    await SchedulingService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "auto",
      allowPartial: true,
    });

    expect(placedOccurrences()).toHaveLength(0);
  });
});

describe("createSearchBudget", () => {
  it("is an injectable ceiling, so exhaustion is testable without waiting", () => {
    let now = 1_000;
    const budget = createSearchBudget(500, () => now);
    expect(budget.exhausted()).toBe(false);
    expect(budget.spentMs()).toBe(0);
    now = 1_499;
    expect(budget.exhausted()).toBe(false);
    now = 1_501;
    expect(budget.exhausted()).toBe(true);
    expect(budget.spentMs()).toBe(501);
    expect(budget.limitMs).toBe(500);
  });

  it("defaults to Date.now, which is what the allocator passes", () => {
    const budget = createSearchBudget(10_000);
    expect(budget.exhausted()).toBe(false);
    jest.setSystemTime(Date.now() + 10_001);
    expect(budget.exhausted()).toBe(true);
  });
});

/**
 * initialAllocation multi-tab guard (service level).
 *
 * Auto locks the whole consultant while manual shards its Redis key by day
 * (#860), so a cross-mode race between two tabs slips past the locks and the
 * manual path would silently delete-and-replace the winner's allocation.
 * With `initialAllocation: true` (sent by the Allocate Slots dialog for fresh
 * PENDING requests) any existing confirmed slot must produce a typed 409.
 * Without the flag, replace/reschedule semantics are preserved.
 */

import "../fixtures/host-time-locks-free";
import "./setup";
import fs from "fs";
import { errorSentence } from "../../components/dashboard/shared/requests/labels";
import { ALREADY_SCHEDULED_COPY } from "../../lib/scheduling/allocationMessages";

// Mock prisma (relative path required — @/ aliases fail in jest.mock)
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    // The allocator's slot batch reads co-host seats and an expert consultee's own profile.
    consultantProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    collaborator: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
    consultation: { findUnique: jest.fn() },
    subscription: { findUnique: jest.fn() },
    webinar: { findUnique: jest.fn() },
    class: { findUnique: jest.fn() },
    appointment: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    appointmentOccurrence: { count: jest.fn(), findFirst: jest.fn() },
  },
  ALLOCATION_TX_MAX_WAIT_MS: 8000,
  ALLOCATION_TX_TIMEOUT_MS: 30000,
}));

// Mock ScheduleValidationService so the race-window test can reach the write
// transaction without a full availability fixture (same pattern as
// schedulingService.test.ts).
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

// Mock appointmentlock to avoid @upstash/redis ESM import issues in Jest
jest.mock("../../utils/appointmentlock", () => ({
  ...jest.requireActual("../fixtures/lock-mocks").lockDoubles(),
  // allocate() takes an existing booking's appointment lock first.
  withAppointmentLock: (_id: string, fn: (lock: unknown) => unknown) =>
    fn({ key: "appointment-lock" }),
  renewAppointmentLock: async () => true,
  lockAutoAllocate: jest
    .fn()
    .mockResolvedValue({ key: "mock-key", value: "mock-value" }),
  unlockAutoAllocate: jest.fn().mockResolvedValue(undefined),
  lockConsulteeBooking: jest
    .fn()
    .mockResolvedValue({ key: "mock-consultee-key", value: "mock-value" }),
  unlockConsulteeBooking: jest.fn().mockResolvedValue(undefined),
  tryLockSlotBatch: jest.fn().mockResolvedValue({ ok: true, grant: [] }),
  extendSlotInterval: jest.fn().mockResolvedValue(true),
  unlockSlotInterval: jest.fn().mockResolvedValue(undefined),
}));

const reportSentryError = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  __esModule: true,
  reportSentryError: (...a: unknown[]) => reportSentryError(...a),
  reportSentryMessage: jest.fn(),
}));

import prisma from "@/lib/prisma";
import { allocate } from "@/lib/booking/allocation";

const mockPrisma = prisma as unknown as {
  $transaction: jest.Mock;
  subscription: { findUnique: jest.Mock };
  appointment: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
  };
  appointmentOccurrence: { count: jest.Mock; findFirst: jest.Mock };
};

const FUTURE_SLOTS = ["2026-08-03T09:00:00.000Z", "2026-08-03T09:30:00.000Z"];

// #1766 — a subscription with held sessions appends its next cycle, so its
// guard is decided AFTER the wrapper's rows are read (an empty wrapper here).
// The fixture therefore carries enough for fetchEventData to run.
const SUBSCRIPTION_ROW = {
  subscriptionPlan: {
    consultantProfileId: "cp-1",
    consultantProfile: {
      user: { id: "consultant-user-1" },
      scheduleType: "WEEKLY",
      availabilityWindowsWeekly: [],
      availabilityWindowsCustom: [],
    },
    durationInMonths: 1,
    sessionsPerWeek: 1,
    sessionDurationInHours: 1,
    totalSessions: 1,
  },
  sessionsTotal: null,
  requestedBy: { user: { id: "user-1" } },
  appointment: null,
  schedulingPeriodStartsAt: new Date("2026-08-02T00:00:00.000Z"),
  schedulingPeriodEndsAt: new Date("2026-08-29T23:59:59.000Z"),
  schedulingTimezone: "Asia/Kolkata",
  // A plan end well ahead of the real clock: these rows are mid-plan.
  planEndsAt: new Date("2099-01-01T00:00:00.000Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.subscription.findUnique.mockResolvedValue(SUBSCRIPTION_ROW);
  mockPrisma.appointment.findFirst.mockResolvedValue(null);
  mockPrisma.appointment.findMany.mockResolvedValue([]);
});

describe("manual allocation with initialAllocation", () => {
  it("returns a typed 409 when another session already confirmed slots", async () => {
    mockPrisma.appointmentOccurrence.count.mockResolvedValue(4);

    const result = await allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: FUTURE_SLOTS,
      initialAllocation: true,
    });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    // The one 409 that may close the dialog and drop the row.
    expect(result.errorCode).toBe("ALREADY_ALLOCATED");
    expect(result.error).toContain("already allocated in another session");
    // The guard fires before anything is written.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("counts only confirmed slots — tentative checkout holds do not trip the guard", async () => {
    mockPrisma.appointmentOccurrence.count.mockResolvedValue(0);

    const result = await allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: FUTURE_SLOTS,
      initialAllocation: true,
    });

    // Guard passes (count=0) and the flow proceeds into a write transaction
    // this harness does not model — whatever that yields, not the 409 guard.
    expect(mockPrisma.appointmentOccurrence.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isTentative: false }),
      }),
    );
    expect(result.httpStatus).not.toBe(409);
  });

  it("without the flag, existing confirmed slots do NOT 409 (replace/reschedule preserved)", async () => {
    mockPrisma.appointmentOccurrence.count.mockResolvedValue(4);

    const result = await allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: FUTURE_SLOTS,
    });

    // The allocator still counts what the plan holds (to record how it was
    // scheduled), but never runs the confirmed-slots guard (`notIn` dead).
    const guardReads = mockPrisma.appointmentOccurrence.count.mock.calls.filter(
      ([args]) => JSON.stringify(args).includes('"notIn"'),
    );
    expect(guardReads).toEqual([]);
    expect(result.error).not.toContain("already allocated in another session");
  });
});

describe("a consultation that already has a time (server-derived)", () => {
  it.each(["manual", "auto"] as const)(
    "%s mode refuses with ALREADY_ALLOCATED whatever the client sends",
    async (mode) => {
      (
        prisma as unknown as { consultation: { findUnique: jest.Mock } }
      ).consultation.findUnique.mockResolvedValue({
        consultationPlan: { consultantProfileId: "cp-1" },
        requestedBy: { user: { id: "user-1" } },
      });
      mockPrisma.appointmentOccurrence.count.mockResolvedValue(1);

      const result = await allocate({
        eventType: "consultation",
        eventId: "con-1",
        mode,
        slots: mode === "manual" ? FUTURE_SLOTS : undefined,
      });

      expect(result.httpStatus).toBe(409);
      expect(result.errorCode).toBe("ALREADY_ALLOCATED");
      expect(result.error).toBe(
        "This booking already has a time. Use Reschedule to move it.",
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    },
  );
});

it("the allocate page, the grid, the inbox and the detail page use the same sentence", () => {
  const read = (rel: string) => fs.readFileSync(rel, "utf8");
  const page = read(
    "app/dashboard/consultant/[consultantId]/(features)/requests/[requestId]/allocate/page.tsx",
  );
  expect(page).toContain("{ALREADY_SCHEDULED_COPY}");
  expect(page).toContain("/reschedule`}");
  expect(read("hooks/scheduling/useScheduling.ts")).toMatch(
    /eventType === "consultation"\s*\?\s*alreadyScheduled\(\)/,
  );
  expect(read("components/appointments/detail/NeedsYouCallout.tsx")).toMatch(
    /type === "CONSULTATION"\s*\?\s*alreadyScheduled\(\)/,
  );
  expect(errorSentence("ALREADY_ALLOCATED", "")).toBe(ALREADY_SCHEDULED_COPY);
});

describe("manual allocation: transaction race window", () => {
  it("409s when the pre-lock count sees zero but the in-txn count sees confirmed slots", async () => {
    // Tab B commits between tab A's out-of-txn guard and its write txn: the
    // first count returns 0, the advisory-locked in-txn count returns 2.
    mockPrisma.appointmentOccurrence.count.mockResolvedValue(0);
    mockValidateFn.mockResolvedValue({
      isValid: true,
      errors: [],
      warnings: [],
    });
    mockRevalidateConflictsFn.mockResolvedValue({ isValid: true, errors: [] });

    const mockTx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      appointmentOccurrence: { count: jest.fn().mockResolvedValue(2) },
    };
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
    );

    const result = await allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: FUTURE_SLOTS,
      initialAllocation: true,
    });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    // The advisory lock is taken before the in-txn count
    expect(mockTx.$executeRaw).toHaveBeenCalled();
    expect(mockTx.appointmentOccurrence.count).toHaveBeenCalled();
  });
});

describe("auto allocation with initialAllocation", () => {
  it("returns a typed 409 when another session already confirmed slots", async () => {
    mockPrisma.appointmentOccurrence.count.mockResolvedValue(2);

    const result = await allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "auto",
      initialAllocation: true,
    });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    expect(result.error).toContain("already allocated in another session");
  });
});

/**
 * #1692 item 3 — the requested path now reads and validates BEFORE the write
 * transaction (the #908 shape), so the harness needs a subscription whose
 * stored times exist and validate; the guard inside the transaction is then
 * the only thing left to decide.
 */
const REQUESTED_ROW = {
  id: "appt-1",
  occurrences: [
    {
      id: "occ-1",
      startsAt: new Date("2026-08-03T09:00:00.000Z"),
      endsAt: new Date("2026-08-03T10:00:00.000Z"),
      isTentative: true,
      completionStatus: "SCHEDULED",
      deletedAt: null,
    },
  ],
};

function wireRequestedSubscription() {
  mockPrisma.subscription.findUnique.mockResolvedValue({
    subscriptionPlan: {
      consultantProfileId: "cp-1",
      consultantProfile: {
        user: { id: "consultant-user-1" },
        scheduleType: "WEEKLY",
        availabilityWindowsWeekly: [],
        availabilityWindowsCustom: [],
      },
      durationInMonths: 1,
      sessionsPerWeek: 1,
      sessionDurationInHours: 1,
      totalSessions: 1,
    },
    requestedBy: { user: { id: "user-1" } },
    appointment: { ...REQUESTED_ROW, organizationId: null, payment: [] },
    appointments: [],
    schedulingPeriodStartsAt: new Date("2026-08-02T00:00:00.000Z"),
    schedulingPeriodEndsAt: new Date("2026-08-29T23:59:59.000Z"),
    schedulingTimezone: "Asia/Kolkata",
    // A plan end well ahead of the real clock: these rows are mid-plan.
    planEndsAt: new Date("2099-01-01T00:00:00.000Z"),
  });
  mockPrisma.appointment.findMany.mockResolvedValue([REQUESTED_ROW]);
  mockValidateFn.mockResolvedValue({ isValid: true, errors: [], warnings: [] });
  mockRevalidateConflictsFn.mockResolvedValue({ isValid: true, errors: [] });
}

describe("requested allocation with initialAllocation", () => {
  it("re-checks the guard INSIDE the transaction and 409s", async () => {
    wireRequestedSubscription();
    const mockTx = {
      // Advisory xact lock taken before the guard count (ADR B10 atomicity)
      $executeRaw: jest.fn().mockResolvedValue(1),
      appointmentOccurrence: { count: jest.fn().mockResolvedValue(2) },
      appointment: { findMany: jest.fn().mockResolvedValue([REQUESTED_ROW]) },
    };
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
    );

    const result = await allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "requested",
      initialAllocation: true,
    });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    expect(mockTx.appointmentOccurrence.count).toHaveBeenCalled();
  });
});

describe("advisory lock statement shape (#1518)", () => {
  it("takes the lock through $executeRaw with the per-event key, then continues", async () => {
    // pg_advisory_xact_lock returns void; $queryRaw made the Prisma 7 driver
    // adapter deserialise that column and throw before allocation began.
    wireRequestedSubscription();
    const mockTx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([]),
      appointmentOccurrence: { count: jest.fn().mockResolvedValue(0) },
      appointment: { findMany: jest.fn().mockResolvedValue([REQUESTED_ROW]) },
    };
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
    );

    const result = await allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "requested",
      initialAllocation: true,
    });

    expect(mockTx.$queryRaw).not.toHaveBeenCalled();
    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
    const [fragments, key] = mockTx.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      string,
    ];
    expect(Array.from(fragments).join("")).toContain(
      "SELECT pg_advisory_xact_lock(hashtextextended(",
    );
    expect(key).toBe("initial-allocation:subscription:sub-1");
    // The guard ran on past the lock: zero confirmed slots, so no 409.
    expect(mockTx.appointmentOccurrence.count).toHaveBeenCalled();
    expect(result.httpStatus).not.toBe(409);
  });
});

/**
 * #1692 items 1–2 — the per-event advisory lock and the in-txn replay used to
 * be gated on `isFreshAllocation`, so a reschedule (confirmed rows already
 * exist) serialised on nothing and a same-key retry met the key's unique
 * index as a 409. Both now run first in every allocation transaction.
 */
describe("#1692 — a non-fresh (reschedule) manual allocation is advisory-locked and replays", () => {
  it("takes the lock and returns the stamped batch instead of writing again", async () => {
    const confirmedRow = {
      id: "appt-1",
      subscriptionId: "sub-1",
      occurrences: [
        {
          id: "occ-1",
          startsAt: new Date("2026-08-03T09:00:00.000Z"),
          endsAt: new Date("2026-08-03T10:00:00.000Z"),
          isTentative: false,
          completionStatus: "SCHEDULED",
          deletedAt: null,
        },
      ],
    };
    mockPrisma.subscription.findUnique.mockResolvedValue({
      subscriptionPlan: {
        consultantProfileId: "cp-1",
        consultantProfile: {
          user: { id: "consultant-user-1" },
          scheduleType: "WEEKLY",
          availabilityWindowsWeekly: [],
          availabilityWindowsCustom: [],
        },
        durationInMonths: 1,
        sessionsPerWeek: 1,
        sessionDurationInHours: 1,
        totalSessions: 2,
      },
      requestedBy: { user: { id: "user-1" } },
      appointments: [],
      schedulingPeriodStartsAt: new Date("2026-08-02T00:00:00.000Z"),
      schedulingPeriodEndsAt: new Date("2026-12-29T23:59:59.000Z"),
      schedulingTimezone: "Asia/Kolkata",
      // A plan end well ahead of the real clock: these rows are mid-plan.
      planEndsAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    // Confirmed rows exist → not a fresh allocation; the key is not stamped
    // yet when the base client looks, so the pre-lock replay misses.
    mockPrisma.appointment.findMany.mockResolvedValue([confirmedRow]);
    mockPrisma.appointment.findUnique.mockResolvedValue(null);
    mockValidateFn.mockResolvedValue({
      isValid: true,
      errors: [],
      warnings: [],
    });
    mockRevalidateConflictsFn.mockResolvedValue({ isValid: true, errors: [] });

    // Behind the advisory lock the winner's stamp is visible.
    const mockTx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      appointment: {
        findUnique: jest.fn().mockResolvedValue({ subscriptionId: "sub-1" }),
        findMany: jest.fn().mockResolvedValue([confirmedRow]),
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
      subscription: {
        findUnique: jest.fn().mockResolvedValue({
          subscriptionPlan: { totalSessions: 2 },
        }),
      },
      appointmentOccurrence: { count: jest.fn().mockResolvedValue(0) },
    };
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
    );

    const result = await allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: FUTURE_SLOTS,
      idempotencyKey: "retry-key-1",
    });

    expect(result.success).toBe(true);
    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockTx.$executeRaw.mock.calls[0][1]).toBe(
      "initial-allocation:subscription:sub-1",
    );
    // Replayed, not re-written; and no confirmed-slot assertion on a reschedule.
    expect(mockTx.appointment.create).not.toHaveBeenCalled();
    expect(mockTx.appointment.deleteMany).not.toHaveBeenCalled();
    expect(mockTx.appointmentOccurrence.count).not.toHaveBeenCalled();
  });
});

/**
 * #1697 item 3 — the loser's fast exit. A manual allocation onto a time the
 * consultant already holds confirmed answers SLOT_TAKEN from one indexed
 * probe, before the lock wait, the full validation and the transaction.
 */
describe("#1697 — pre-lock occupancy probe on manual allocation", () => {
  it("answers SLOT_TAKEN before taking any lock when a confirmed row overlaps", async () => {
    const { lockAutoAllocate } = jest.requireMock(
      "../../utils/appointmentlock",
    );
    mockPrisma.appointmentOccurrence.findFirst.mockResolvedValue({
      startsAt: new Date(FUTURE_SLOTS[0]),
    });

    const result = await allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: FUTURE_SLOTS,
    });

    expect(result.httpStatus).toBe(409);
    expect(result.errorCode).toBe("SLOT_TAKEN");
    expect(lockAutoAllocate).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    const where =
      mockPrisma.appointmentOccurrence.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      consultantProfileId: "cp-1",
      isTentative: false,
      deletedAt: null,
      appointment: {
        OR: [{ subscriptionId: null }, { subscriptionId: { not: "sub-1" } }],
      },
    });
  });
});

/**
 * #1721 QA (FAMILIARISE_WEB-4K) — a refusal the allocator answers with a 4xx
 * is an expected outcome and reports at info; only a 5xx is a fault.
 */
describe("expected refusals report as expected", () => {
  it("tags a manual allocation with an odd slot count expected:true, and a fault expected:false", async () => {
    mockPrisma.appointmentOccurrence.findFirst.mockResolvedValue(null);
    mockPrisma.subscription.findUnique.mockResolvedValue({
      subscriptionPlan: {
        consultantProfileId: "cp-1",
        consultantProfile: {
          user: { id: "consultant-user-1" },
          scheduleType: "WEEKLY",
          availabilityWindowsWeekly: [],
          availabilityWindowsCustom: [],
        },
        durationInMonths: 1,
        sessionsPerWeek: 1,
        sessionDurationInHours: 1,
        totalSessions: 1,
      },
      requestedBy: { user: { id: "user-1" } },
      appointments: [],
      schedulingPeriodStartsAt: new Date("2026-08-02T00:00:00.000Z"),
      schedulingPeriodEndsAt: new Date("2026-08-29T23:59:59.000Z"),
      schedulingTimezone: "Asia/Kolkata",
      // A plan end well ahead of the real clock: these rows are mid-plan.
      planEndsAt: new Date("2099-01-01T00:00:00.000Z"),
    });

    const odd = await allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: [FUTURE_SLOTS[0]],
    });
    expect(odd.httpStatus).toBe(400);
    expect(reportSentryError).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Pick whole sessions"),
      }),
      expect.objectContaining({ expected: true }),
    );

    mockPrisma.subscription.findUnique.mockRejectedValue(
      new Error("connect ETIMEDOUT"),
    );
    const fault = await allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: FUTURE_SLOTS,
    });
    expect(fault.httpStatus).toBe(500);
    expect(reportSentryError).toHaveBeenLastCalledWith(
      expect.any(Error),
      expect.objectContaining({ expected: false }),
    );
  });
});

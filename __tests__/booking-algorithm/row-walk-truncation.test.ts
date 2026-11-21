/**
 * #1194 — a truncated availability row must say so.
 *
 * `MAX_CANDIDATE_STARTS_PER_ROW = 50` bounds the 30-minute starts walked out of
 * one availability row. `rowEndMs` normally ends the walk first, and a custom
 * row is walked as scheduling-zone day slices, ≤ 25 h in every inhabited zone. A
 * weekly row longer than any day still exits on the ceiling — and it used to do
 * so in complete silence, so the tail of that row was invisible to allocation
 * and the resulting SLOT_SHORTAGE was indistinguishable from a genuinely full
 * calendar.
 */

import "./setup";

// The in-transaction availability re-read has its own suite; these isolate the allocator.
jest.mock("../../lib/booking/allocation/coverage", () => ({
  assertSlotsStillPublished: jest.fn(async () => undefined),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    // The allocator counts what the event already holds to record how it was scheduled.
    appointmentOccurrence: { count: jest.fn().mockResolvedValue(0) },
    // The allocator's slot batch reads co-host seats and an expert consultee's own profile.
    consultantProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    collaborator: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
    consultation: { findUnique: jest.fn() },
    subscription: { findUnique: jest.fn() },
    webinar: { findUnique: jest.fn() },
    class: { findUnique: jest.fn() },
    appointment: { findMany: jest.fn() },
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
  tryLockSlotBatch: jest.fn().mockResolvedValue({ ok: true, grant: [] }),
  extendSlotInterval: jest.fn().mockResolvedValue(true),
  unlockSlotInterval: jest.fn().mockResolvedValue(undefined),
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

import prisma from "@/lib/prisma";
import { allocate } from "@/lib/booking/allocation";
import { ScheduleType } from "@prisma/client";

const base = prisma as unknown as Record<string, Record<string, jest.Mock>>;

/** A CUSTOM availability row of `hours`, starting Mon 2025-01-06 00:00 UTC. */
function customRow(hours: number) {
  const startsAt = new Date("2025-01-06T00:00:00.000Z");
  return {
    id: `custom-${hours}h`,
    startsAt,
    endsAt: new Date(startsAt.getTime() + hours * 60 * 60 * 1000),
  };
}

/**
 * A UTC WEEKLY row of `hours` (more than a day), starting Monday 00:00. A
 * legacy-only shape: writes cap weekly rows at 12 h.
 */
function longWeeklyRow(hours: number) {
  return {
    id: `weekly-${hours}h`,
    timezone: "UTC",
    localStartDay: "MONDAY",
    localStartMinutes: 0,
    localEndDay: "TUESDAY",
    localEndMinutes: (hours - 24) * 60,
  };
}

function consultationWithRow(
  hours: number,
  scheduleType: ScheduleType = ScheduleType.CUSTOM,
) {
  const weekly = scheduleType === ScheduleType.WEEKLY;
  return {
    id: "consult-1",
    consultationPlan: {
      consultantProfileId: "consultant-profile-1",
      durationInHours: 1,
      consultantProfile: {
        user: { id: "consultant-user-1", timezone: "UTC" },
        scheduleType,
        availabilityWindowsWeekly: weekly ? [longWeeklyRow(hours)] : [],
        availabilityWindowsCustom: weekly ? [] : [customRow(hours)],
      },
    },
    requestedBy: { user: { id: "consultee-1" } },
    appointment: null,
  };
}

const mockTx = {
  // The expert-standing read under a share lock; no row reads as standing.
  $queryRaw: jest.fn(async () => []),
  consultation: {
    findUnique: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  consultantProfile: {
    findFirst: jest.fn().mockResolvedValue({ id: "consultant-profile-1" }),
  },
  collaborator: { findMany: jest.fn().mockResolvedValue([]) },
  // #1319 A9/A12 — allocation shadow-writes the participant edge and
  // appends status history inside the CAS helpers.
  appointmentParticipant: {
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
  appointment: {
    // #1569 — the earnings-hold recompute reads the wrapper; none paid here.
    findUnique: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    // #1499 — createAppointments reads the originating appointment to
    // inherit the policy version the booking was sold under. Null here:
    // these fixtures predate the FK, so the created rows carry no policy.
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: "apt-1", occurrences: [] }),
    update: jest.fn().mockResolvedValue({ id: "apt-1", occurrences: [] }),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  appointmentOccurrence: {
    findFirst: jest.fn().mockResolvedValue(null),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
  },
  $executeRaw: jest.fn().mockResolvedValue(1),
};

let warn: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  addBreadcrumb.mockClear();

  (prisma.$transaction as jest.Mock).mockImplementation(
    async (callback: (tx: unknown) => unknown) => callback(mockTx),
  );
  base.appointment = mockTx.appointment;
  base.consultation.findUnique = mockTx.consultation.findUnique;
  base.rescheduleRequest.findFirst.mockResolvedValue(null);

  mockValidateFn.mockReset();
  mockValidateFn.mockResolvedValue({ isValid: true, errors: [], warnings: [] });
  mockRevalidateConflictsFn.mockReset();
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

const truncationWarnings = () =>
  warn.mock.calls.filter((call) =>
    String(call[0]).includes("MAX_CANDIDATE_STARTS_PER_ROW"),
  );

describe("#1194 — the candidate-start ceiling is no longer silent", () => {
  it("warns, with consultant and event ids, when the cap ends the walk", async () => {
    // A 26-hour weekly row: the walk consumes its 50 starts and the 51st is
    // still inside the row, so the ceiling — not the row — ended it.
    mockTx.consultation.findUnique.mockResolvedValue(
      consultationWithRow(26, ScheduleType.WEEKLY),
    );

    const result = await allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
    const warnings = truncationWarnings();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0][1]).toMatchObject({
      cap: 50,
      consultantUserId: "consultant-user-1",
      consultantProfileId: "consultant-profile-1",
      eventType: "consultation",
      eventId: "consult-1",
      rowStart: "2025-01-06T00:00:00.000Z",
      rowEnd: "2025-01-07T02:00:00.000Z",
    });

    expect(addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "scheduling",
        level: "warning",
        data: expect.objectContaining({ eventId: "consult-1" }),
      }),
    );
  });

  it("stays silent when the ROW ends the walk", async () => {
    // Four hours of cover: 8 starts, then the row's own end stops it.
    mockTx.consultation.findUnique.mockResolvedValue(consultationWithRow(4));

    const result = await allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
    expect(truncationWarnings()).toHaveLength(0);
    expect(addBreadcrumb).not.toHaveBeenCalled();
  });

  it("stays silent when the row ends exactly at the 50th start", async () => {
    // 25 hours = exactly MAX_CANDIDATE_STARTS_PER_ROW starts. Nothing was
    // truncated, so reporting one would be a false positive.
    mockTx.consultation.findUnique.mockResolvedValue(
      consultationWithRow(25, ScheduleType.WEEKLY),
    );

    const result = await allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
    expect(truncationWarnings()).toHaveLength(0);
  });

  it("stays silent for a 48-hour custom row, which is walked one day at a time", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(consultationWithRow(48));

    const result = await allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
    expect(truncationWarnings()).toHaveLength(0);
    expect(addBreadcrumb).not.toHaveBeenCalled();
  });
});

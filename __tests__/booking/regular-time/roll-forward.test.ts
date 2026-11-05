/**
 * @jest-environment node
 */

/**
 * The roll-forward: fills the open horizon weeks at the projected times,
 * skips what already holds a session (a second run places nothing), skips a
 * slot lost to a race without failing the others, rotates fairly, stops at
 * the deadline with `hasMore`, and only reads live, unpaused Regular-time plans.
 */
const mockPrisma = {
  subscription: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
  appointmentOccurrence: { findMany: jest.fn() },
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockPrisma;
  },
}));
jest.mock("@/lib/booking/allocation", () => ({ allocate: jest.fn() }));
jest.mock("@/lib/booking/allocation/event-data", () => ({
  fetchEventData: jest.fn(),
}));
jest.mock("@/lib/booking/cancel-actor", () => ({
  isHostOrgOperatorOf: jest.fn(),
}));
jest.mock("@/lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn((_job: string, _opts: unknown, fn: () => unknown) =>
    fn(),
  ),
}));
const mockOutOfTime = jest.fn(() => false);
jest.mock("@/lib/cron/run-deadline", () => ({
  startDeadline: () => mockOutOfTime,
}));
const mockFailures = { add: jest.fn(), flush: jest.fn() };
jest.mock("@/lib/observability/run-failures", () => ({
  createRunFailureReporter: () => mockFailures,
}));
jest.mock("@/lib/booking/week-nudge", () => ({
  nudgeRegularTimeConflicts: jest.fn(async () => ({ nudged: 0, errors: [] })),
}));

import { allocate } from "@/lib/booking/allocation";
import { fetchEventData } from "@/lib/booking/allocation/event-data";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { nudgeRegularTimeConflicts } from "@/lib/booking/week-nudge";
import {
  rollForwardRegularTime,
  rollablePlansWhere,
} from "@/lib/booking/regular-time/roll-forward";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = new Date("2026-11-01T18:30:00Z"); // Mon 2 Nov 00:00 IST
const NOW = new Date("2026-11-02T03:30:00Z");

function occ(k: number, d: number) {
  const startsAt = new Date(START.getTime() + (7 * k + d) * DAY + 18 * HOUR);
  return {
    id: `o-${k}-${d}`,
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    completionStatus: "SCHEDULED",
    isTentative: false,
    deletedAt: null,
  };
}

function plan(id: string, occurrences: ReturnType<typeof occ>[]) {
  return {
    id,
    status: "SCHEDULED",
    deletedAt: null,
    sessionsTotal: 78,
    sessionsPerWeek: 3,
    sessionMinutes: 60,
    sessionsRefunded: 0,
    schedulingPeriodStartsAt: START,
    schedulingTimezone: "Asia/Kolkata",
    planEndsAt: new Date(START.getTime() + 26 * 7 * DAY),
    rollPausedAt: null,
    lastRolledAt: null,
    requestedBy: { user: { id: "client-1", name: "Priya" } },
    subscriptionPlan: {
      title: "Maths",
      organizationId: null,
      consultantProfileId: "cp-1",
      totalSessions: 78,
      sessionsPerWeek: 3,
      durationInMonths: 6,
      sessionDurationInHours: 1,
      consultantProfile: {
        user: { id: "expert-1", name: "Asha", timezone: "Asia/Kolkata" },
      },
    },
    appointment: { id: `appt-${id}`, occurrences },
    regularTimes: [1, 3, 5].map((weekday, i) => ({
      id: `rt-${i}`,
      weekday,
      localStartMinutes: 18 * 60,
      validFrom: START,
      validUntil: null,
    })),
  };
}

const week0 = [occ(0, 0), occ(0, 2), occ(0, 4)];
const fourWeeks = [0, 1, 2, 3].flatMap((k) => [
  occ(k, 0),
  occ(k, 2),
  occ(k, 4),
]);

beforeEach(() => {
  jest.clearAllMocks();
  mockOutOfTime.mockReturnValue(false);
  mockPrisma.appointmentOccurrence.findMany.mockResolvedValue([]);
  mockPrisma.subscription.updateMany.mockResolvedValue({ count: 1 });
  (allocate as jest.Mock).mockResolvedValue({ success: true });
  (fetchEventData as jest.Mock).mockResolvedValue({
    consultant: {
      userId: "expert-1",
      scheduleType: "CUSTOM",
      availabilityWindowsWeekly: [],
      availabilityWindowsCustom: [
        {
          id: "all",
          startsAt: new Date("2026-10-01T00:00:00Z"),
          endsAt: new Date("2027-12-01T00:00:00Z"),
        },
      ],
    },
  });
});

describe("rollForwardRegularTime", () => {
  it("T15/T26: fills weeks 2–4 under its own lock, a second run places nothing, the rotation is fair", async () => {
    mockPrisma.subscription.findMany.mockResolvedValue([
      { id: "sub-1", lastRolledAt: null },
    ]);
    mockPrisma.subscription.findUnique
      .mockResolvedValueOnce(plan("sub-1", week0))
      .mockResolvedValueOnce(plan("sub-1", fourWeeks));
    const first = await rollForwardRegularTime({ now: NOW });
    expect(withCronLock).toHaveBeenCalledWith(
      "roll-forward-regular-time",
      { failMode: "closed" },
      expect.any(Function),
    );
    expect(first).toMatchObject({
      scanned: 1,
      placed: 9,
      conflicts: 0,
      errors: 0,
    });
    expect(
      (allocate as jest.Mock).mock.calls.map((c) => c[0].slots[0]),
    ).toEqual(fourWeeks.slice(3).map((o) => o.startsAt.toISOString()));
    expect(mockPrisma.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { lastRolledAt: { sort: "asc", nulls: "first" } },
          { id: "asc" },
        ],
      }),
    );
    expect(mockPrisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: "sub-1", lastRolledAt: null },
      data: { lastRolledAt: NOW },
    });

    jest.clearAllMocks();
    mockPrisma.subscription.findMany.mockResolvedValue([
      { id: "sub-1", lastRolledAt: NOW },
    ]);
    mockPrisma.subscription.findUnique.mockResolvedValue(
      plan("sub-1", fourWeeks),
    );
    mockPrisma.appointmentOccurrence.findMany.mockResolvedValue([]);
    const second = await rollForwardRegularTime({ now: NOW });
    expect(second.placed).toBe(0);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("T16: a slot another buyer took between projection and commit is skipped; the rest land; no throw", async () => {
    mockPrisma.subscription.findMany.mockResolvedValue([
      { id: "sub-1", lastRolledAt: null },
    ]);
    mockPrisma.subscription.findUnique
      .mockResolvedValueOnce(plan("sub-1", week0))
      .mockResolvedValueOnce(plan("sub-1", week0));
    (allocate as jest.Mock)
      .mockResolvedValueOnce({ success: false, errorCode: "SLOT_TAKEN" })
      .mockResolvedValue({ success: true });
    const out = await rollForwardRegularTime({ now: NOW });
    expect(out.placed).toBe(8);
    expect(out.errors).toBe(0);
  });

  it("T18/T20: the deadline stops the batch with hasMore; failures report once; conflicts reach the nudge", async () => {
    mockPrisma.subscription.findMany.mockResolvedValue([
      { id: "sub-1", lastRolledAt: null },
      { id: "sub-2", lastRolledAt: null },
    ]);
    mockPrisma.subscription.findUnique
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValue(plan("sub-2", fourWeeks));
    // Taken by another booking: every week-1 slot is a conflict.
    mockPrisma.appointmentOccurrence.findMany.mockResolvedValue([
      {
        startsAt: new Date(START.getTime() + 7 * DAY),
        endsAt: new Date(START.getTime() + 14 * DAY),
      },
    ]);
    const all = await rollForwardRegularTime({ now: NOW });
    expect(all.errors).toBe(1);
    expect(mockFailures.add).toHaveBeenCalledTimes(1);
    expect(mockFailures.flush).toHaveBeenCalledTimes(1);
    expect(nudgeRegularTimeConflicts).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    mockPrisma.subscription.findMany.mockResolvedValue([
      { id: "sub-1", lastRolledAt: null },
      { id: "sub-2", lastRolledAt: null },
    ]);
    mockOutOfTime.mockReturnValue(true);
    const cut = await rollForwardRegularTime({ now: NOW });
    expect(cut).toMatchObject({ scanned: 0, hasMore: true });
  });

  it("T19: paused, ended and Regular-time-less plans are never read", () => {
    expect(rollablePlansWhere(NOW)).toMatchObject({
      status: { in: ["APPROVED", "SCHEDULED"] },
      rollPausedAt: null,
      OR: [{ planEndsAt: null }, { planEndsAt: { gt: NOW } }],
      regularTimes: { some: { validUntil: null } },
    });
  });
});

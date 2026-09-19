/**
 * @jest-environment node
 */

/**
 * #1424 — the tentative-clear sweep of `reconcile-occurrence-availability` reads a
 * cohort of tentative slots whose payment succeeded and then stamps them
 * confirmed. The write used to be scoped by `id IN (...)` alone, so it did not
 * care whether a row was still in the cohort. A partial reschedule releases a
 * slot as `isTentative=true` / `completionStatus=RESCHEDULED` while leaving the
 * parent APPROVED, which the sweep's parent-status guard does not see; a slot
 * that moved that way between the read and the write was stamped confirmed and
 * blocked the consultant's calendar for a session nobody would ever deliver.
 * ADR 21: a sweep repeats its own predicate in the WHERE it writes with.
 */

jest.mock("../../lib/prisma", () => {
  const db: Record<string, unknown> = {
    appointmentOccurrence: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    subscription: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    class: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    appointment: { findMany: jest.fn().mockResolvedValue([]) },
    availabilityWindowWeekly: { groupBy: jest.fn().mockResolvedValue([]) },
    availabilityWindowCustom: { groupBy: jest.fn().mockResolvedValue([]) },
    $disconnect: jest.fn(),
  };
  return { __esModule: true, default: db };
});

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  LONG_JOB_TTL_MS: 1,
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));

// The allocator is out of scope here and drags Novu/undici into the graph.
jest.mock("../../utils/scheduling-engine/SchedulingService", () => ({
  __esModule: true,
  SchedulingService: { allocate: jest.fn() },
}));
jest.mock("../../utils/scheduling-engine/ScheduleCalculationService", () => ({
  __esModule: true,
  ScheduleCalculationService: {
    getSlotsPerCall: jest.fn().mockReturnValue(1),
    calculateRequiredSlots: jest.fn().mockReturnValue(1),
  },
}));

import prisma from "../../lib/prisma";
import { reconcileOccurrenceAvailability } from "../../scripts/appointments/reconcile-occurrence-availability";
import { OccurrenceCompletionStatus } from "@prisma/client";

describe("reconcile-occurrence-availability × tentative-clear race (#1424)", () => {
  it("skips a slot whose completion status changed after the cohort read", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    // Two slots read; one is moved to RESCHEDULED by a partial reschedule
    // before the write lands, so the CAS matches only the other.
    (prisma.appointmentOccurrence.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: "slot-live",
        appointmentId: "apt-1",
        startsAt: new Date("2026-10-01T10:00:00Z"),
        endsAt: new Date("2026-10-01T10:30:00Z"),
      },
      {
        id: "slot-rescheduled",
        appointmentId: "apt-2",
        startsAt: new Date("2026-10-01T11:00:00Z"),
        endsAt: new Date("2026-10-01T11:30:00Z"),
      },
    ]);
    (prisma.appointmentOccurrence.updateMany as jest.Mock).mockResolvedValue({
      count: 1,
    });

    const result = await reconcileOccurrenceAvailability();

    const write = (prisma.appointmentOccurrence.updateMany as jest.Mock).mock
      .calls[0][0];
    expect(write.data).toEqual({ isTentative: false });
    expect(write.where.id).toEqual({
      in: ["slot-live", "slot-rescheduled"],
    });
    // The cohort predicate is repeated at write time, so a row that left the
    // cohort cannot be stamped confirmed by its id alone.
    expect(write.where.isTentative).toBe(true);
    expect(write.where.deletedAt).toBeNull();
    expect(write.where.completionStatus.in).not.toContain(
      OccurrenceCompletionStatus.RESCHEDULED,
    );
    expect(write.where.completionStatus.in).not.toContain(
      OccurrenceCompletionStatus.CANCELLED,
    );
    expect(write.where.completionStatus.in).toContain(
      OccurrenceCompletionStatus.SCHEDULED,
    );

    // Only the row the write actually matched is counted, and the shortfall is
    // logged rather than swallowed.
    expect(result.tentativeFlagsCleared).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("reconcile_tentative_clear_raced"),
    );
    warn.mockRestore();
  });
});

describe("reconcile-occurrence-availability result semantics (QA #1741)", () => {
  it("reports a completed run with findings as success: true, not a failed run", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const overlap = (id: string, appointmentId: string) => ({
      id,
      appointmentId,
      startsAt: new Date("2026-10-01T10:00:00Z"),
      endsAt: new Date("2026-10-01T11:00:00Z"),
      appointment: {
        consultation: {
          consultationPlan: {
            consultantProfile: {
              id: "cp-1",
              user: { id: "u-c", name: "Olivia", email: "o@x.test" },
            },
          },
        },
        subscription: null,
        webinar: null,
        class: null,
        trial: null,
      },
    });
    // First read: the tentative-clear cohort (empty); second: the double-
    // booking page with two overlapping occurrences for one consultant.
    (prisma.appointmentOccurrence.findMany as jest.Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        overlap("occ-1", "apt-1"),
        overlap("occ-2", "apt-2"),
      ]);
    (
      prisma as unknown as { systemEvent: { findFirst: jest.Mock } }
    ).systemEvent = { findFirst: jest.fn().mockResolvedValue({ id: "seen" }) };

    const result = await reconcileOccurrenceAvailability();

    expect(result.doubleBookingsDetected).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });
});

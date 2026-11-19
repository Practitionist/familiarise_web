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
    appointment: { findMany: jest.fn().mockResolvedValue([]) },
    $disconnect: jest.fn(),
  };
  return { __esModule: true, default: db };
});

jest.mock("../../lib/cron/with-cron-lock", () => ({
  __esModule: true,
  LONG_JOB_TTL_MS: 1,
  withCronLock: (_key: string, _opts: unknown, fn: () => unknown) => fn(),
}));

const reportSentryMessage = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  __esModule: true,
  reportSentryError: jest.fn(),
  reportSentryMessage: (...a: unknown[]) => reportSentryMessage(...a),
}));
// The cross-run dedupe has its own suite; here every finding is new.
jest.mock("../../lib/observability/standing-finding", () => ({
  __esModule: true,
  reportStandingFinding: async (_args: unknown, report: () => void) => {
    report();
    return true;
  },
}));

// This job reads and repairs; it never places a session. Loading the
// allocator from it fails every test in this file.
jest.mock("../../lib/booking/allocation", () => {
  throw new Error("the reconcile job must not load the allocator");
});

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
    (prisma.appointmentOccurrence.updateMany as jest.Mock)
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const result = await reconcileOccurrenceAvailability();

    const calls = (prisma.appointmentOccurrence.updateMany as jest.Mock).mock
      .calls;
    expect(calls.map((c) => c[0].where.id)).toEqual([
      "slot-live",
      "slot-rescheduled",
    ]);
    const write = calls[0][0];
    expect(write.data).toEqual({ isTentative: false });
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

describe("reconcile-occurrence-availability × overlapping tentative rows", () => {
  it("skips a row that would violate the overlap constraint and still clears the rest", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
    (prisma.appointmentOccurrence.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: "slot-overlap",
        appointmentId: "apt-1",
        startsAt: new Date("2026-10-01T10:00:00Z"),
        endsAt: new Date("2026-10-01T10:30:00Z"),
      },
      {
        id: "slot-clean",
        appointmentId: "apt-2",
        startsAt: new Date("2026-10-01T11:00:00Z"),
        endsAt: new Date("2026-10-01T11:30:00Z"),
      },
    ]);
    const exclusion = Object.assign(
      new Error(
        'conflicting key value violates exclusion constraint "occurrence_no_confirmed_overlap"',
      ),
      { code: "23P01" },
    );
    (prisma.appointmentOccurrence.updateMany as jest.Mock)
      .mockRejectedValueOnce(exclusion)
      .mockResolvedValueOnce({ count: 1 });

    const result = await reconcileOccurrenceAvailability();

    expect(result.tentativeFlagsCleared).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("reconcile_tentative_clear_overlap"),
    );
    warn.mockRestore();
  });

  it("never selects slots whose capture is parked for an auto-refund", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    await reconcileOccurrenceAvailability();
    const where = (prisma.appointmentOccurrence.findMany as jest.Mock).mock
      .calls[0][0].where;
    expect(JSON.stringify(where.appointment.NOT)).toContain(
      "Auto-refund pending:",
    );
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
      prisma as unknown as {
        systemEvent: { findFirst: jest.Mock; findMany: jest.Mock };
      }
    ).systemEvent = {
      findFirst: jest.fn().mockResolvedValue({ id: "seen" }),
      findMany: jest.fn().mockResolvedValue([]),
    };

    const result = await reconcileOccurrenceAvailability();

    expect(result.doubleBookingsDetected).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });
});

describe("reconcile-occurrence-availability × participant drift", () => {
  it("reports drift once per run, with the count and ids in the extras", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    (prisma.appointment.findMany as jest.Mock).mockResolvedValueOnce(
      ["apt-1", "apt-2", "apt-3"].map((id) => ({
        id,
        appointmentType: "WEBINAR",
      })),
    );

    await reconcileOccurrenceAvailability();

    const drift = reportSentryMessage.mock.calls.filter(
      ([, opts]) =>
        opts.op === "reconcile-occurrence-availability.participant-drift",
    );
    expect(drift).toHaveLength(1);
    expect(drift[0][1].extra).toEqual({
      count: 3,
      appointmentIds: ["apt-1", "apt-2", "apt-3"],
    });
  });
});

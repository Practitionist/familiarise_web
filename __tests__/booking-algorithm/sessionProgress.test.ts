/**
 * Tests for calculateSessionProgress — the expert's Home "k/n sessions".
 *
 * n is the sessions sold (a plan's sold total, a class plan's total) and k the
 * sessions delivered; the rows placed so far are never the denominator, and a
 * wrapper whose read carries no sold total counts nothing.
 */

import { calculateSessionProgress } from "@/app/dashboard/consultant/[consultantId]/utils/appointmentHelpers";
import type { TAppointment } from "@/types/appointment";

const HOUR = 60 * 60 * 1000;

function occurrence(startISO: string, completionStatus = "SCHEDULED") {
  const startsAt = new Date(startISO);
  return {
    id: startISO,
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    isTentative: false,
    completionStatus,
    meeting: null,
  };
}

function wrapper(
  occurrences: ReturnType<typeof occurrence>[],
  parent: Record<string, unknown> = {},
) {
  return { id: "apt-1", occurrences, ...parent } as unknown as TAppointment;
}

function classWrapper(occurrences: ReturnType<typeof occurrence>[]) {
  return wrapper(occurrences, { class: { classPlan: { totalSessions: 12 } } });
}

describe("calculateSessionProgress", () => {
  it("counts against the class plan's total, not the rows placed so far", () => {
    const r = calculateSessionProgress([
      classWrapper([
        occurrence("2025-07-01T10:00:00Z"),
        occurrence("2025-07-08T10:00:00Z"),
        occurrence("2025-07-15T10:00:00Z"),
      ]),
    ]);

    expect(r.totalSessions).toBe(12);
    expect(r.remainingSessions).toBe(12);
    expect(r.completedSessions).toBe(0);
  });

  it("counts delivered sessions only: a past session with no outcome, a void and a dead row are not delivered", () => {
    const r = calculateSessionProgress([
      classWrapper([
        occurrence("2025-05-01T10:00:00Z", "COMPLETED"),
        occurrence("2025-05-15T10:00:00Z", "UNVERIFIED"),
        occurrence("2025-05-16T10:00:00Z"), // past, outcome not recorded yet
        occurrence("2025-05-17T10:00:00Z", "VOIDED"),
        occurrence("2025-07-01T10:00:00Z"),
        occurrence("2025-07-02T10:00:00Z", "RESCHEDULED"), // dead → ignored
      ]),
    ]);

    expect(r.totalSessions).toBe(12);
    expect(r.completedSessions).toBe(2);
    expect(r.remainingSessions).toBe(10);
    expect(r.progressPercentage).toBeCloseTo((2 / 12) * 100);
  });

  it("a wrapper with no sold total yields zero sessions", () => {
    const r = calculateSessionProgress([
      wrapper([occurrence("2025-07-01T10:00:00Z")]),
    ]);
    expect(r.totalSessions).toBe(0);
    expect(r.remainingSessions).toBe(0);
    expect(r.progressPercentage).toBe(0);
  });
});

// #1766 — with the wrapper's subscription present, the total is the frozen
// entitlement and "completed" the delivered rows, not the allocated-so-far
// count: a 12-plan with cycle one done reads 4 of 12, never 4 of 4.
describe("calculateSessionProgress with the subscription's entitlement", () => {
  it("reads total from sessionsTotal and completed from delivered rows", () => {
    const group = wrapper(
      [
        occurrence("2025-05-01T10:00:00Z", "COMPLETED"),
        occurrence("2025-05-02T10:00:00Z", "COMPLETED"),
        occurrence("2025-05-03T10:00:00Z", "UNVERIFIED"),
        occurrence("2025-05-04T10:00:00Z", "COMPLETED"),
        occurrence("2025-07-01T10:00:00Z"),
      ],
      {
        subscription: {
          sessionsTotal: 12,
          schedulingPeriodStartsAt: new Date("2025-05-01T00:00:00Z"),
          schedulingTimezone: "UTC",
          subscriptionPlan: {
            sessionsPerWeek: 4,
            durationInMonths: 3,
            totalSessions: 16,
          },
        },
      },
    );

    const r = calculateSessionProgress([group]);

    expect(r.totalSessions).toBe(12);
    expect(r.completedSessions).toBe(4);
    expect(r.remainingSessions).toBe(8);
  });
});

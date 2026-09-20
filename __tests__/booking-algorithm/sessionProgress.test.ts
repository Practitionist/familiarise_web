/**
 * Tests for calculateSessionProgress — consultant session count / progress.
 *
 * #1554 — a subscription is ONE Appointment whose live occurrence rows are its
 * sessions, so the count is over rows, and a wrapper with no rows yet (the
 * checkout placeholder before allocation) contributes zero sessions.
 */

import { calculateSessionProgress } from "@/app/dashboard/consultant/[consultantId]/utils/appointmentHelpers";

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

function wrapper(occurrences: ReturnType<typeof occurrence>[]) {
  return { id: "apt-1", occurrences } as any;
}

describe("calculateSessionProgress", () => {
  const ref = new Date("2025-06-01T00:00:00Z");

  it("counts the wrapper's occurrence rows, not the wrapper", () => {
    const r = calculateSessionProgress(
      [
        wrapper([
          occurrence("2025-07-01T10:00:00Z"),
          occurrence("2025-07-08T10:00:00Z"),
          occurrence("2025-07-15T10:00:00Z"),
        ]),
      ],
      ref,
    );

    expect(r.totalSessions).toBe(3);
    expect(r.remainingSessions).toBe(3);
    expect(r.completedSessions).toBe(0);
  });

  it("splits completed (over) vs remaining, ignoring dead rows", () => {
    const r = calculateSessionProgress(
      [
        wrapper([
          occurrence("2025-05-01T10:00:00Z"), // past → completed
          occurrence("2025-05-15T10:00:00Z"), // past → completed
          occurrence("2025-07-01T10:00:00Z"), // future → remaining
          occurrence("2025-07-02T10:00:00Z", "RESCHEDULED"), // dead → ignored
        ]),
      ],
      ref,
    );

    expect(r.totalSessions).toBe(3);
    expect(r.completedSessions).toBe(2);
    expect(r.remainingSessions).toBe(1);
    expect(r.progressPercentage).toBeCloseTo((2 / 3) * 100);
  });

  it("an unallocated wrapper yields zero sessions", () => {
    const r = calculateSessionProgress([wrapper([])], ref);
    expect(r.totalSessions).toBe(0);
    expect(r.remainingSessions).toBe(0);
    expect(r.progressPercentage).toBe(0);
  });
});

// #1766 — with the wrapper's subscription present, the total is the frozen
// entitlement and "completed" the delivered rows, not the allocated-so-far
// count: a 12-plan with cycle one done reads 4 of 12, never 4 of 4.
describe("calculateSessionProgress with the subscription's entitlement", () => {
  const ref = new Date("2025-06-01T00:00:00Z");

  it("reads total from sessionsTotal and completed from delivered rows", () => {
    const group = wrapper([
      occurrence("2025-05-01T10:00:00Z", "COMPLETED"),
      occurrence("2025-05-02T10:00:00Z", "COMPLETED"),
      occurrence("2025-05-03T10:00:00Z", "UNVERIFIED"),
      occurrence("2025-05-04T10:00:00Z", "COMPLETED"),
      occurrence("2025-07-01T10:00:00Z"),
    ]);
    group.subscription = {
      sessionsTotal: 12,
      schedulingPeriodStartsAt: new Date("2025-05-01T00:00:00Z"),
      schedulingTimezone: "UTC",
      subscriptionPlan: {
        sessionsPerWeek: 4,
        durationInMonths: 3,
        totalSessions: 16,
      },
    };

    const r = calculateSessionProgress([group], ref);

    expect(r.totalSessions).toBe(12);
    expect(r.completedSessions).toBe(4);
    expect(r.remainingSessions).toBe(8);
  });
});

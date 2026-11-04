/**
 * Frozen purchase terms and weeks plans: what a purchase stamps, what a sold
 * plan reads, and how a support refund shrinks the schedulable total.
 */
import { formatInTimeZone } from "date-fns-tz";
import {
  activeClientsNotice,
  monthsForWeeks,
  planEndOf,
  planLengthLabel,
  purchaseTermsOf,
  soldSessionMinutes,
  soldSessionsPerWeek,
  soldTermsOf,
  subscriptionEntitlement,
  subscriptionPlanTotals,
  weeksPlanEndOf,
} from "../../lib/booking/entitlement";

const NEW_YORK = "America/New_York";

describe("purchaseTermsOf", () => {
  it("sells weeks × sessions a week on a weeks plan", () => {
    const terms = purchaseTermsOf(
      {
        sessionsPerWeek: 3,
        sessionDurationInHours: 1.5,
        durationInMonths: 6,
        durationInWeeks: 26,
      },
      new Date("2026-01-05T12:30:00.000Z"),
      "Asia/Kolkata",
    );
    expect(terms.sessionsTotal).toBe(78);
    expect(terms.sessionsPerWeek).toBe(3);
    expect(terms.sessionMinutes).toBe(90);
    expect(terms.planEndsAt.toISOString()).toBe("2026-07-06T12:30:00.000Z");
  });

  it("keeps months × 4 and the months end on a months plan", () => {
    const start = new Date("2026-01-31T04:30:00.000Z");
    const terms = purchaseTermsOf(
      {
        sessionsPerWeek: 2,
        sessionDurationInHours: 1,
        durationInMonths: 3,
        durationInWeeks: null,
      },
      start,
      "Asia/Kolkata",
    );
    expect(terms.sessionsTotal).toBe(24);
    expect(terms.planEndsAt).toEqual(planEndOf(start, 3, "Asia/Kolkata"));
  });
});

describe("weeksPlanEndOf", () => {
  it("keeps the local start time across a DST change", () => {
    // 18:00 EST on 2 Mar; DST starts 8 Mar, so 4 weeks later is 18:00 EDT.
    const start = new Date("2026-03-02T23:00:00.000Z");
    const end = weeksPlanEndOf(start, 4, NEW_YORK);
    expect(formatInTimeZone(end, NEW_YORK, "yyyy-MM-dd HH:mm")).toBe(
      "2026-03-30 18:00",
    );
    expect(end.toISOString()).toBe("2026-03-30T22:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(28 * 86_400_000 - 3_600_000);
  });

  it("moves a start inside a spring-forward gap past the gap", () => {
    // 01:30 local on 1 Mar lands on 29 Mar 01:30, which Europe/London skips.
    const start = new Date("2026-03-01T01:30:00.000Z");
    const end = weeksPlanEndOf(start, 4, "Europe/London");
    expect(end.getTime()).toBeGreaterThanOrEqual(
      start.getTime() + 28 * 86_400_000 - 3_600_000,
    );
    expect(formatInTimeZone(end, "Europe/London", "yyyy-MM-dd")).toBe(
      "2026-03-29",
    );
  });
});

describe("plan length copy", () => {
  it("derives the months label from weeks", () => {
    expect([4, 8, 12, 26, 52].map(monthsForWeeks)).toEqual([1, 2, 3, 6, 12]);
    expect(monthsForWeeks(1)).toBe(1);
  });

  it("says weeks and sessions for a weeks plan, months for a months plan", () => {
    expect(
      planLengthLabel({
        durationInWeeks: 26,
        durationInMonths: 6,
        sessionsPerWeek: 3,
      }),
    ).toBe("26 weeks · 78 sessions");
    expect(
      planLengthLabel({
        durationInWeeks: null,
        durationInMonths: 1,
        sessionsPerWeek: 1,
      }),
    ).toBe("1 month · 4 sessions");
  });

  it("stores weeks × sessions a week and the derived months", () => {
    expect(
      subscriptionPlanTotals({
        durationInWeeks: 26,
        durationInMonths: 1,
        sessionsPerWeek: 3,
        sessionDurationInHours: 1.5,
      }),
    ).toEqual({ durationInMonths: 6, totalSessions: 78, totalHours: 117 });
    expect(
      subscriptionPlanTotals({
        durationInWeeks: null,
        durationInMonths: 6,
        sessionsPerWeek: 3,
        sessionDurationInHours: 1,
      }),
    ).toEqual({ durationInMonths: 6, totalSessions: 72, totalHours: 72 });
  });

  it("tells the author how many live buyers keep their terms", () => {
    expect(activeClientsNotice(0)).toBeNull();
    expect(activeClientsNotice(1)).toBe(
      "1 active client keeps their current terms. Changes apply to new buyers only.",
    );
    expect(activeClientsNotice(3)).toMatch(/^3 active clients keep /);
  });
});

describe("sold terms", () => {
  const plan = {
    totalSessions: 40,
    sessionsPerWeek: 5,
    sessionDurationInHours: 2,
    durationInMonths: 2,
  };

  it("read the frozen columns over an edited plan", () => {
    const sub = {
      sessionsTotal: 24,
      sessionsPerWeek: 3,
      sessionMinutes: 60,
      sessionsRefunded: 0,
      subscriptionPlan: plan,
    };
    expect(soldSessionsPerWeek(sub)).toBe(3);
    expect(soldSessionMinutes(sub)).toBe(60);
    expect(soldTermsOf(sub)).toEqual({
      sessionsTotal: 24,
      sessionsRefunded: 0,
      sessionsPerWeek: 3,
      durationInMonths: 2,
    });
  });

  it("fall back to the plan on a row sold before the freeze", () => {
    const sub = {
      sessionsTotal: null,
      sessionsPerWeek: null,
      sessionMinutes: null,
      sessionsRefunded: 0,
      subscriptionPlan: plan,
    };
    expect(soldSessionsPerWeek(sub)).toBe(5);
    expect(soldSessionMinutes(sub)).toBe(120);
    expect(soldTermsOf(sub).sessionsTotal).toBe(40);
  });
});

describe("a support refund shrinks the schedulable total", () => {
  const base = {
    sessionsTotal: 12,
    sessionsPerWeek: 3,
    durationInMonths: 1,
    schedulingPeriodStartsAt: new Date("2026-03-02T00:00:00.000Z"),
    schedulingTimezone: "UTC",
    planEndsAt: new Date("2026-03-30T00:00:00.000Z"),
    now: new Date("2026-03-23T09:00:00.000Z"),
  };
  const held = (day: number) => ({
    startsAt: new Date(Date.UTC(2026, 2, day, 10)),
    endsAt: new Date(Date.UTC(2026, 2, day, 11)),
    completionStatus: "COMPLETED",
  });

  it("caps the last week's batch at what is still schedulable", () => {
    const occurrences = [2, 3, 4, 9, 10, 11, 16].map(held);
    const before = subscriptionEntitlement({
      ...base,
      sessionsRefunded: 0,
      occurrences,
    });
    expect(before.remaining).toBe(5);
    expect(before.cycle.nextBatch).toBe(3);
    const after = subscriptionEntitlement({
      ...base,
      sessionsRefunded: 4,
      occurrences,
    });
    expect(after.total).toBe(8);
    expect(after.remaining).toBe(1);
    expect(after.cycle.nextBatch).toBe(1);
  });
});

/**
 * #1766 — subscription entitlement is ONE counter with fill-order cycles.
 *
 * The five scenarios the owner locked, pinned as a table over a 12-session
 * plan at 4 a week: fresh, a placed cycle (no pre-scheduling of the next),
 * a completed cycle, a top-up and a human correction after completion.
 */
import {
  firstCycleWindow,
  sessionsTotalOf,
  subscriptionEntitlement,
} from "@/lib/booking/entitlement";

const NOW = new Date("2026-03-02T09:00:00.000Z");
const TZ = "Asia/Kolkata";
const HOUR = 60 * 60 * 1000;

/** One occurrence per session, an hour long, a day apart from `NOW`. */
function row(index: number, completionStatus: string, isTentative = false) {
  const startsAt = new Date(NOW.getTime() + index * 24 * HOUR);
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    completionStatus,
    isTentative,
    deletedAt: null,
  };
}

function rows(spec: Record<string, number>) {
  let i = 0;
  return Object.entries(spec).flatMap(([status, n]) =>
    Array.from({ length: n }, () => row(i++, status)),
  );
}

function plan12(occurrences: ReturnType<typeof rows>) {
  return subscriptionEntitlement({
    sessionsTotal: 12,
    sessionsPerWeek: 4,
    durationInMonths: 3,
    occurrences,
    schedulingPeriodStartsAt: NOW,
    schedulingTimezone: TZ,
    now: NOW,
  });
}

describe("sessionsTotalOf", () => {
  it("falls back to plan.totalSessions when sessionsTotal is null", () => {
    const plan = { totalSessions: 24 };
    expect(
      sessionsTotalOf({ sessionsTotal: null, subscriptionPlan: plan }),
    ).toBe(24);
    // A plan edit after purchase never moves a frozen row.
    expect(sessionsTotalOf({ sessionsTotal: 12, subscriptionPlan: plan })).toBe(
      12,
    );
  });
});

describe("subscriptionEntitlement — fill-order cycles on a 12-plan at 4/week", () => {
  it.each([
    ["fresh plan", {}, { nextBatch: 4, ordinal: 0, held: 0 }],
    [
      "4 placed, none held yet",
      { SCHEDULED: 4 },
      { nextBatch: 0, ordinal: 0, held: 4 },
    ],
    [
      "4 complete opens cycle 2",
      { COMPLETED: 4 },
      { nextBatch: 4, ordinal: 1, held: 4 },
    ],
    [
      "2 of 4 placed tops up",
      { SCHEDULED: 2 },
      { nextBatch: 2, ordinal: 0, held: 2 },
    ],
    [
      "1 of 3 completed later cancelled",
      { COMPLETED: 2, CANCELLED: 1, SCHEDULED: 1 },
      { nextBatch: 1, ordinal: 0, held: 3 },
    ],
  ])("%s", (_name, spec, expected) => {
    const e = plan12(rows(spec));
    expect(e.total).toBe(12);
    expect(e.held).toBe(expected.held);
    expect(e.cycle.ordinal).toBe(expected.ordinal);
    expect(e.cycle.nextBatch).toBe(expected.nextBatch);
    expect(e.cycle.count).toBe(3);
  });

  it("counts UNVERIFIED as completed and a tentative hold as nothing", () => {
    const e = plan12([...rows({ UNVERIFIED: 4 }), row(9, "SCHEDULED", true)]);
    expect(e.completed).toBe(4);
    expect(e.scheduled).toBe(0);
    expect(e.cycle.nextBatch).toBe(4);
  });

  it("the last tranche is short and the plan ends at 0", () => {
    const short = subscriptionEntitlement({
      sessionsTotal: 10,
      sessionsPerWeek: 4,
      durationInMonths: 3,
      occurrences: rows({ COMPLETED: 8 }),
      schedulingPeriodStartsAt: NOW,
      schedulingTimezone: TZ,
      now: NOW,
    });
    expect(short.cycle.count).toBe(3);
    expect(short.cycle.nextBatch).toBe(2);
  });

  it("the window starts after the last held session and spans seven zone-days", () => {
    const e = plan12(rows({ COMPLETED: 4 }));
    const lastEnd = new Date(NOW.getTime() + 3 * 24 * HOUR + HOUR);
    expect(e.cycle.windowStart).toEqual(lastEnd);
    // IST day of lastEnd is 05 Mar; the seventh day ends 11 Mar 23:59:59.999 IST.
    expect(e.cycle.windowEnd.toISOString()).toBe("2026-03-11T18:29:59.999Z");
  });
});

describe("firstCycleWindow", () => {
  it("is one cycle from the start, in the scheduling zone", () => {
    const { start, end } = firstCycleWindow(
      { sessionsPerWeek: 2, durationInMonths: 3 },
      NOW,
      TZ,
    );
    expect(start).toBe(NOW);
    expect(end.toISOString()).toBe("2026-03-08T18:29:59.999Z");
  });
});

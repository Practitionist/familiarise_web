/**
 * Subscription entitlement is ONE counter over fixed plan weeks: week k is
 * [plan start's zone-day + 7k, + 7). This week fills first, next week opens
 * as soon as this one is full (never later than its own start, never a third
 * week), and nothing waits for delivery.
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
    sessionsRefunded: 0,
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

// NOW is Mon 2 Mar 2026, 14:30 IST: plan week 0 is 2–8 Mar, week 1 is 9–15 Mar.
const WEEK1_START = "2026-03-08T18:30:00.000Z";
const WEEK2_START = "2026-03-15T18:30:00.000Z";

describe("subscriptionEntitlement — fixed plan weeks on a 12-plan at 4/week", () => {
  it.each([
    ["fresh plan", {}, { nextBatch: 4, ordinal: 0, held: 0 }],
    // A full week opens the next one at once: delivery is not awaited.
    [
      "4 placed this week opens next week",
      { SCHEDULED: 4 },
      { nextBatch: 4, ordinal: 1, held: 4 },
    ],
    [
      "4 complete this week opens next week",
      { COMPLETED: 4 },
      { nextBatch: 4, ordinal: 1, held: 4 },
    ],
    [
      "2 of 4 placed tops up this week",
      { SCHEDULED: 2 },
      { nextBatch: 2, ordinal: 0, held: 2 },
    ],
    [
      "a cancelled session frees its place in the week",
      { COMPLETED: 2, CANCELLED: 1, SCHEDULED: 1 },
      { nextBatch: 1, ordinal: 0, held: 3 },
    ],
  ])("%s", (_name, spec, expected) => {
    const e = plan12(rows(spec));
    expect(e.total).toBe(12);
    expect(e.held).toBe(expected.held);
    expect(e.cycle.ordinal).toBe(expected.ordinal);
    expect(e.cycle.nextBatch).toBe(expected.nextBatch);
    // 2 Mar – 2 Jun is 14 calendar weeks.
    expect(e.cycle.count).toBe(14);
  });

  it("counts UNVERIFIED as completed and a tentative hold as nothing", () => {
    const e = plan12([...rows({ UNVERIFIED: 4 }), row(9, "SCHEDULED", true)]);
    expect(e.completed).toBe(4);
    expect(e.scheduled).toBe(0);
    expect(e.cycle.nextBatch).toBe(4);
  });

  it("a full next week opens on the next week's own start, never earlier", () => {
    const e = plan12(rows({ COMPLETED: 4 }));
    expect(e.cycle.windowStart.toISOString()).toBe(WEEK1_START);
    expect(e.cycle.windowEnd.toISOString()).toBe(WEEK2_START);
  });

  it("never packs a third week in: both open weeks full means nothing to place", () => {
    const e = plan12([
      ...[0, 1, 2, 3].map((d) => row(d, "SCHEDULED")),
      ...[7, 8, 9, 10].map((d) => row(d, "SCHEDULED")),
    ]);
    expect(e.cycle.nextBatch).toBe(0);
    expect(e.cycle.ordinal).toBe(1);
  });

  it("the last sessions are bounded by what remains", () => {
    const short = subscriptionEntitlement({
      sessionsTotal: 10,
      sessionsRefunded: 0,
      sessionsPerWeek: 4,
      durationInMonths: 3,
      occurrences: [
        ...[0, 1, 2, 3].map((d) => row(d, "COMPLETED")),
        ...[7, 8, 9, 10].map((d) => row(d, "COMPLETED")),
      ],
      schedulingPeriodStartsAt: NOW,
      schedulingTimezone: TZ,
      now: new Date(NOW.getTime() + 14 * 24 * HOUR),
    });
    expect(short.cycle.ordinal).toBe(2);
    expect(short.cycle.nextBatch).toBe(2);
  });
});

describe("pacing: a 3-a-week plan never runs ahead of its calendar weeks", () => {
  it("week 1 delivered Mon–Wed does not place week 2 before next Monday", () => {
    const thursday = new Date(NOW.getTime() + 3 * 24 * HOUR);
    const e = subscriptionEntitlement({
      sessionsTotal: 72,
      sessionsRefunded: 0,
      sessionsPerWeek: 3,
      durationInMonths: 6,
      occurrences: [0, 1, 2].map((d) => row(d, "COMPLETED")),
      schedulingPeriodStartsAt: NOW,
      schedulingTimezone: TZ,
      now: thursday,
    });
    expect(e.cycle.ordinal).toBe(1);
    expect(e.cycle.nextBatch).toBe(3);
    expect(e.cycle.windowStart.toISOString()).toBe(WEEK1_START);
    expect(e.cycle.windowEnd.toISOString()).toBe(WEEK2_START);
  });

  it("an idle week stays this week's to fill, whatever was delivered before", () => {
    const e = subscriptionEntitlement({
      sessionsTotal: 72,
      sessionsRefunded: 0,
      sessionsPerWeek: 3,
      durationInMonths: 6,
      occurrences: [0, 1, 2].map((d) => row(d, "COMPLETED")),
      schedulingPeriodStartsAt: NOW,
      schedulingTimezone: TZ,
      now: new Date(NOW.getTime() + 15 * 24 * HOUR),
    });
    expect(e.cycle.ordinal).toBe(2);
    expect(e.cycle.nextBatch).toBe(3);
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
    expect(end.toISOString()).toBe("2026-03-08T18:30:00.000Z");
  });
});

describe("subscriptionEntitlement — rescheduling inside a plan week", () => {
  it("counts tentative RESCHEDULED rows in rescheduling and keeps the released session's week open from now", () => {
    const e = plan12([
      row(0, "RESCHEDULED", true),
      row(2, "SCHEDULED", false),
      row(3, "SCHEDULED", false),
      row(4, "SCHEDULED", false),
    ]);
    expect(e.rescheduling).toBe(1);
    expect(e.scheduled).toBe(3);
    expect(e.completed).toBe(0);
    expect(e.held).toBe(3);
    expect(e.cycle.nextBatch).toBe(1);
    // The released session's week still has its place, open from now.
    expect(e.cycle.windowStart).toEqual(NOW);
  });
});

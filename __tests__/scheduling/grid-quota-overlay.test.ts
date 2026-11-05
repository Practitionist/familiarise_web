/**
 * @jest-environment node
 */

/**
 * The subscription quota painted over the availability grid: a full cycle
 * paints every in-window cell "Limit reached", a full day paints only that
 * day, an open reschedule batch reopens the cycle, and day keys follow the
 * scheduling zone across DST.
 */

import {
  subscriptionEntitlement,
  type EntitlementOccurrence,
} from "@/lib/booking/entitlement";
import {
  cellLimitReached,
  computeGridQuota,
  gridQuotaSchema,
  quotaFooterText,
  type GridQuota,
} from "@/lib/scheduling/grid-quota";
import { formatDayLabel } from "@/lib/time/display";

const HALF_HOUR = 30 * 60 * 1000;
/** The fixtures' "now": inside the plan. */
const FIXTURE_NOW = Date.parse("2026-03-02T06:00:00.000Z");
const IST = "Asia/Kolkata";

const session = (
  startsAt: string,
  extra: Partial<EntitlementOccurrence> = {},
): EntitlementOccurrence => ({
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 2 * HALF_HOUR).toISOString(),
  completionStatus: "SCHEDULED",
  isTentative: false,
  deletedAt: null,
  ...extra,
});

function quotaFor(
  occurrences: EntitlementOccurrence[],
  opts: {
    zone?: string;
    now?: string;
    periodStart?: string;
    planEndsAt?: string;
  } = {},
): GridQuota {
  const zone = opts.zone ?? IST;
  const entitlement = subscriptionEntitlement({
    sessionsTotal: 12,
    sessionsRefunded: 0,
    sessionsPerWeek: 3,
    durationInMonths: 1,
    occurrences,
    schedulingPeriodStartsAt: opts.periodStart ?? "2026-03-01T18:30:00.000Z",
    schedulingTimezone: zone,
    planEndsAt: opts.planEndsAt ?? null,
    now: new Date(opts.now ?? "2026-03-02T06:00:00.000Z"),
  });
  return computeGridQuota({
    entitlement,
    occurrences,
    schedulingTimezone: zone,
  });
}

/** Every half-hour cell start in [fromIso, toIso). */
function cellsBetween(fromIso: string, toIso: string): number[] {
  const out: number[] = [];
  for (let t = Date.parse(fromIso); t < Date.parse(toIso); t += HALF_HOUR) {
    out.push(t);
  }
  return out;
}

describe("computeGridQuota + cellLimitReached", () => {
  it("paints every in-window cell when the cycle is full", () => {
    // This week (2–8 Mar) and next week (9–15 Mar) both full.
    const quota = quotaFor([
      session("2026-03-03T04:30:00.000Z"),
      session("2026-03-04T04:30:00.000Z"),
      session("2026-03-05T04:30:00.000Z"),
      session("2026-03-10T04:30:00.000Z"),
      session("2026-03-11T04:30:00.000Z"),
      session("2026-03-12T04:30:00.000Z"),
    ]);
    expect(quota).toMatchObject({
      unit: "week",
      capacity: 3,
      filled: 3,
      remainingThisCycle: 0,
      allBooked: false,
      perDayCap: 1,
      schedulingTimezone: IST,
    });
    const windowStart = Date.parse(quota.windowStart);
    const windowEnd = Date.parse(quota.windowEnd);
    const inWindow = cellsBetween(quota.windowStart, quota.windowEnd).filter(
      (t) => t >= windowStart && t + HALF_HOUR <= windowEnd + 1,
    );
    expect(inWindow.length).toBeGreaterThan(48);
    for (const t of inWindow) {
      expect(cellLimitReached(quota, t, t + HALF_HOUR)).toBe(true);
    }
    // After the window the next cycle is open again.
    const afterWindow = windowEnd + 1 + 2 * HALF_HOUR;
    expect(cellLimitReached(quota, afterWindow, afterWindow + HALF_HOUR)).toBe(
      false,
    );
  });

  it("paints every cell, later cycles included, once the whole plan is held", () => {
    const quota: GridQuota = {
      ...quotaFor([session("2026-03-04T04:30:00.000Z")]),
      allBooked: true,
    };
    const later = Date.parse(quota.windowEnd) + 30 * 24 * 60 * 60 * 1000;
    expect(cellLimitReached(quota, later, later + HALF_HOUR)).toBe(true);
  });

  it("paints only the full day when the cycle still has room", () => {
    const quota = quotaFor([session("2026-03-04T04:30:00.000Z")]);
    expect(quota.remainingThisCycle).toBe(2);
    expect(quota.fullDays).toEqual(["2026-03-04"]);
    // 4 Mar IST runs 3 Mar 18:30Z – 4 Mar 18:30Z.
    for (const t of cellsBetween(
      "2026-03-03T18:30:00.000Z",
      "2026-03-04T18:30:00.000Z",
    )) {
      expect(cellLimitReached(quota, t, t + HALF_HOUR)).toBe(true);
    }
    for (const t of [
      ...cellsBetween("2026-03-03T12:00:00.000Z", "2026-03-03T18:30:00.000Z"),
      ...cellsBetween("2026-03-04T18:30:00.000Z", "2026-03-05T06:00:00.000Z"),
    ]) {
      expect(cellLimitReached(quota, t, t + HALF_HOUR)).toBe(false);
    }
  });

  it("does not hold a day for tombstoned, cancelled, released or tentative rows", () => {
    const quota = quotaFor([
      session("2026-03-03T04:30:00.000Z", {
        deletedAt: "2026-03-01T00:00:00Z",
      }),
      session("2026-03-04T04:30:00.000Z", { completionStatus: "CANCELLED" }),
      session("2026-03-05T04:30:00.000Z", {
        completionStatus: "RESCHEDULED",
        isTentative: true,
      }),
      session("2026-03-06T04:30:00.000Z", { isTentative: true }),
    ]);
    expect(quota.fullDays).toEqual([]);
  });

  it("reopens the cycle for the reschedule batch", () => {
    const quota = quotaFor([
      session("2026-03-03T04:30:00.000Z"),
      session("2026-03-04T04:30:00.000Z"),
      session("2026-03-05T04:30:00.000Z", {
        completionStatus: "RESCHEDULED",
        isTentative: true,
      }),
    ]);
    expect(quota.remainingThisCycle).toBe(1);
    // The released session's day is free; the two held days stay full.
    expect(quota.fullDays).toEqual(["2026-03-03", "2026-03-04"]);
    const freeCell = Date.parse("2026-03-05T04:30:00.000Z");
    expect(cellLimitReached(quota, freeCell, freeCell + HALF_HOUR)).toBe(false);
  });

  it("keys days in the scheduling zone across a DST night", () => {
    const NY = "America/New_York";
    // 00:30 EST and 23:30 EDT are both 8 Mar in New York (spring forward).
    const quota = quotaFor(
      [
        session("2026-03-08T05:30:00.000Z"),
        session("2026-03-09T03:00:00.000Z"),
      ],
      {
        zone: NY,
        now: "2026-03-07T12:00:00.000Z",
        periodStart: "2026-03-07T05:00:00.000Z",
      },
    );
    expect(quota.fullDays).toEqual(["2026-03-08"]);
    expect(quota.remainingThisCycle).toBe(1);
    const lateOnThe8th = Date.parse("2026-03-09T03:30:00.000Z"); // 23:30 EDT
    const midnight9th = Date.parse("2026-03-09T04:00:00.000Z"); // 00:00 EDT
    const lastEstHour = Date.parse("2026-03-08T04:30:00.000Z"); // 23:30 EST 7 Mar
    expect(
      cellLimitReached(quota, lateOnThe8th, lateOnThe8th + HALF_HOUR),
    ).toBe(true);
    expect(cellLimitReached(quota, midnight9th, midnight9th + HALF_HOUR)).toBe(
      false,
    );
    expect(cellLimitReached(quota, lastEstHour, lastEstHour + HALF_HOUR)).toBe(
      false,
    );
  });

  it("round-trips through the client schema", () => {
    const quota = quotaFor([session("2026-03-04T04:30:00.000Z")]);
    expect(gridQuotaSchema.parse(JSON.parse(JSON.stringify(quota)))).toEqual(
      quota,
    );
    expect(() =>
      gridQuotaSchema.parse({ ...quota, fullDays: ["4 Mar"] }),
    ).toThrow();
  });
});

describe("quotaFooterText", () => {
  it("names the held count and the next opening when the cycle is full", () => {
    // This week (2–8 Mar) and next week (9–15 Mar) both full.
    const quota = quotaFor([
      session("2026-03-03T04:30:00.000Z"),
      session("2026-03-04T04:30:00.000Z"),
      session("2026-03-05T04:30:00.000Z"),
      session("2026-03-10T04:30:00.000Z"),
      session("2026-03-11T04:30:00.000Z"),
      session("2026-03-12T04:30:00.000Z"),
    ]);
    const nextOpens = formatDayLabel(
      new Date(Date.parse(quota.windowEnd) + 1),
      {
        zone: IST,
      },
    );
    expect(quotaFooterText(quota, IST, FIXTURE_NOW)).toBe(
      `Week 2 of 5 is set · next opens ${nextOpens}`,
    );
    expect(quotaFooterText(quota, IST, FIXTURE_NOW)).not.toMatch(
      /slot|T\d\d:|Z\b/,
    );
  });

  it("shows only the count while there is room", () => {
    const quota = quotaFor([session("2026-03-04T04:30:00.000Z")]);
    expect(quotaFooterText(quota, IST, FIXTURE_NOW)).toBe(
      "Week 1 of 5 · 1 of 3 booked",
    );
  });

  it("names no next opening once every session is booked", () => {
    const quota: GridQuota = {
      ...quotaFor([session("2026-03-04T04:30:00.000Z")]),
      filled: 3,
      remainingThisCycle: 0,
      allBooked: true,
    };
    expect(quotaFooterText(quota, IST, FIXTURE_NOW)).toBe(
      "Week 1 of 5 · 3 of 3 booked",
    );
  });
});

describe("the fixed plan end", () => {
  // Plan ends at midnight IST starting 21 Mar (exclusive).
  const PLAN_END = "2026-03-20T18:30:00.000Z";
  const at = (iso: string) => Date.parse(iso);

  it("paints every cell at or after the plan end, and a session may end exactly on it", () => {
    const quota = quotaFor([], {
      planEndsAt: PLAN_END,
      now: "2026-03-18T06:00:00.000Z",
    });
    expect(quota.planEndsAt).toBe(new Date(PLAN_END).toISOString());
    const lastHalfHour = at(PLAN_END) - HALF_HOUR;
    expect(cellLimitReached(quota, lastHalfHour, at(PLAN_END))).toBe(false);
    expect(
      cellLimitReached(quota, at(PLAN_END), at(PLAN_END) + HALF_HOUR),
    ).toBe(true);
    const later = at("2026-03-23T04:30:00.000Z");
    expect(cellLimitReached(quota, later, later + HALF_HOUR)).toBe(true);
  });

  it("an incident extension moves the end, so those days open again", () => {
    const extended = new Date(
      at(PLAN_END) + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const quota = quotaFor([], {
      planEndsAt: extended,
      now: "2026-03-18T06:00:00.000Z",
    });
    const after = at("2026-03-23T04:30:00.000Z");
    expect(cellLimitReached(quota, after, after + HALF_HOUR)).toBe(false);
  });

  it("says when the plan ended, naming the last day it covered", () => {
    const quota = quotaFor([], {
      planEndsAt: PLAN_END,
      now: "2026-03-18T06:00:00.000Z",
    });
    const lastDay = formatDayLabel(new Date(at(PLAN_END) - 1), { zone: IST });
    expect(quotaFooterText(quota, IST, at("2026-03-22T00:00:00.000Z"))).toBe(
      `Plan ended on ${lastDay}`,
    );
    expect(gridQuotaSchema.safeParse(quota).success).toBe(true);
  });
});

/**
 * @jest-environment node
 */

/**
 * The fixed plan end: start + durationInMonths on the consultant's wall
 * clock, month-end clamped and exclusive; the entitlement's cycle window
 * never reaches past it, and a renewal starts no earlier than it.
 */
import {
  planEndOf,
  subscriptionEntitlement,
  subscriptionIsOver,
  subscriptionPlanEnd,
} from "@/lib/booking/entitlement";
import { resolvePlanStart } from "@/lib/payments/checkout/renewal";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";

const KOLKATA = "Asia/Kolkata";
const NEW_YORK = "America/New_York";
const KATHMANDU = "Asia/Kathmandu";

describe("planEndOf", () => {
  it("adds calendar months on the consultant's wall clock", () => {
    // 10:00 IST on 15 Mar → 10:00 IST on 15 Jun.
    expect(
      planEndOf(new Date("2026-03-15T04:30:00Z"), 3, KOLKATA).toISOString(),
    ).toBe("2026-06-15T04:30:00.000Z");
  });

  it("clamps a month-end start to the shorter month (Jan 31 + 1 → Feb 28)", () => {
    expect(
      planEndOf(new Date("2027-01-31T04:30:00Z"), 1, KOLKATA).toISOString(),
    ).toBe("2027-02-28T04:30:00.000Z");
  });

  it("clamps to Feb 29 in a leap year", () => {
    expect(
      planEndOf(new Date("2028-01-31T04:30:00Z"), 1, KOLKATA).toISOString(),
    ).toBe("2028-02-29T04:30:00.000Z");
  });

  it("rolls over the year", () => {
    expect(
      planEndOf(new Date("2026-11-30T04:30:00Z"), 3, KOLKATA).toISOString(),
    ).toBe("2027-02-28T04:30:00.000Z");
  });

  it("keeps the local time across a DST change (New York, EST → EDT)", () => {
    // 09:00 EST (14:00Z) on 1 Mar → 09:00 EDT (13:00Z) on 1 Apr.
    expect(
      planEndOf(new Date("2026-03-01T14:00:00Z"), 1, NEW_YORK).toISOString(),
    ).toBe("2026-04-01T13:00:00.000Z");
  });

  it("moves an end inside a spring-forward gap past the gap, never earlier", () => {
    // 02:30 EST on 8 Feb + 1 month = 02:30 on 8 Mar, which New York skips;
    // the end lands at 03:30 EDT.
    expect(
      planEndOf(new Date("2026-02-08T07:30:00Z"), 1, NEW_YORK).toISOString(),
    ).toBe("2026-03-08T07:30:00.000Z");
  });

  it("reads the calendar day in the consultant's zone, not UTC", () => {
    // 23:00Z on 31 Jan is already 1 Feb 04:45 in Kathmandu (+05:45).
    expect(
      planEndOf(new Date("2027-01-31T23:00:00Z"), 1, KATHMANDU).toISOString(),
    ).toBe("2027-02-28T23:00:00.000Z");
  });
});

describe("subscriptionPlanEnd / subscriptionIsOver", () => {
  const base = {
    schedulingPeriodStartsAt: new Date("2026-03-15T04:30:00Z"),
    schedulingTimezone: KOLKATA,
    subscriptionPlan: { durationInMonths: 2 },
  };

  it("reads the stored end when present", () => {
    const stored = new Date("2026-06-01T00:00:00Z");
    expect(subscriptionPlanEnd({ ...base, planEndsAt: stored })).toEqual(
      stored,
    );
  });

  it("derives the end from the start when none is stored", () => {
    expect(
      subscriptionPlanEnd({ ...base, planEndsAt: null }).toISOString(),
    ).toBe("2026-05-15T04:30:00.000Z");
  });

  it("is over exactly at the (exclusive) end", () => {
    const sub = { ...base, planEndsAt: null };
    expect(subscriptionIsOver(sub, new Date("2026-05-15T04:29:59Z"))).toBe(
      false,
    );
    expect(subscriptionIsOver(sub, new Date("2026-05-15T04:30:00Z"))).toBe(
      true,
    );
  });
});

describe("the cycle window stops at the plan end", () => {
  const plan = {
    sessionsPerWeek: 2,
    durationInMonths: 1,
    sessionsTotal: 8,
    sessionsRefunded: 0,
  };

  it("clamps the last cycle to the plan end", () => {
    const planEndsAt = new Date("2026-04-03T06:00:00Z");
    const e = subscriptionEntitlement({
      ...plan,
      occurrences: [],
      schedulingPeriodStartsAt: new Date("2026-03-03T06:00:00Z"),
      schedulingTimezone: KOLKATA,
      planEndsAt,
      now: new Date("2026-04-01T06:00:00Z"),
    });
    expect(e.cycle.windowEnd).toEqual(planEndsAt);
    expect(e.cycle.nextBatch).toBe(2);
    expect(e.planEndsAt).toEqual(planEndsAt);
  });

  it("offers nothing once the plan has ended, though sessions remain", () => {
    const e = subscriptionEntitlement({
      ...plan,
      occurrences: [],
      schedulingPeriodStartsAt: new Date("2026-03-03T06:00:00Z"),
      schedulingTimezone: KOLKATA,
      planEndsAt: new Date("2026-04-03T06:00:00Z"),
      now: new Date("2026-04-05T06:00:00Z"),
    });
    expect(e.remaining).toBe(8);
    expect(e.cycle.nextBatch).toBe(0);
    expect(e.cycle.windowEnd <= e.cycle.windowStart).toBe(true);
  });
});

describe("resolvePlanStart", () => {
  const now = new Date("2026-03-10T12:00:00Z");

  it("anchors a renewal on the prior plan's end", () => {
    const priorEnd = new Date("2026-04-02T06:00:00Z");
    expect(resolvePlanStart(now.toISOString(), priorEnd, now)).toEqual(
      priorEnd,
    );
  });

  it("never starts before now; today's midnight pick is accepted", () => {
    expect(
      resolvePlanStart("2026-03-10T00:00:00.000Z", null, now).toISOString(),
    ).toBe(now.toISOString());
  });

  it("keeps a future pick inside the horizon", () => {
    expect(
      resolvePlanStart("2026-04-01T00:00:00.000Z", null, now).toISOString(),
    ).toBe("2026-04-01T00:00:00.000Z");
  });

  it.each([
    ["more than a day in the past", "2026-03-08T00:00:00.000Z"],
    ["more than 90 days ahead", "2026-06-10T00:00:00.000Z"],
  ])("refuses a start %s with INVALID_PLAN_START", (_label, iso) => {
    let caught: unknown;
    try {
      resolvePlanStart(iso, null, now);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BookingRuleError);
    expect(caught).toMatchObject({
      code: "INVALID_PLAN_START",
      httpStatus: 400,
    });
  });
});

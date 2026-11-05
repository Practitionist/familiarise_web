/**
 * A live Regular time opens a 4-plan-week horizon with catch-up capacity;
 * plans without one keep "this week, or next once full". The grid quota and
 * the reschedule window read the same horizon.
 */
import {
  rescheduleWindow,
  soldTermsOf,
  subscriptionEntitlement,
} from "@/lib/booking/entitlement";
import {
  cellLimitReached,
  computeGridQuota,
  quotaFooterText,
} from "@/lib/scheduling/grid-quota";

const TZ = "Asia/Kolkata";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Plan starts Mon 2 Nov 2026 00:00 IST; now is Mon 2 Nov 09:00 IST.
const START = new Date("2026-11-01T18:30:00Z");
const NOW = new Date("2026-11-02T03:30:00Z");

/** A scheduled hour on plan week k, day d, at 12:00 IST. */
function session(k: number, d: number, id = `o-${k}-${d}`) {
  const startsAt = new Date(START.getTime() + (7 * k + d) * DAY + 12 * HOUR);
  return {
    id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    completionStatus: "SCHEDULED",
    isTentative: false,
    deletedAt: null,
  };
}

function entitlement(
  occurrences: ReturnType<typeof session>[],
  hasRegularTime: boolean,
  terms = { sessionsPerWeek: 3, sessionsTotal: 78 },
) {
  return subscriptionEntitlement({
    ...terms,
    sessionsRefunded: 0,
    durationInMonths: 6,
    occurrences,
    schedulingPeriodStartsAt: START,
    schedulingTimezone: TZ,
    planEndsAt: new Date(START.getTime() + 26 * 7 * DAY),
    hasRegularTime,
    now: NOW,
  });
}

const fullWeek = (k: number) => [0, 2, 4].map((d) => session(k, d));

describe("entitlement horizon", () => {
  it("T7: a Regular time opens weeks current..current+3; without one Phase 0 is unchanged", () => {
    const occ = [...fullWeek(0), ...fullWeek(1)];
    const rt = entitlement(occ, true);
    expect(rt.horizon.map((w) => [w.weekIndex, w.capacity, w.held])).toEqual([
      [0, 3, 3],
      [1, 3, 3],
      [2, 3, 0],
      [3, 3, 0],
    ]);
    expect(rt.cycle.ordinal).toBe(2);
    expect(rt.cycle.nextBatch).toBe(3);

    const phase0 = entitlement(occ, false);
    expect(phase0.cycle.ordinal).toBe(1);
    expect(phase0.cycle.nextBatch).toBe(0);
    expect(phase0.horizon.map((w) => w.weekIndex)).toEqual([1]);
    expect(phase0.horizon[0].endsAt).toEqual(phase0.cycle.windowEnd);
  });

  it("T8: the frozen sessionsPerWeek beats a later plan edit", () => {
    const terms = soldTermsOf({
      sessionsTotal: 52,
      sessionsPerWeek: 2,
      sessionsRefunded: 0,
      subscriptionPlan: {
        totalSessions: 78,
        sessionsPerWeek: 3,
        durationInMonths: 6,
      },
    });
    const ent = subscriptionEntitlement({
      ...terms,
      occurrences: [],
      schedulingPeriodStartsAt: START,
      schedulingTimezone: TZ,
      planEndsAt: new Date(START.getTime() + 26 * 7 * DAY),
      hasRegularTime: true,
      now: NOW,
    });
    expect(ent.horizon.map((w) => w.capacity)).toEqual([2, 2, 2, 2]);
  });

  it("catch-up: a missed week adds one to each open week until it is paid back", () => {
    const later = new Date(NOW.getTime() + 7 * DAY);
    const ent = subscriptionEntitlement({
      sessionsPerWeek: 3,
      sessionsTotal: 78,
      sessionsRefunded: 0,
      durationInMonths: 6,
      occurrences: [session(0, 0)],
      schedulingPeriodStartsAt: START,
      schedulingTimezone: TZ,
      planEndsAt: new Date(START.getTime() + 26 * 7 * DAY),
      hasRegularTime: true,
      now: later,
    });
    expect(ent.horizon.map((w) => w.capacity)).toEqual([4, 4, 4, 4]);
  });

  it("T21: the grid footer and horizon capacities match the entitlement", () => {
    const occ = fullWeek(0);
    const ent = entitlement(occ, true);
    const quota = computeGridQuota({
      entitlement: ent,
      occurrences: occ,
      schedulingTimezone: TZ,
    });
    expect(quota.weekNumber).toBe(2);
    expect(quotaFooterText(quota, TZ, NOW.getTime())).toBe(
      "Week 2 of 26 · 0 of 3 booked",
    );
    expect(
      quota.horizon.map((w) => [w.weekNumber, w.capacity, w.room]),
    ).toEqual([
      [1, 3, 0],
      [2, 3, 3],
      [3, 3, 3],
      [4, 3, 3],
    ]);
    // A cell in week 4 is open; a cell in the full week 1 is not.
    const week4 = session(3, 1).startsAt.getTime();
    expect(cellLimitReached(quota, week4, week4 + HOUR)).toBe(false);
    const week1 = session(0, 5).startsAt.getTime();
    expect(cellLimitReached(quota, week1, week1 + HOUR)).toBe(true);
  });

  it("T22: a release inside the horizon reopens one week, and the window is that week", () => {
    const occ = [...fullWeek(0), ...fullWeek(1), ...fullWeek(2)];
    const window = rescheduleWindow(
      {
        sessionsPerWeek: 3,
        sessionsTotal: 78,
        sessionsRefunded: 0,
        durationInMonths: 6,
        occurrences: occ,
        schedulingPeriodStartsAt: START,
        schedulingTimezone: TZ,
        planEndsAt: new Date(START.getTime() + 26 * 7 * DAY),
        hasRegularTime: true,
        now: NOW,
      },
      ["o-1-2"],
    );
    expect(window.start).toEqual(new Date(START.getTime() + 7 * DAY));
    expect(window.end).toEqual(new Date(START.getTime() + 14 * DAY));
  });
});

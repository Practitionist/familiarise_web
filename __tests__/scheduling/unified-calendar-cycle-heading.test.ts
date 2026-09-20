/**
 * #1766 — the allocate-page footer heading is one sentence over the one
 * entitlement counter: what this cycle still takes, the window it runs in,
 * and the plan-wide count. Pinned string-level on the extracted pure fn for
 * the four owner scenarios.
 */
import {
  subscriptionCycleHeading,
  subscriptionEntitlement,
} from "@/lib/booking/entitlement";

const NOW = new Date("2026-03-02T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function rows(spec: Record<string, number>) {
  let i = 0;
  return Object.entries(spec).flatMap(([completionStatus, n]) =>
    Array.from({ length: n }, () => {
      const startsAt = new Date(NOW.getTime() + i++ * 24 * HOUR);
      return {
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR),
        completionStatus,
        isTentative: false,
        deletedAt: null,
      };
    }),
  );
}

function heading(spec: Record<string, number>) {
  return subscriptionCycleHeading(
    subscriptionEntitlement({
      sessionsTotal: 12,
      sessionsPerWeek: 4,
      durationInMonths: 3,
      occurrences: rows(spec),
      schedulingPeriodStartsAt: NOW,
      schedulingTimezone: "UTC",
      now: NOW,
    }),
    { zone: "UTC", locale: "en-GB" },
  );
}

it.each([
  [
    "fresh plan",
    {},
    "Schedule the next 4 sessions · this cycle 2 Mar 2026 – 8 Mar 2026 · 0 of 12 scheduled",
  ],
  [
    "cycle placed",
    { SCHEDULED: 4 },
    "Schedule the next 0 sessions · this cycle 5 Mar 2026 – 11 Mar 2026 · 4 of 12 scheduled",
  ],
  [
    "cycle complete",
    { COMPLETED: 4 },
    "Schedule the next 4 sessions · this cycle 5 Mar 2026 – 11 Mar 2026 · 4 of 12 scheduled",
  ],
  [
    "top-up",
    { SCHEDULED: 2 },
    "Schedule the next 2 sessions · this cycle 3 Mar 2026 – 9 Mar 2026 · 2 of 12 scheduled",
  ],
])("%s", (_name, spec, expected) => {
  expect(heading(spec)).toBe(expected);
});

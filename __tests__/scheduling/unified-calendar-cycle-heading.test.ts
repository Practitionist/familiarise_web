/**
 * The allocate-page footer heading is one sentence over the one entitlement
 * counter: which plan week is open ("Week N of W"), what it still takes, the
 * days it runs, and the plan-wide count. Pinned string-level on the extracted pure fn for
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
    "Week 1 of 14 · pick 4 for 2 Mar – 8 Mar 2026 · 0 of 12 booked",
  ],
  [
    "a placed week opens the next one",
    { SCHEDULED: 4 },
    "Week 2 of 14 · pick 4 for 9 Mar – 15 Mar 2026 · 4 of 12 booked",
  ],
  [
    "a delivered week opens the next one too",
    { COMPLETED: 4 },
    "Week 2 of 14 · pick 4 for 9 Mar – 15 Mar 2026 · 4 of 12 booked",
  ],
  [
    "top-up",
    { SCHEDULED: 2 },
    "Week 1 of 14 · pick 2 for 2 Mar – 8 Mar 2026 · 2 of 12 booked",
  ],
])("%s", (_name, spec, expected) => {
  expect(heading(spec)).toBe(expected);
});

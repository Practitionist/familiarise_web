/**
 * A release moves one plan week at a time: a set of sessions across two plan
 * weeks is refused, and the picker starts with the earliest week's sessions.
 */
import {
  earliestWeekSessions,
  spansPlanWeeks,
} from "@/lib/booking/release-weeks";

const DAY = 24 * 3_600_000;
// 1-a-week plan starting Mon 2 Nov 2026 (UTC); sessions on Nov 4 and Nov 11.
const plan = {
  sessionsPerWeek: 1,
  durationInMonths: 1,
  schedulingPeriodStartsAt: new Date("2026-11-02T00:00:00.000Z"),
  schedulingTimezone: "UTC",
};
const nov4 = new Date("2026-11-04T10:00:00.000Z");
const nov11 = new Date(nov4.getTime() + 7 * DAY);

it("flags sessions in two plan weeks, not one", () => {
  expect(spansPlanWeeks(plan, [nov4, nov11])).toBe(true);
  expect(spansPlanWeeks(plan, [nov4])).toBe(false);
  expect(spansPlanWeeks(plan, [nov4, new Date(nov4.getTime() + DAY)])).toBe(
    false,
  );
});

it("starts the picker with the earliest week's sessions", () => {
  const sessions = [{ startTime: nov4 }, { startTime: nov11 }];
  expect(earliestWeekSessions(plan, sessions)).toEqual([{ startTime: nov4 }]);
});

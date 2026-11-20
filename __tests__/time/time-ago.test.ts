/**
 * @jest-environment node
 */

/** Workspace Activity and operator Home print one row's age the same way. */

import { timeAgo } from "../../lib/time/time-ago";

afterEach(() => jest.useRealTimers());

it("rounds a 17.6-day age to 18 days, the same on every feed", () => {
  jest.useFakeTimers().setSystemTime(new Date("2026-11-19T00:00:00Z"));
  const row = new Date(
    Date.parse("2026-11-19T00:00:00Z") - 17.6 * 86_400_000,
  ).toISOString();
  expect(timeAgo(row)).toBe("18 days ago");
  expect(timeAgo("not a date")).toBe("—");
});

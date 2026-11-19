/**
 * The consultant's plan-week reminder: owed for the CURRENT plan week while it
 * has sessions to place, on the week's first day from 09:00 in the
 * consultant's zone, the next day and the third; never at night, never for a
 * next week opened early, never once the week is full; one sentence per
 * consultant however many plans are due.
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/novu/service", () => ({}));
jest.mock("../../lib/email", () => ({}));
jest.mock("../../lib/novu/outbox", () => ({}));

import {
  inWakingHours,
  weekNudgeFor,
  weekSummary,
} from "../../lib/booking/week-nudge";

const TZ = "Asia/Kolkata";
const HOUR = 3_600_000;
// Mon 2 Mar 2026 00:00 IST: week 1 is 2–8 Mar, week 2 is 9–15 Mar.
const START = new Date("2026-03-01T18:30:00.000Z");
const WEEK_TWO = new Date(START.getTime() + 7 * 24 * HOUR);
const at = (base: Date, hours: number) =>
  new Date(base.getTime() + hours * HOUR);

const session = (dayOffset: number, completionStatus = "SCHEDULED") => {
  const startsAt = new Date(
    START.getTime() + dayOffset * 24 * HOUR + 10 * HOUR,
  );
  return {
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    completionStatus,
    isTentative: false,
    deletedAt: null,
  };
};

const plan = (occurrences: ReturnType<typeof session>[]) => ({
  sessionsTotal: 72,
  sessionsRefunded: 0,
  sessionsPerWeek: 3,
  durationInMonths: 6,
  occurrences,
  schedulingPeriodStartsAt: START,
  schedulingTimezone: TZ,
  planEndsAt: null,
});

const delivered = [0, 2, 4].map((d) => session(d, "COMPLETED"));

it("starts at 09:00 local on the week's first day, never at its midnight", () => {
  expect(weekNudgeFor(plan(delivered), at(WEEK_TWO, 1), TZ)).toBeNull();
  expect(weekNudgeFor(plan(delivered), at(WEEK_TWO, 8.5), TZ)).toBeNull();
  expect(weekNudgeFor(plan(delivered), at(WEEK_TWO, 9), TZ)).toMatchObject({
    weekNumber: 2,
    sessionsToPlace: 3,
  });
});

it("runs on the first day, the next and the third, not in between", () => {
  const day = (n: number) =>
    weekNudgeFor(plan(delivered), at(WEEK_TWO, 24 * n + 10), TZ);
  expect(day(0)).not.toBeNull();
  expect(day(1)).not.toBeNull();
  expect(day(2)).toBeNull();
  expect(day(3)).not.toBeNull();
  expect(day(4)).toBeNull();
});

it("starts every ladder day at 09:00, so one run batches the day's plans", () => {
  // Day +1 (Tue 10 Mar) at 08:30 and 09:00 IST.
  expect(weekNudgeFor(plan(delivered), at(WEEK_TWO, 24 + 8.5), TZ)).toBeNull();
  expect(
    weekNudgeFor(plan(delivered), at(WEEK_TWO, 24 + 9), TZ),
  ).not.toBeNull();
});

it("anchors on the consultant's own zone", () => {
  // 09:00 IST on Mon 9 Mar is 03:30 UTC; a London consultant waits for 09:00 London.
  expect(
    weekNudgeFor(plan(delivered), at(WEEK_TWO, 9.5), "Europe/London"),
  ).toBeNull();
  expect(
    weekNudgeFor(plan(delivered), at(WEEK_TWO, 15), "Europe/London"),
  ).not.toBeNull();
});

it("never sends outside 08:00–21:00 local", () => {
  expect(inWakingHours(new Date("2026-03-09T02:00:00.000Z"), TZ)).toBe(false); // 07:30
  expect(inWakingHours(new Date("2026-03-09T03:00:00.000Z"), TZ)).toBe(true); // 08:30
  expect(inWakingHours(new Date("2026-03-09T15:29:00.000Z"), TZ)).toBe(true); // 20:59
  expect(inWakingHours(new Date("2026-03-09T15:30:00.000Z"), TZ)).toBe(false); // 21:00
});

it("is not owed for a next week opened early, nor for a full week", () => {
  const thisWeekFull = [0, 1, 2].map((d) => session(d));
  expect(
    weekNudgeFor(plan(thisWeekFull), at(START, 2 * 24 + 12), TZ),
  ).toBeNull();
  const bothFull = [0, 1, 2, 7, 8, 9].map((d) => session(d));
  expect(weekNudgeFor(plan(bothFull), at(WEEK_TWO, 10), TZ)).toBeNull();
});

it("one sentence per consultant, however many plans are due", () => {
  expect(
    weekSummary([{ consulteeName: "Priya", number: 5, sessions: 2 }]),
  ).toBe("Priya's week 5 (2 sessions) still needs session times.");
  expect(
    weekSummary([
      { consulteeName: "Priya", number: 5, sessions: 1 },
      { consulteeName: "Arjun", number: 2, sessions: 3 },
      { consulteeName: "Meera", number: 9, sessions: 2 },
    ]),
  ).toBe(
    "Priya's week 5 (1 session) and 2 more plans need session times this week.",
  );
});

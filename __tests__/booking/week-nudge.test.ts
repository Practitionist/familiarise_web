/**
 * The consultant's plan-week reminder: owed for the CURRENT plan week while it
 * has sessions to place, at +0, +24 and +72 h after the week opens; never for
 * a next week opened early, and never once the week is full.
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/novu/service", () => ({}));
jest.mock("../../lib/email", () => ({}));
jest.mock("../../lib/novu/outbox", () => ({}));

import { weekNudgeFor } from "../../lib/booking/week-nudge";

const TZ = "Asia/Kolkata";
const HOUR = 3_600_000;
// Mon 2 Mar 2026 00:00 IST: week 1 is 2–8 Mar, week 2 is 9–15 Mar.
const START = new Date("2026-03-01T18:30:00.000Z");

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
  sessionsPerWeek: 3,
  durationInMonths: 6,
  occurrences,
  schedulingPeriodStartsAt: START,
  schedulingTimezone: TZ,
  planEndsAt: null,
});

it("is owed when a later week opens with nothing placed, then at +24 h and +72 h", () => {
  const delivered = [0, 2, 4].map((d) => session(d, "COMPLETED"));
  const weekTwo = new Date(START.getTime() + 7 * 24 * HOUR);
  expect(
    weekNudgeFor(plan(delivered), new Date(weekTwo.getTime() + HOUR)),
  ).toMatchObject({
    weekNumber: 2,
    sessionsToPlace: 3,
    stage: 0,
  });
  expect(
    weekNudgeFor(plan(delivered), new Date(weekTwo.getTime() + 25 * HOUR))
      ?.stage,
  ).toBe(24);
  expect(
    weekNudgeFor(plan(delivered), new Date(weekTwo.getTime() + 80 * HOUR))
      ?.stage,
  ).toBe(72);
});

it("is not owed for a next week opened early, nor for a full week", () => {
  const thisWeekFull = [0, 1, 2].map((d) => session(d));
  // Week 1 is full on Wednesday, so week 2 is open early: the consultant is ahead.
  expect(
    weekNudgeFor(
      plan(thisWeekFull),
      new Date(START.getTime() + 2 * 24 * HOUR + 12 * HOUR),
    ),
  ).toBeNull();
  const bothFull = [0, 1, 2, 7, 8, 9].map((d) => session(d));
  expect(
    weekNudgeFor(plan(bothFull), new Date(START.getTime() + 8 * 24 * HOUR)),
  ).toBeNull();
});

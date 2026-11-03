/**
 * The top-up places a plan's open weeks on its own only when the consultant
 * scheduled the plan with Auto. One later week placed with the one-tap Auto,
 * the sweep's own runs and confirmed reschedules never change that choice.
 */
import {
  SCHEDULED_AUTO,
  SCHEDULED_BY_HAND,
  SCHEDULED_BY_RESCHEDULE,
  SCHEDULED_BY_TOP_UP,
  SCHEDULED_WEEK_AUTO,
  SCHEDULED_WEEK_BY_HAND,
  lastChoiceWasAuto,
  scheduleReason,
} from "@/lib/booking/allocation/schedule-choice";

describe("scheduleReason", () => {
  it.each([
    [{ mode: "auto" as const }, SCHEDULED_AUTO],
    [{ mode: "manual" as const }, SCHEDULED_BY_HAND],
    [{ mode: "requested" as const }, SCHEDULED_BY_HAND],
    [{ mode: "auto" as const, topUp: true }, SCHEDULED_WEEK_AUTO],
    [{ mode: "manual" as const, topUp: true }, SCHEDULED_WEEK_BY_HAND],
    [
      { mode: "auto" as const, topUp: true, bySweep: true },
      SCHEDULED_BY_TOP_UP,
    ],
    [
      { mode: "manual" as const, confirmsReschedule: true },
      SCHEDULED_BY_RESCHEDULE,
    ],
  ])("%j → %s", (args, reason) => {
    expect(scheduleReason(args)).toBe(reason);
  });
});

describe("lastChoiceWasAuto", () => {
  it("is the plan's own scheduling choice, newest first", () => {
    expect(lastChoiceWasAuto([SCHEDULED_BY_TOP_UP, SCHEDULED_AUTO])).toBe(true);
    expect(
      lastChoiceWasAuto([
        SCHEDULED_WEEK_AUTO,
        SCHEDULED_BY_RESCHEDULE,
        SCHEDULED_BY_HAND,
      ]),
    ).toBe(false);
    expect(lastChoiceWasAuto([SCHEDULED_BY_HAND, SCHEDULED_AUTO])).toBe(false);
    expect(lastChoiceWasAuto([null, "payment captured"])).toBe(false);
  });
});

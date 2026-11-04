/**
 * The top-up places a plan's open weeks on its own only when the consultant
 * chose Auto when first scheduling the plan. The choice is a stable token,
 * derived from server facts (whether the plan was ever placed, and who placed
 * it); one later
 * week, the sweep's own runs and re-placed or confirmed reschedules never
 * change it, and a plan with no token recorded is by hand.
 */
import {
  PLAN_CHOICES,
  SCHEDULE_REASON,
  SCHEDULE_REASON_COPY,
  lastChoiceWasAuto,
  parseScheduleReason,
  scheduleReason,
} from "@/lib/booking/allocation/schedule-choice";

it("pins the stored tokens: changing one silently changes every plan's mode", () => {
  expect(SCHEDULE_REASON).toEqual({
    planAuto: "schedule:auto",
    planByHand: "schedule:by-hand",
    weekAuto: "schedule:week-auto",
    weekByHand: "schedule:week-by-hand",
    topUp: "schedule:top-up",
    reschedule: "schedule:reschedule",
  });
  expect(PLAN_CHOICES).toEqual(["schedule:auto", "schedule:by-hand"]);
  for (const token of Object.values(SCHEDULE_REASON)) {
    expect(SCHEDULE_REASON_COPY[token]).toMatch(/^[A-Z][a-z ]+$/);
  }
});

it("parses strictly: human copy is never a token", () => {
  expect(parseScheduleReason("schedule:auto")).toBe("schedule:auto");
  expect(parseScheduleReason("Scheduled automatically")).toBeNull();
  expect(parseScheduleReason("schedule:AUTO")).toBeNull();
  expect(parseScheduleReason(null)).toBeNull();
});

describe("scheduleReason from server facts", () => {
  const empty = { placedBefore: false, releasedBefore: 0, byConsultant: true };
  it.each([
    [{ mode: "auto" as const, ...empty }, SCHEDULE_REASON.planAuto],
    [{ mode: "manual" as const, ...empty }, SCHEDULE_REASON.planByHand],
    [{ mode: "requested" as const, ...empty }, SCHEDULE_REASON.planByHand],
    [
      { mode: "auto" as const, placedBefore: true, releasedBefore: 0 },
      SCHEDULE_REASON.weekAuto,
    ],
    [
      { mode: "manual" as const, placedBefore: true, releasedBefore: 0 },
      SCHEDULE_REASON.weekByHand,
    ],
    // Re-placing a released session is never a plan-level choice.
    [
      { mode: "auto" as const, placedBefore: false, releasedBefore: 1 },
      SCHEDULE_REASON.reschedule,
    ],
    [
      { mode: "manual" as const, ...empty, confirmsReschedule: true },
      SCHEDULE_REASON.reschedule,
    ],
    [
      {
        mode: "auto" as const,
        placedBefore: true,
        releasedBefore: 0,
        bySweep: true,
      },
      SCHEDULE_REASON.topUp,
    ],
    // Anyone but the consultant (or a door that does not say) is a one-off.
    [
      { mode: "auto" as const, ...empty, byConsultant: false },
      SCHEDULE_REASON.weekAuto,
    ],
    [
      { mode: "auto" as const, placedBefore: false, releasedBefore: 0 },
      SCHEDULE_REASON.weekAuto,
    ],
    [
      { mode: "manual" as const, ...empty, byConsultant: false },
      SCHEDULE_REASON.weekByHand,
    ],
  ])("%j → %s", (args, token) => {
    expect(scheduleReason(args)).toBe(token);
  });
});

describe("lastChoiceWasAuto", () => {
  it("reads the newest plan-level choice, newest first", () => {
    expect(
      lastChoiceWasAuto([SCHEDULE_REASON.topUp, SCHEDULE_REASON.planAuto]),
    ).toBe(true);
    expect(
      lastChoiceWasAuto([
        SCHEDULE_REASON.weekAuto,
        SCHEDULE_REASON.reschedule,
        SCHEDULE_REASON.planByHand,
      ]),
    ).toBe(false);
  });

  it("treats a plan with no token (scheduled before tokens) as by hand", () => {
    expect(
      lastChoiceWasAuto([null, "payment captured", "Scheduled automatically"]),
    ).toBe(false);
  });
});

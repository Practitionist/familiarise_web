/**
 * Every allocation records how its sessions were placed as a stable token in
 * the history row's reason. The token comes from server facts only, and the
 * timeline turns it into words.
 */
import {
  SCHEDULE_REASON,
  scheduleReason,
  scheduleReasonWords,
} from "@/lib/booking/allocation/schedule-choice";

it("pins the stored tokens: changing one orphans every history row that carries it", () => {
  expect(SCHEDULE_REASON).toEqual({
    auto: "schedule:auto",
    byHand: "schedule:by-hand",
    reschedule: "schedule:reschedule",
  });
});

describe("scheduleReason from server facts", () => {
  const fresh = { releasedBefore: 0 };
  it.each([
    [{ mode: "auto" as const, ...fresh }, SCHEDULE_REASON.auto],
    [{ mode: "manual" as const, ...fresh }, SCHEDULE_REASON.byHand],
    [{ mode: "requested" as const, ...fresh }, SCHEDULE_REASON.byHand],
    [{ mode: "auto" as const, releasedBefore: 1 }, SCHEDULE_REASON.reschedule],
    [
      { mode: "manual" as const, ...fresh, confirmsReschedule: true },
      SCHEDULE_REASON.reschedule,
    ],
  ])("%j records %s", (args, token) => {
    expect(scheduleReason(args)).toBe(token);
  });
});

describe("scheduleReasonWords", () => {
  it("reads every token a writer records as words", () => {
    for (const token of Object.values(SCHEDULE_REASON)) {
      expect(scheduleReasonWords(token)).toMatch(/^[A-Z][a-z ]+$/);
    }
  });

  it("still reads the tokens stored history rows carry", () => {
    expect(scheduleReasonWords("schedule:week-auto")).toBe(
      "Scheduled automatically",
    );
    expect(scheduleReasonWords("schedule:week-by-hand")).toBe(
      "Scheduled by hand",
    );
    expect(scheduleReasonWords("schedule:top-up")).toBe(
      "Scheduled automatically",
    );
  });

  it("matches exactly: human copy and other reasons are not tokens", () => {
    expect(scheduleReasonWords("Scheduled automatically")).toBeNull();
    expect(scheduleReasonWords("schedule:AUTO")).toBeNull();
    expect(scheduleReasonWords("toString")).toBeNull();
    expect(scheduleReasonWords(null)).toBeNull();
  });
});

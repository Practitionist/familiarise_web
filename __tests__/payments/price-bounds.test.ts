import {
  assertPlanPriceWithinBounds,
  defaultPriceForSession,
  isShortPack,
  minPriceForPack,
  minPriceForSession,
  PlanPriceBelowFloorError,
} from "@/lib/payments/pricing/price-bounds";

describe("price bounds", () => {
  it.each([
    [30, 49_900, 79_900],
    [31, 79_900, 119_900],
    [45, 79_900, 119_900],
    [46, 99_900, 149_900],
    [60, 99_900, 149_900],
    // Past an hour both pro-rate by the minute, rounded up to the rupee.
    [61, 101_600, 152_400],
    [90, 149_900, 224_900],
    [120, 199_800, 299_800],
  ])("a %i-minute session floors at %i and suggests %i", (min, floor, dflt) => {
    expect(minPriceForSession(min)).toBe(floor);
    expect(defaultPriceForSession(min)).toBe(dflt);
  });

  it("allows a pack at most 25% under the single-session floor", () => {
    expect(minPriceForPack(60, 4)).toBe(299_700);
    expect(minPriceForPack(60, 144)).toBe(10_789_200);
    expect(minPriceForPack(30, 3)).toBe(112_300);
  });

  it("refuses below the floor with a plain message, and has no maximum", () => {
    const at = (pricePaise: number) => () =>
      assertPlanPriceWithinBounds({
        kind: "PACK",
        pricePaise,
        sessionDurationInHours: 1,
        totalSessions: 4,
      });
    expect(at(299_700)).not.toThrow();
    expect(at(299_600)).toThrow(PlanPriceBelowFloorError);
    expect(at(299_600)).toThrow(
      "A plan of 4 60-minute sessions must be priced at ₹2,997 or more.",
    );
    expect(() =>
      assertPlanPriceWithinBounds({
        kind: "SESSION",
        pricePaise: 49_800,
        durationInHours: 0.5,
      }),
    ).toThrow("A 30-minute session must be priced at ₹499 or more.");
    expect(() =>
      assertPlanPriceWithinBounds({
        kind: "SESSION",
        pricePaise: 100_000_000,
        durationInHours: 0.5,
      }),
    ).not.toThrow();
  });

  it.each([
    ["a 3-week pack", 3, true],
    ["a 4-week pack", 4, true],
    ["a 5-week plan", 5, false],
    ["a month-based plan", null, false],
  ])("floors %s: %s", (_label, weeks, floored) => {
    expect(isShortPack(weeks)).toBe(floored);
  });

  it("rejects a non-positive length or session count", () => {
    expect(() => minPriceForSession(0)).toThrow(RangeError);
    expect(() => minPriceForPack(60, 0)).toThrow(RangeError);
  });
});

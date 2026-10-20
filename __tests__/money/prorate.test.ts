import fc from "fast-check";
import { prorate } from "@/lib/payments/utils/money";

describe("prorate", () => {
  it("floors exactly when the intermediate product exceeds 2^53", () => {
    const original = 9_000_000_000_000_000;
    const expected =
      (BigInt(original) * BigInt(7_777_777)) / BigInt(9_999_999_999);
    expect(prorate(original, 7_777_777, 9_999_999_999)).toBe(Number(expected));
    expect(Math.floor((original * 7_777_777) / 9_999_999_999)).not.toBe(
      Number(expected),
    );
  });

  it("returns the full amount for a full-amount proration past 2^53", () => {
    expect(prorate(416_029_418, 2_869_922_706, 2_869_922_706)).toBe(
      416_029_418,
    );
  });

  it("matches Math.floor on ordinary values, including negatives", () => {
    const cases: Array<[number, number, number]> = [
      [8000, 5, 8],
      [99_999, 1_234, 10_000],
      [1, 1, 3],
      [-500, 1, 3],
      [123_456_789, 2_500, 123_456_790],
    ];
    for (const [a, n, d] of cases) {
      expect(prorate(a, n, d)).toBe(Math.floor((a * n) / d));
    }
  });

  // Up to 2^52 the double quotient's error stays under half a 1/d step, so the old maths was exact.
  it("floor, round and ceil match the double maths for products up to 2^52", () => {
    const parity = fc.property(
      fc.integer({ min: 0, max: 2 ** 32 }),
      fc.integer({ min: 0, max: 2 ** 20 - 1 }),
      fc.integer({ min: 1, max: 2 ** 32 }),
      (a, n, d) =>
        prorate(a, n, d) === Math.floor((a * n) / d) &&
        prorate(a, n, d, "round") === Math.round((a * n) / d) &&
        prorate(a, n, d, "ceil") === Math.ceil((a * n) / d),
    );
    expect(() =>
      fc.assert(parity, { seed: 2230, numRuns: 2000 }),
    ).not.toThrow();
  });

  it("stays exact where the double quotient drifts", () => {
    // 5731111359479352 / 5 is …870.4; the double quotient lands on …870.5.
    expect(prorate(1_967_048_328, 2_913_559, 5, "round")).toBe(
      1_146_222_271_895_870,
    );
    expect(prorate(5_000_000_000_000_003, 3, 2, "round")).toBe(
      7_500_000_000_000_005,
    );
    expect(prorate(5_000_000_000_000_001, 5, 4, "ceil")).toBe(
      6_250_000_000_000_002,
    );
  });

  it("round goes half toward +infinity for negatives, like Math.round", () => {
    expect(prorate(-5, 1, 2, "round")).toBe(Math.round(-2.5));
    expect(prorate(-13, 1, 5, "round")).toBe(Math.round(-2.6));
  });

  it("throws on a non-integer input or an unsafe result", () => {
    expect(() => prorate(10.5, 1, 2)).toThrow("not a safe integer");
    expect(() => prorate(Number.MAX_SAFE_INTEGER, 4, 1)).toThrow(
      "outside Number safe range",
    );
  });
});

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

  it("throws on a non-integer input or an unsafe result", () => {
    expect(() => prorate(10.5, 1, 2)).toThrow("not a safe integer");
    expect(() => prorate(Number.MAX_SAFE_INTEGER, 4, 1)).toThrow(
      "outside Number safe range",
    );
  });
});

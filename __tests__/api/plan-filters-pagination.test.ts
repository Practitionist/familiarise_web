/**
 * Public pagination inputs are clamped, not rejected (PR #1148 review):
 * a crafted query must never reach Prisma with a negative `skip` (it throws),
 * a negative `take` (it reads from the END of the table), or an arbitrarily
 * large slice.
 */
import { parsePlanFilters } from "@/lib/api/plans/plan-filters";

const parse = (qs: string) => parsePlanFilters(new URLSearchParams(qs));

describe("parsePlanFilters pagination clamping", () => {
  it("applies the defaults when page/limit are absent", () => {
    expect(parse("")).toMatchObject({ page: 1, limit: 10, skip: 0 });
  });

  it("keeps ordinary values as-is", () => {
    expect(parse("page=3&limit=12")).toMatchObject({
      page: 3,
      limit: 12,
      skip: 24,
    });
  });

  it.each([
    ["negative", "page=-1&limit=-5"],
    ["zero", "page=0&limit=0"],
    ["malformed", "page=abc&limit=xyz"],
    ["empty", "page=&limit="],
  ])("falls back to the defaults for %s values", (_label, qs) => {
    expect(parse(qs)).toMatchObject({ page: 1, limit: 10, skip: 0 });
  });

  it("truncates fractional and partially numeric values (parseInt semantics)", () => {
    expect(parse("page=2.9&limit=25x")).toMatchObject({
      page: 2,
      limit: 25,
      skip: 25,
    });
  });

  it("bounds oversized values so skip/take stay sane", () => {
    const parsed = parse("page=999999999&limit=999999999");
    expect(parsed.page).toBe(10_000);
    expect(parsed.limit).toBe(100);
    expect(parsed.skip).toBe((10_000 - 1) * 100);
  });

  it("never produces a negative skip", () => {
    for (const qs of ["page=-100", "page=0&limit=50", "page=-1&limit=-1"]) {
      expect(parse(qs).skip).toBeGreaterThanOrEqual(0);
    }
  });
});

/**
 * @jest-environment node
 */
import { parsePlanFilters } from "@/app/api/plans/shared/plan-filters";
import { normaliseSearchTerm } from "@/lib/explore/programs";

describe("normaliseSearchTerm", () => {
  it("trims and collapses whitespace", () => {
    expect(normaliseSearchTerm("  py   thon \n")).toBe("py thon");
  });

  it("treats a term too short to search as no search", () => {
    expect(normaliseSearchTerm("a")).toBeUndefined();
    expect(normaliseSearchTerm("  a  ")).toBeUndefined();
    expect(normaliseSearchTerm("")).toBeUndefined();
    expect(normaliseSearchTerm(null)).toBeUndefined();
    expect(normaliseSearchTerm(undefined)).toBeUndefined();
  });

  it("keeps a two-character term", () => {
    expect(normaliseSearchTerm("ux")).toBe("ux");
  });

  it("caps the length of what one request asks the database to match", () => {
    const term = normaliseSearchTerm("x".repeat(500));
    expect(term).toHaveLength(100);
  });

  it("does not leave a trailing space where the cap lands on whitespace", () => {
    const term = normaliseSearchTerm(`${"x".repeat(99)} tail`);
    expect(term).toBe("x".repeat(99));
  });
});

describe("parsePlanFilters search", () => {
  it("normalises the query-string term the API receives", () => {
    const filters = parsePlanFilters(
      new URLSearchParams("search=%20%20python%20"),
    );
    expect(filters.search).toBe("python");
  });

  it("drops a one-character term instead of scanning for it", () => {
    expect(parsePlanFilters(new URLSearchParams("search=a")).search).toBeNull();
  });

  it("leaves search null when absent", () => {
    expect(parsePlanFilters(new URLSearchParams("")).search).toBeNull();
  });
});

import {
  NAV_FLAT_LINKS,
  NAV_GROUPS,
  EXPLORE_CATEGORIES,
} from "@/lib/navigation/public-nav";
import {
  domainPath,
  domainSlug,
  findDomainBySlug,
} from "@/lib/explore/domain-slug";

const items = NAV_GROUPS.flatMap((g) => g.columns.flatMap((c) => c.items));
const liveItems = items.filter((i) => !i.disabled);
const allHrefs = [
  ...liveItems.map((i) => i.href),
  ...NAV_GROUPS.flatMap((g) => g.categoryChips ?? []).map((c) => c.href),
  ...NAV_FLAT_LINKS.map((l) => l.href),
];

describe("public nav", () => {
  it("never links to an in-page anchor", () => {
    expect(allHrefs.filter((h) => h.includes("#"))).toEqual([]);
  });

  it("only links to site-relative paths", () => {
    expect(allHrefs.filter((h) => !h.startsWith("/"))).toEqual([]);
  });

  it("never sends two entries to the same destination", () => {
    const seen = new Set<string>();
    const dupes = allHrefs.filter((h) => (seen.has(h) ? true : !seen.add(h)));
    expect(dupes).toEqual([]);
  });

  it("keeps Resources and Pricing out of the bar and puts the expert entry in it", () => {
    const labels = NAV_GROUPS.map((g) => g.label);
    expect(labels).toEqual(["Explore", "Solutions", "For business"]);
    expect(NAV_FLAT_LINKS.map((l) => l.href)).toEqual(["/become-an-expert"]);
  });

  it("marks unavailable entries as disabled instead of linking them", () => {
    expect(items.filter((i) => i.disabled).map((i) => i.label)).toEqual([
      "Courses",
    ]);
  });

  it("points every field chip at its own category page", () => {
    expect(EXPLORE_CATEGORIES.map((c) => c.href)).toEqual([
      "/explore/experts/c/technology",
      "/explore/experts/c/business",
      "/explore/experts/c/creative-arts",
      "/explore/experts/c/education",
      "/explore/experts/c/health",
      "/explore/experts/c/personal-development",
    ]);
  });
});

describe("domain slugs", () => {
  it("slugs names and round-trips through the lookup", () => {
    expect(domainSlug("Creative Arts")).toBe("creative-arts");
    expect(domainSlug("Health & Wellness")).toBe("health-and-wellness");
    expect(domainPath("Technology")).toBe("/explore/experts/c/technology");
    const domains = [{ name: "Creative Arts" }, { name: "Business" }];
    expect(findDomainBySlug(domains, "creative-arts")).toBe(domains[0]);
    expect(findDomainBySlug(domains, "nope")).toBeUndefined();
  });

  it("trims stray separators and stays fast on long runs of them", () => {
    expect(domainSlug("  --Data & AI--  ")).toBe("data-and-ai");
    expect(domainSlug("!!!")).toBe("");
    const started = Date.now();
    expect(domainSlug(`${"-".repeat(50_000)}x`)).toBe("x");
    expect(Date.now() - started).toBeLessThan(200);
  });
});

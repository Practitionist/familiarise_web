import { resolveTaxonomyFilters } from "@/app/explore/experts/utils";

const metadata = {
  domains: [
    { id: "d1", name: "Technology" },
    { id: "d2", name: "Personal Development" },
  ],
  subdomains: [{ id: "s1", name: "System Design", domainId: "d1" }],
};

describe("resolveTaxonomyFilters", () => {
  it("rewrites a domain given by name to its id, ignoring case", () => {
    expect(
      resolveTaxonomyFilters(
        { domain: "technology", subdomain: null },
        metadata,
      ),
    ).toEqual({ domain: "d1" });
  });

  it("rewrites a specialty given by name to its id", () => {
    expect(
      resolveTaxonomyFilters(
        { domain: null, subdomain: "System Design" },
        metadata,
      ),
    ).toEqual({ subdomain: "s1" });
  });

  it("returns null when the values are already ids", () => {
    expect(
      resolveTaxonomyFilters({ domain: "d1", subdomain: "s1" }, metadata),
    ).toBeNull();
  });

  it("returns null for an unknown name rather than guessing", () => {
    expect(
      resolveTaxonomyFilters({ domain: "Nope", subdomain: null }, metadata),
    ).toBeNull();
  });
});

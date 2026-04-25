/**
 * @jest-environment node
 */

/**
 * OrgContextFilter — pure-function tests for the filter-sentinel
 * serializer used on consultant + consultee dashboards. The React
 * component itself is exercised by Playwright / manual smoke; this file
 * covers the contract that both sides depend on: translating the
 * sentinel value to the API query-param representation.
 */

import {
  ORG_FILTER_ALL,
  ORG_FILTER_PERSONAL,
  serializeOrgFilter,
} from "@/lib/dashboard/org-context-filter";

describe("serializeOrgFilter", () => {
  it("maps ALL to undefined (no filter)", () => {
    expect(serializeOrgFilter(ORG_FILTER_ALL)).toBeUndefined();
  });

  it("maps PERSONAL to 'none' (API interprets as organizationId IS NULL)", () => {
    expect(serializeOrgFilter(ORG_FILTER_PERSONAL)).toBe("none");
  });

  it("passes an arbitrary organizationId through unchanged", () => {
    expect(serializeOrgFilter("org_abc123")).toBe("org_abc123");
  });

  it("does not special-case the empty string", () => {
    // Empty string is not a sentinel — it's passed through so the
    // backend can decide (and probably treat it like no filter after
    // Zod coercion). The component should never produce this value,
    // but the pure helper is strict.
    expect(serializeOrgFilter("" as string)).toBe("");
  });
});

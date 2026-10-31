/**
 * @jest-environment node
 */

/**
 * The scope projections are exhaustive switches: every known kind maps to an
 * explicit filter (`all` alone is unfiltered), and an unknown kind throws
 * instead of reading every tenant.
 */

import {
  scopeOrgId,
  scopeToPlanHostWhere,
  scopeToWhereOrgId,
  type Scope,
} from "@/lib/api/scope/parse";

const forged = { kind: "everything" } as unknown as Scope;

describe("scopeToWhereOrgId", () => {
  it.each<[string, Scope, unknown]>([
    ["personal pins no org", { kind: "personal" }, { organizationId: null }],
    [
      "org pins its org",
      { kind: "org", orgId: "o1" },
      { organizationId: "o1" },
    ],
    [
      "orgMember pins its org",
      { kind: "orgMember", orgId: "o1", userId: "u1" },
      { organizationId: "o1" },
    ],
    ["all is the only unfiltered kind", { kind: "all" }, undefined],
  ])("%s", (_label, scope, expected) => {
    expect(scopeToWhereOrgId(scope)).toEqual(expected);
  });

  it("throws on an unknown kind instead of returning an empty filter", () => {
    expect(() => scopeToWhereOrgId(forged)).toThrow(/must fail closed/);
    expect(() => scopeOrgId(forged)).toThrow(/must fail closed/);
  });

  it("projects the plan's host org the same way", () => {
    expect(scopeToPlanHostWhere({ kind: "personal" })).toEqual({
      organizationId: null,
    });
    expect(() => scopeToPlanHostWhere(forged)).toThrow(/must fail closed/);
  });
});

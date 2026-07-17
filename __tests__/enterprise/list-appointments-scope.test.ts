/**
 * @jest-environment node
 */

/**
 * #674 — personal-scope appointment query. Consultee arms stay scoped to
 * non-org bookings (sponsored sessions are org business); consultant arms cover
 * every session the user DELIVERS, sponsored or not, since an independent
 * consultant / host EXPERT has no org-scope access to see them otherwise.
 */

import { buildWhere } from "@/lib/api/scope/list-appointments";

describe("buildWhere — personal scope (#674)", () => {
  const where = buildWhere({
    scope: { kind: "personal" },
    userId: "u1",
  }) as {
    OR: Array<Record<string, unknown>>;
  };

  it("has consultee arms constrained to organizationId: null", () => {
    const consulteeArms = where.OR.filter(
      (a) => "organizationId" in a && a.organizationId === null,
    );
    // consultation / subscription / trial (consultee side)
    expect(consulteeArms).toHaveLength(3);
  });

  it("has consultant arms NOT constrained by organizationId (sponsored visible)", () => {
    const consultantArms = where.OR.filter((a) => !("organizationId" in a));
    // consultation-plan / subscription-plan / trial / webinar-plan / class-plan
    expect(consultantArms).toHaveLength(5);
    // each keys off the plan's consultantProfile userId
    const hasConsultantUser = consultantArms.some((a) =>
      JSON.stringify(a).includes('"consultantProfile":{"userId":"u1"}'),
    );
    expect(hasConsultantUser).toBe(true);
  });

  it("org scope filters by orgId with no user OR", () => {
    const w = buildWhere({
      scope: { kind: "org", orgId: "org1" },
      userId: "u1",
    }) as Record<string, unknown>;
    expect(w.organizationId).toBe("org1");
    expect(w.OR).toBeUndefined();
  });
});

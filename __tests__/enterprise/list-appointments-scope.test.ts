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

  it("orgMember scope pins organizationId AND filters to the user's participation (#org-appts)", () => {
    const w = buildWhere({
      scope: { kind: "orgMember", orgId: "org1", userId: "u1" },
      userId: "u1",
    }) as { organizationId: string; OR: Array<Record<string, unknown>> };
    // Strictly this org's activity...
    expect(w.organizationId).toBe("org1");
    // ...AND only the user's own — consultation/subscription, both consumed
    // (booked) and delivered arms. Trials are excluded (B2C, personal scope).
    expect(w.OR).toHaveLength(6);
    const s = JSON.stringify(w.OR);
    expect(s).toContain('"requestedBy":{"userId":"u1"}'); // consultee side
    expect(s).toContain('"consultantProfile":{"userId":"u1"}'); // consultant side
    expect(s).not.toContain("trialSession"); // trials stay B2C/personal
    // No arm re-pins organizationId: null (that's personal scope, not this).
    expect(w.OR.every((arm) => !("organizationId" in arm))).toBe(true);
  });
});

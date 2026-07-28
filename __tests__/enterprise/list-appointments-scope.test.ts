/**
 * @jest-environment node
 */

/**
 * #org-appts — personal-scope appointment query. The personal dashboards are now
 * purely B2C on BOTH sides: `organizationId: null` is pinned at the top level, so
 * every org-hosted session (delivered OR attended) is excluded here and lives in
 * the org dashboard under `orgMember` scope. Retires the earlier #674 carve-out
 * that force-showed delivered org sessions in the personal list.
 */

import { buildWhere } from "@/lib/api/scope/list-appointments";

describe("buildWhere — personal scope (#org-appts)", () => {
  const where = buildWhere({
    scope: { kind: "personal" },
    userId: "u1",
  }) as {
    organizationId: unknown;
    OR: Array<Record<string, unknown>>;
  };

  it("pins organizationId: null at the top level (purely B2C)", () => {
    expect(where.organizationId).toBeNull();
  });

  it("covers both sides — 3 consultee + 5 consultant arms, none re-pinning org", () => {
    // consultee: consultation / subscription / trial ; consultant: consultation-
    // plan / subscription-plan / trial / webinar-plan / class-plan
    expect(where.OR).toHaveLength(8);
    // The org constraint is top-level, so no arm carries its own organizationId.
    expect(where.OR.every((a) => !("organizationId" in a))).toBe(true);
    const hasConsultantUser = where.OR.some((a) =>
      JSON.stringify(a).includes('"consultantProfile":{"userId":"u1"}'),
    );
    expect(hasConsultantUser).toBe(true);
    const hasConsulteeUser = where.OR.some((a) =>
      JSON.stringify(a).includes('"requestedBy":{"userId":"u1"}'),
    );
    expect(hasConsulteeUser).toBe(true);
  });

  it("org scope covers events the org HOSTS or FUNDED, and never filters by user", () => {
    const w = buildWhere({
      scope: { kind: "org", orgId: "org1" },
      userId: "u1",
    }) as Record<string, unknown>;

    // Two columns, two questions. A group event shares ONE Appointment across
    // every registrant and checkout tags it with the HOST's org, so filtering
    // on `organizationId` alone hid every webinar a sponsor had paid into.
    // Per-registrant funding lives on Payment.organizationId.
    const or = w.OR as Record<string, unknown>[];
    expect(or).toHaveLength(2);
    expect(or).toContainEqual({ organizationId: "org1" });
    expect(or).toContainEqual({
      payment: { some: { organizationId: "org1" } },
    });

    // The property the previous version of this test was really protecting:
    // the org arm carries NO user filter, which is why it requires
    // `operations.read` and why a non-operator is downgraded to `orgMember`.
    // Widening to hosted-or-funded must not have smuggled one in.
    expect(JSON.stringify(w)).not.toContain('"u1"');
    expect(JSON.stringify(w)).not.toContain("userId");
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

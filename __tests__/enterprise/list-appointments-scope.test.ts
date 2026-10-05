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

  it("covers both sides — 3 consultee + 7 consultant arms (including collaborated webinars/classes), none re-pinning org", () => {
    // consultee: consultation / subscription / trial ; consultant: consultation-
    // plan / subscription-plan / trial / webinar-plan / webinar-collaborator /
    // class-plan / class-collaborator
    expect(where.OR).toHaveLength(10);
    // The org constraint is top-level, so no arm carries its own organizationId.
    expect(where.OR.every((a) => !("organizationId" in a))).toBe(true);
    const hasConsultantUser = where.OR.some((a) =>
      JSON.stringify(a).includes('"consultantProfile":{"userId":"u1"}'),
    );
    expect(hasConsultantUser).toBe(true);
    const hasCollaboratorArm = where.OR.some((a) =>
      JSON.stringify(a).includes(
        '"collaborators":{"some":{"consultantProfile":{"userId":"u1"},"status":"ACCEPTED"}}',
      ),
    );
    expect(hasCollaboratorArm).toBe(true);
    const hasConsulteeUser = where.OR.some((a) =>
      JSON.stringify(a).includes('"requestedBy":{"userId":"u1"}'),
    );
    expect(hasConsulteeUser).toBe(true);
  });

  it("org scope matches org-OWNED rows only, and never filters by user (#1166 ORG-8)", () => {
    const w = buildWhere({
      scope: { kind: "org", orgId: "org1" },
      userId: "u1",
    }) as Record<string, unknown>;

    // List/detail parity: the detail page 404s any row whose organizationId
    // isn't this org, so the list pins organizationId at the top level.
    expect(w.organizationId).toBe("org1");
    expect(Array.isArray(w.OR)).toBe(true);

    // The org arm carries NO user filter, which is why it requires
    // `operations.read` and why a non-operator is downgraded to `orgMember`.
    expect(JSON.stringify(w)).not.toContain('"u1"');
    expect(JSON.stringify(w)).not.toContain("userId");
  });

  it("org scope admits unpaid, org-funded, or org-hosted rows while keeping funded-elsewhere out", () => {
    const w = buildWhere({
      scope: { kind: "org", orgId: "org1" },
      userId: "u1",
    }) as {
      organizationId: string;
      OR: Array<Record<string, unknown>>;
    };

    expect(w.organizationId).toBe("org1");
    expect(w.OR).toEqual(
      expect.arrayContaining([
        { payment: { none: {} } },
        {
          payment: {
            some: {
              organizationId: "org1",
              paymentMethod: { in: ["WALLET", "INVOICE", "LICENSE"] },
            },
          },
        },
        { consultation: { consultationPlan: { organizationId: "org1" } } },
        { subscription: { subscriptionPlan: { organizationId: "org1" } } },
        { webinar: { webinarPlan: { organizationId: "org1" } } },
        { class: { classPlan: { organizationId: "org1" } } },
      ]),
    );
  });

  it("orgMember scope pins organizationId AND filters to the user's participation (#org-appts)", () => {
    const w = buildWhere({
      scope: { kind: "orgMember", orgId: "org1", userId: "u1" },
      userId: "u1",
    }) as { organizationId: string; OR: Array<Record<string, unknown>> };
    // Strictly this org's activity...
    expect(w.organizationId).toBe("org1");
    // ...AND only the user's own — booked / attended (held seat) / delivered
    // (including collaborated webinar/class) arms. Trials are excluded (B2C, personal scope).
    expect(w.OR).toHaveLength(9);
    const s = JSON.stringify(w.OR);
    expect(s).toContain('"requestedBy":{"userId":"u1"}'); // consultee side
    expect(s).toContain('"consultantProfile":{"userId":"u1"}'); // consultant side
    expect(s).toContain(
      '"collaborators":{"some":{"consultantProfile":{"userId":"u1"},"status":"ACCEPTED"}}',
    );
    expect(s).not.toContain("trial"); // trials stay B2C/personal
    // No arm re-pins organizationId: null (that's personal scope, not this).
    expect(w.OR.every((arm) => !("organizationId" in arm))).toBe(true);
  });

  it("orgMember scope matches an org-sponsored attendee via slot membership (#1166 ORG-5)", () => {
    const w = buildWhere({
      scope: { kind: "orgMember", orgId: "org1", userId: "u1" },
      userId: "u1",
    }) as { OR: Array<Record<string, unknown>> };

    // A webinar/class registrant holds a seat but never appears in
    // requestedBy (group events share ONE Appointment), so this arm is the
    // only reason an org-sponsored attendee's session is visible anywhere.
    // #1554 — the seat is a live AppointmentParticipant row.
    expect(w.OR).toContainEqual({
      participants: {
        some: {
          userId: "u1",
          status: { in: ["HELD", "CONFIRMED", "ATTENDED"] },
        },
      },
    });
  });
});

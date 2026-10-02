/**
 * @jest-environment node
 */

/**
 * An ACTIVE membership outlives the org it belongs to.
 *
 * `PATCH /api/organizations/[orgId]` soft-deletes by stamping `DEACTIVATED` +
 * `deletedAt` and touching no Membership row, while every `?orgScope=` caller
 * authorises against `ctx.memberships` alone. So a member of a torn-down org
 * kept reading that org's appointments, documents, recordings and
 * collaborations through the personal door forever — while `requireOrgAccess`
 * 403'd the same org on the sibling door.
 *
 * Two halves, and the split is deliberate:
 *
 *   - the RESOLUTION refuses a DEACTIVATED org (403 ORG_DEACTIVATED), the same
 *     verdict and the same sentence `requireOrgAccess` gives;
 *   - the org appointments WHERE excludes rows whose org is no longer readable,
 *     because a query has no `Organization` row in scope to ask and this one
 *     cannot be made to depend on a field no caller passes yet.
 *
 * SUSPENDED is readable in both. Its documented posture is "existing bookings
 * keep running", and ADDRESSABLE_ORG_STATUSES says so outright: a SUSPENDED
 * org keeps dashboard read-only access precisely so its OWNER can find and fix
 * whatever suspended it.
 */

import {
  ORG_SCOPE_READABLE_STATUSES,
  isOrgReadableForScope,
  resolveOrgScope,
  type Scope,
} from "@/lib/api/scope/parse";
import { buildWhere } from "@/lib/api/scope/list-appointments";

const ORG = "org-1";
const MEMBER = { organizationId: ORG, status: "ACTIVE" as const };

function ctx(
  role: "OWNER" | "MANAGER" | "LEARNER",
  orgStatus?:
    | "ACTIVE"
    | "SUSPENDED"
    | "DEACTIVATED"
    | "PENDING_VERIFICATION"
    | null,
) {
  return {
    raw: ORG,
    memberships: [{ ...MEMBER, role }],
    userRole: "USER",
    userId: "u1",
    ...(orgStatus !== undefined && { orgStatus }),
  };
}

describe("ORG_SCOPE_READABLE_STATUSES", () => {
  it("excludes DEACTIVATED and admits everything else", () => {
    expect(ORG_SCOPE_READABLE_STATUSES).not.toContain("DEACTIVATED");
    expect(ORG_SCOPE_READABLE_STATUSES).toContain("ACTIVE");
    expect(ORG_SCOPE_READABLE_STATUSES).toContain("PENDING_VERIFICATION");
    // The load-bearing one: SUSPENDED is a sanction on NEW activity, not on
    // reading the sessions members are already booked into.
    expect(ORG_SCOPE_READABLE_STATUSES).toContain("SUSPENDED");
  });

  it("a missing org row is not readable", () => {
    expect(isOrgReadableForScope(null)).toBe(false);
    expect(isOrgReadableForScope(undefined)).toBe(false);
    expect(isOrgReadableForScope("DEACTIVATED")).toBe(false);
    expect(isOrgReadableForScope("SUSPENDED")).toBe(true);
  });
});

describe("resolveOrgScope on a DEACTIVATED org", () => {
  it.each(["OWNER", "MANAGER", "LEARNER"] as const)(
    "refuses a %s even with an ACTIVE membership",
    (role) => {
      const res = resolveOrgScope(ctx(role, "DEACTIVATED"));
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("unreachable");
      expect(res.status).toBe(403);
      expect(res.code).toBe("ORG_DEACTIVATED");
      // Same sentence requireOrgAccess answers with, so a client that already
      // handles the org door needs no second string.
      expect(res.message).toBe("Organization has been deactivated");
    },
  );

  it("refuses a vanished org row too", () => {
    const res = resolveOrgScope(ctx("OWNER", null));
    expect(res).toMatchObject({ ok: false, code: "ORG_DEACTIVATED" });
  });

  it("refuses the LEARNER before the operations.read downgrade would have", () => {
    // Otherwise a deactivated org would answer `orgMember` — a live, working
    // read scoped to the caller's own rows — which is the opposite of the
    // point.
    const res = resolveOrgScope(ctx("LEARNER", "DEACTIVATED"));
    expect(res.ok).toBe(false);
  });

  it("refuses when organization.status is passed on the membership row (route select shape)", () => {
    const res = resolveOrgScope({
      raw: ORG,
      memberships: [
        {
          ...MEMBER,
          role: "OWNER",
          organization: { status: "DEACTIVATED" },
        },
      ],
      userRole: "USER",
      userId: "u1",
    });
    expect(res).toMatchObject({
      ok: false,
      status: 403,
      code: "ORG_DEACTIVATED",
      message: "Organization has been deactivated",
    });
  });

  it("refuses when membership.organization is null (deleted org row)", () => {
    const res = resolveOrgScope({
      raw: ORG,
      memberships: [
        {
          ...MEMBER,
          role: "OWNER",
          organization: null,
        },
      ],
      userRole: "USER",
      userId: "u1",
    });
    expect(res).toMatchObject({
      ok: false,
      status: 403,
      code: "ORG_DEACTIVATED",
    });
  });
});

describe("resolveOrgScope is otherwise unchanged", () => {
  it("SUSPENDED keeps org scope for an operator", () => {
    const res = resolveOrgScope(ctx("MANAGER", "SUSPENDED"));
    expect(res).toEqual({ ok: true, scope: { kind: "org", orgId: ORG } });
  });

  it("SUSPENDED keeps the learner downgrade to their own rows", () => {
    const res = resolveOrgScope(ctx("LEARNER", "SUSPENDED"));
    expect(res).toEqual({
      ok: true,
      scope: { kind: "orgMember", orgId: ORG, userId: "u1" },
    });
  });

  it("ACTIVE and PENDING_VERIFICATION are unaffected", () => {
    for (const status of ["ACTIVE", "PENDING_VERIFICATION"] as const) {
      expect(resolveOrgScope(ctx("OWNER", status))).toEqual({
        ok: true,
        scope: { kind: "org", orgId: ORG },
      });
    }
  });

  it("an omitted orgStatus keeps today's behaviour", () => {
    // The gap, stated as a test so it cannot be forgotten: the resolver is
    // synchronous, so a caller that has not already awaited the Organization
    // row cannot supply the status at all. Until every caller passes it, the
    // data-layer half below is what actually closes the appointments feed.
    expect(resolveOrgScope(ctx("OWNER"))).toEqual({
      ok: true,
      scope: { kind: "org", orgId: ORG },
    });
  });

  it("still rejects a non-member before it looks at the org status", () => {
    const res = resolveOrgScope({
      ...ctx("OWNER", "DEACTIVATED"),
      memberships: [],
    });
    expect(res).toMatchObject({ ok: false, code: "ORG_MEMBERSHIP_REQUIRED" });
  });
});

describe("the org arm of the appointments list", () => {
  const w = buildWhere({
    scope: { kind: "org", orgId: ORG },
    userId: "u1",
  }) as Record<string, unknown>;

  it("hides rows whose org is no longer readable", () => {
    expect(w.organization).toMatchObject({
      is: { status: { in: ORG_SCOPE_READABLE_STATUSES } },
    });
  });

  it("leaves the admin/staff arm alone", () => {
    // An ADMIN reading a DEACTIVATED org is how a teardown gets verified, so
    // the visibility gate must not ride the `all` arm.
    const all = buildWhere({ scope: { kind: "all" }, userId: "u1" }) as Record<
      string,
      unknown
    >;
    expect(all.organization).toBeUndefined();
    expect(all.payment).toBeUndefined();
  });

  it("leaves orgMember alone — that arm is already the caller's own rows", () => {
    const member = buildWhere({
      scope: { kind: "orgMember", orgId: ORG, userId: "u1" },
      userId: "u1",
    }) as Record<string, unknown>;
    expect(member.organization).toBeUndefined();
  });

  it("personal is untouched: no org filter, no visibility gate", () => {
    const personal: Scope = { kind: "personal" };
    const p = buildWhere({ scope: personal, userId: "u1" }) as Record<
      string,
      unknown
    >;
    expect(p.organizationId).toBeNull();
    expect(p.organization).toBeUndefined();
  });
});

/**
 * @jest-environment node
 */

/**
 * SCOPE × CAPABILITY.
 *
 * The rule the whole permission design rests on: money acts are platform-only
 * at every scope, and two organisations in conflict are never judged by one
 * of them.
 */

import {
  actorScope,
  canActOnCase,
  disputeScope,
  type CaseActor,
  type CaseScope,
} from "../../lib/support/disputes/scope";

const orgAdmin: CaseActor = {
  userId: "org-admin-1",
  role: "CONSULTEE",
  orgRole: "OWNER",
  organizationId: "org-1",
};

const orgMember: CaseActor = {
  userId: "org-member-1",
  role: "CONSULTEE",
  orgRole: "LEARNER",
  organizationId: "org-1",
};

const staff: CaseActor = { userId: "staff-1", role: "STAFF" };
const admin: CaseActor = { userId: "admin-1", role: "ADMIN" };

describe("the scope resolver", () => {
  it("calls two organisations on one payment a counterparty dispute", () => {
    expect(
      disputeScope({ organizationId: "org-a", hostOrganizationId: "org-b" }),
    ).toBe("counterparty-org");
  });

  it("calls an organisation on one side platform money", () => {
    expect(
      disputeScope({ organizationId: "org-a", hostOrganizationId: null }),
    ).toBe("platform-money");
    expect(
      disputeScope({ organizationId: null, hostOrganizationId: "org-b" }),
    ).toBe("platform-money");
  });

  it("calls a personal payment platform money — the platform holds the escrow", () => {
    expect(
      disputeScope({ organizationId: null, hostOrganizationId: null }),
    ).toBe("platform-money");
  });

  it("treats the same organisation on both sides as one party, not two", () => {
    expect(
      disputeScope({ organizationId: "org-a", hostOrganizationId: "org-a" }),
    ).toBe("platform-money");
  });
});

describe("the matrix", () => {
  it("never lets an organisation execute a money act", () => {
    for (const scope of [
      "org",
      "individual",
      "platform-money",
      "counterparty-org",
    ] as CaseScope[]) {
      expect(canActOnCase(orgAdmin, scope, "execute")).toBe(false);
      expect(canActOnCase(orgMember, scope, "execute")).toBe(false);
    }
  });

  it("never lets an organisation decide a case where platform money is at stake", () => {
    expect(canActOnCase(orgAdmin, "platform-money", "decide")).toBe(false);
    expect(canActOnCase(orgAdmin, "counterparty-org", "decide")).toBe(false);
  });

  it("never lets an organisation decide a dispute between two organisations", () => {
    // An organisation admin may READ its own side — it is entitled to know
    // what happened — but it may never DECIDE.
    expect(canActOnCase(orgAdmin, "counterparty-org", "read")).toBe(true);
    expect(canActOnCase(orgAdmin, "counterparty-org", "decide")).toBe(false);
    // A plain member has no standing against another organisation at all.
    expect(canActOnCase(orgMember, "counterparty-org", "read")).toBe(false);
  });

  it("lets an organisation decide its OWN service quality", () => {
    expect(canActOnCase(orgAdmin, "org", "decide")).toBe(true);
    expect(canActOnCase(orgMember, "org", "decide")).toBe(false);
    expect(canActOnCase(orgMember, "org", "read")).toBe(true);
  });

  it("keeps staff investigating and resolving, and reserves the money for admins", () => {
    expect(canActOnCase(staff, "platform-money", "read")).toBe(true);
    expect(canActOnCase(staff, "platform-money", "investigate")).toBe(true);
    // Staff own support end-to-end, so they resolve a case…
    expect(canActOnCase(staff, "platform-money", "decide")).toBe(true);
    // …but they never move money.
    expect(canActOnCase(staff, "platform-money", "execute")).toBe(false);
    expect(canActOnCase(admin, "platform-money", "decide")).toBe(true);
    expect(canActOnCase(admin, "platform-money", "execute")).toBe(true);
  });

  it("gives a person with no organisation and no operator role nothing", () => {
    const stranger: CaseActor = { userId: "nobody", role: "CONSULTEE" };
    for (const scope of [
      "org",
      "individual",
      "platform-money",
      "counterparty-org",
    ] as CaseScope[]) {
      expect(canActOnCase(stranger, scope, "read")).toBe(false);
      expect(canActOnCase(stranger, scope, "decide")).toBe(false);
    }
  });
});

describe("the actor's scope", () => {
  it("puts a platform operator at the case's own scope", () => {
    // The platform acts at the platform's authority across every scope, so
    // the matrix's per-scope platform rows still apply.
    expect(actorScope(staff, "org")).toBe("org");
    expect(actorScope(admin, "counterparty-org")).toBe("counterparty-org");
  });

  it("keeps an organisation member inside their own organisation's scope", () => {
    expect(actorScope(orgAdmin, "org")).toBe("org");
    // A case at another organisation's scope stays out of their reach.
    expect(actorScope(orgAdmin, "counterparty-org")).toBe("counterparty-org");
    expect(canActOnCase(orgAdmin, "individual", "read")).toBe(false);
  });
});

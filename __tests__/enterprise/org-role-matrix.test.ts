/**
 * @jest-environment node
 */

/**
 * #1527 org role matrix — the API serves what the matrix grants, and every
 * changed guard reads the same key as the page/tab that shows it.
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { MemberRole } from "@prisma/client";

const mockRequireOrgAccess = jest.fn();
const mockProgramFindFirst = jest.fn();
const mockAssignmentFindMany = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    program: { findFirst: (...a: unknown[]) => mockProgramFindFirst(...a) },
    programAssignment: {
      findMany: (...a: unknown[]) => mockAssignmentFindMany(...a),
    },
  },
}));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireOrgAccess: (...a: unknown[]) => mockRequireOrgAccess(...a),
}));

import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { redactOrgDetailsForRole } from "@/lib/data/org-details-include";
import { auditRowScope } from "@/lib/enterprise/audit-visibility";
import { GET as listAssignments } from "../../app/api/organizations/[orgId]/programs/[programId]/assignments/route";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const API = "app/api/organizations/[orgId]";

describe("org-details money redaction (P0-1)", () => {
  const row = {
    billingAccount: { walletBalance: 5_000, creditLimit: 9_000 },
    payoutAccount: { bankName: "HDFC", accountNumberLast4: "1234" },
  };

  it.each<[MemberRole, boolean, boolean]>([
    ["OWNER", true, true],
    ["BILLING_ADMIN", true, true],
    ["SUPPORT", false, false],
    ["EXPERT", false, false],
    ["LEARNER", false, false],
  ])("%s wallet=%s payout=%s", (role, wallet, payout) => {
    const out = redactOrgDetailsForRole(row, role);
    expect(out.billingAccount?.walletBalance !== null).toBe(wallet);
    expect(out.billingAccount?.creditLimit !== null).toBe(wallet);
    expect(out.payoutAccount?.bankName !== null).toBe(payout);
    expect(out.payoutAccount?.accountNumberLast4 !== null).toBe(payout);
  });
});

describe("program roster is programs.read; everyone else sees own (P0-2)", () => {
  const params = { params: Promise.resolve({ orgId: "o", programId: "p" }) };
  const req = () =>
    new Request("http://x/api?membershipId=someone-else") as never;

  beforeEach(() => {
    mockProgramFindFirst.mockResolvedValue({ id: "p" });
    mockAssignmentFindMany.mockResolvedValue([
      { id: "a", membershipId: "me", consumedPaise: 700 },
    ]);
  });

  it.each<MemberRole>(["EXPERT", "LEARNER", "SUPPORT"])(
    "%s gets only their own rows, without spend",
    async (role) => {
      mockRequireOrgAccess.mockResolvedValue({
        member: { id: "me", role },
        org: { canSponsor: true },
      });
      const res = await listAssignments(req(), params);
      const where = mockAssignmentFindMany.mock.calls[0][0].where;
      expect(where.membershipId).toBe("me");
      expect((await res.json()).data[0]).not.toHaveProperty("consumedPaise");
    },
  );

  it("MANAGER reads the roster it asked for", async () => {
    mockRequireOrgAccess.mockResolvedValue({
      member: { id: "me", role: "MANAGER" },
      org: { canSponsor: true },
    });
    await listAssignments(req(), params);
    expect(mockAssignmentFindMany.mock.calls[0][0].where.membershipId).toBe(
      "someone-else",
    );
  });
});

describe("audit category split (P0-6)", () => {
  it("SUPPORT never gets a money row; BILLING_ADMIN gets only money rows", () => {
    expect(auditRowScope("SUPPORT")).toHaveProperty("NOT");
    expect(auditRowScope("MANAGER")).toHaveProperty("NOT");
    expect(auditRowScope("BILLING_ADMIN")).toHaveProperty("OR");
    expect(auditRowScope("OWNER")).toEqual({});
    expect(auditRowScope("LEARNER")).toBeNull();
  });

  it.each(["audit/route.ts", "audit/export/route.ts", "activity/route.ts"])(
    "%s filters through auditRowScope",
    (file) => {
      expect(read(`${API}/${file}`)).toContain("AND: [rowScope]");
    },
  );
});

describe("route guards read matrix keys, not ranks (P0-3, P0-4)", () => {
  it.each([
    ["settings/route.ts", '["settings.manage", "billing.manage"]'],
    ["sso/route.ts", '"identity.read"'],
    ["sso/providers/route.ts", '"identity.read"'],
    ["sso/providers/[providerId]/route.ts", '"identity.read"'],
    ["domain-claims/route.ts", '"identity.read"'],
    ["webhooks/route.ts", '"integrations.manage"'],
    ["webhooks/[endpointId]/route.ts", '"integrations.manage"'],
    ["webhooks/[endpointId]/deliveries/route.ts", '"integrations.manage"'],
    ["activity/route.ts", '"activity.read"'],
    ["stream/channels/route.ts", '"messaging.read"'],
    ["stream/calls/route.ts", '"messaging.read"'],
    ["members/[memberId]/route.ts", '"members.read"'],
  ])("%s → %s", (file, key) => {
    const src = read(`${API}/${file}`);
    expect(src).toContain(key);
    expect(src).not.toMatch(/requireOrgAccess\(orgId, "(MANAGER|LEARNER)"\)/);
    expect(src).not.toMatch(/minimumRole: "(MANAGER|LEARNER)"/);
  });

  it("the Settings GET floor holds only for General and Billing contacts", () => {
    for (const role of ["MANAGER", "SUPPORT", "EXPERT", "LEARNER"] as const) {
      expect(hasOrgPermission(role, "settings.manage")).toBe(false);
      expect(hasOrgPermission(role, "billing.manage")).toBe(false);
    }
  });

  it("BILLING_ADMIN is refused identity and org chat reads", () => {
    expect(hasOrgPermission("BILLING_ADMIN", "identity.read")).toBe(false);
    expect(hasOrgPermission("BILLING_ADMIN", "messaging.read")).toBe(false);
    expect(hasOrgPermission("BILLING_ADMIN", "activity.read")).toBe(false);
  });
});

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
const mockAuditFindMany = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    program: { findFirst: (...a: unknown[]) => mockProgramFindFirst(...a) },
    programAssignment: {
      findMany: (...a: unknown[]) => mockAssignmentFindMany(...a),
    },
    orgAuditLog: { findMany: (...a: unknown[]) => mockAuditFindMany(...a) },
  },
}));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireOrgAccess: (...a: unknown[]) => mockRequireOrgAccess(...a),
}));

import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { redactOrgDetailsForRole } from "@/lib/data/org-details-include";
import { auditRowScope } from "@/lib/enterprise/audit-visibility";
import {
  canHandleExportKind,
  dataExportKindsFor,
} from "@/lib/enterprise/data-export-kinds";
import { getInvitableRoles } from "@/lib/labels/org-labels";
import { GET as listAssignments } from "../../app/api/organizations/[orgId]/programs/[programId]/assignments/route";
import { GET as getAudit } from "../../app/api/organizations/[orgId]/audit/route";
import {
  DELETE as deleteConsent,
  GET as getConsent,
  POST as postConsent,
} from "../../app/api/organizations/[orgId]/consent/route";
import { dataConsentHref } from "@/lib/dashboard/account-href";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const ROLES: MemberRole[] = [
  "OWNER",
  "MAINTAINER",
  "BILLING_ADMIN",
  "MANAGER",
  "SUPPORT",
  "EXPERT",
  "LEARNER",
];
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

  it("accepts the WEBHOOK filter the page offers, inside the row scope (#1527 3c)", async () => {
    mockRequireOrgAccess.mockResolvedValue({
      session: { user: { id: "ba-user" } },
      member: { id: "m-ba", role: "BILLING_ADMIN" },
      org: { id: "o" },
    });
    mockAuditFindMany.mockResolvedValue([]);
    const res = await getAudit(
      new Request("http://x/api?categories=WEBHOOK") as never,
      { params: Promise.resolve({ orgId: "o" }) },
    );
    expect(res.status).toBe(200);
    const { where } = mockAuditFindMany.mock.calls[0][0];
    expect(where.category).toEqual({ in: ["WEBHOOK"] });
    expect(where.AND).toEqual([auditRowScope("BILLING_ADMIN")]);
    expect(read(`${API}/audit/export/route.ts`)).toContain(
      "z.nativeEnum(OrgAuditCategory)",
    );
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

describe("role matrix decisions (#1527 decisions 1–8)", () => {
  it("MANAGER keeps read-only Billing but loses Payouts (decision 1)", () => {
    expect(hasOrgPermission("MANAGER", "billing.read")).toBe(true);
    expect(hasOrgPermission("MANAGER", "billing.manage")).toBe(false);
    expect(hasOrgPermission("MANAGER", "payouts.read")).toBe(false);
    const out = redactOrgDetailsForRole(
      {
        billingAccount: { walletBalance: 1, creditLimit: 2 },
        payoutAccount: { bankName: "HDFC", accountNumberLast4: "1234" },
      },
      "MANAGER",
    );
    expect(out.billingAccount?.walletBalance).toBe(1);
    expect(out.payoutAccount?.bankName).toBeNull();
  });

  it("every member reads the names-only directory; only operators the roster (decision 3)", () => {
    for (const role of ROLES) {
      expect(hasOrgPermission(role, "members.directory")).toBe(true);
    }
    expect(hasOrgPermission("EXPERT", "members.read")).toBe(false);
    expect(hasOrgPermission("BILLING_ADMIN", "members.read")).toBe(false);
    const route = read(`${API}/members/directory/route.ts`);
    expect(route).toContain('permission: "members.directory"');
    expect(route).not.toContain("email: true");
  });

  it("export kinds split people (OW, MT) from finance (OW, BA) (decision 4)", () => {
    expect(dataExportKindsFor("OWNER")).toEqual(["PEOPLE", "FINANCE"]);
    expect(dataExportKindsFor("MAINTAINER")).toEqual(["PEOPLE"]);
    expect(dataExportKindsFor("BILLING_ADMIN")).toEqual(["FINANCE"]);
    expect(dataExportKindsFor("MANAGER")).toEqual([]);
    expect(canHandleExportKind("MAINTAINER", "FINANCE")).toBe(false);
    // A pre-split FULL job: only a holder of both kinds.
    expect(canHandleExportKind("BILLING_ADMIN", "FULL")).toBe(false);
    expect(canHandleExportKind("OWNER", "FULL")).toBe(true);
    for (const file of [
      "data-exports/route.ts",
      "data-exports/[exportId]/download/route.ts",
    ]) {
      expect(read(`${API}/${file}`)).toContain("canHandleExportKind(");
    }
    // #1527 3c — the kind is a job column, written on create.
    expect(read(`${API}/data-exports/route.ts`)).toMatch(
      /orgDataExportJob\.create\(\{\s*data: \{[^}]*\bkind,/,
    );
  });

  it("an operator can't grant or withdraw a member's consent (decision 5)", async () => {
    mockRequireOrgAccess.mockResolvedValue({
      session: { user: { id: "operator-user" } },
      member: { id: "m-op", role: "OWNER" },
      org: { id: "o" },
    });
    const res = await postConsent(
      new Request("http://x/api", {
        method: "POST",
        body: JSON.stringify({
          userId: "someone-else",
          purposeCodes: ["PRIMARY_PROCESSING"],
          language: "en",
          version: 1,
        }),
      }) as never,
      { params: Promise.resolve({ orgId: "o" }) },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("CONSENT_GRANT_SELF_ONLY");
    // Nor withdraw it: operators only record the member's request.
    const params = { params: Promise.resolve({ orgId: "o" }) };
    const del = await deleteConsent(
      new Request(
        "http://x/api?userId=someone-else&purposeCode=SESSION_BOOKING",
        {
          method: "DELETE",
        },
      ) as never,
      params,
    );
    expect((await del.json()).code).toBe("CONSENT_WITHDRAW_SELF_ONLY");
    // Self-withdraw names a purpose — no silent withdraw-all.
    const all = await deleteConsent(
      new Request("http://x/api", { method: "DELETE" }) as never,
      params,
    );
    expect(all.status).toBe(400);
    expect(hasOrgPermission("MANAGER", "consent.requestWithdrawal")).toBe(true);
  });

  it("a member reads + withdraws only their own consent (#1527 3c)", async () => {
    mockRequireOrgAccess.mockResolvedValue({
      session: { user: { id: "learner-user" } },
      member: { id: "m-le", role: "LEARNER" },
      org: { id: "o" },
    });
    const params = { params: Promise.resolve({ orgId: "o" }) };
    const url = "http://x/api?userId=someone-else&purposeCode=SESSION_BOOKING";
    const read403 = await getConsent(new Request(url) as never, params);
    expect((await read403.json()).code).toBe("CONSENT_READ_SELF_ONLY");
    const del = await deleteConsent(
      new Request(url, { method: "DELETE" }) as never,
      params,
    );
    expect(del.status).toBe(403);
    expect(dataConsentHref({ consulteeProfileId: "c1" })).toBe(
      "/dashboard/consultee/c1/settings/account#data-consent",
    );
  });

  it("non-owners are never offered OWNER; SUPPORT is invitable (P1-7)", () => {
    expect(getInvitableRoles("MAINTAINER", true, true)).not.toContain("OWNER");
    // #1851 decision 6 — nor MAINTAINER or BILLING_ADMIN.
    expect(getInvitableRoles("MAINTAINER", true, true)).not.toContain(
      "BILLING_ADMIN",
    );
    expect(getInvitableRoles("MAINTAINER", true, true)).toContain("SUPPORT");
    expect(getInvitableRoles("OWNER", true, true)).toContain("OWNER");
  });

  it("MAINTAINER manages branding, reads identity; secrets stay OWNER (decision 7)", () => {
    expect(hasOrgPermission("MAINTAINER", "settings.manage")).toBe(true);
    expect(hasOrgPermission("MAINTAINER", "identity.read")).toBe(true);
    expect(read(`${API}/branding/[asset]/route.ts`)).toContain(
      'permission: "settings.manage"',
    );
    const ssoProviders = read(`${API}/sso/providers/route.ts`);
    expect(ssoProviders.split("export async function POST")[1]).toContain(
      'permission: "identity.manage"',
    );
    expect(hasOrgPermission("MAINTAINER", "identity.manage")).toBe(false);
  });

  it("MANAGER assigns seats; design stays GOVERNANCE (decision 8)", () => {
    expect(hasOrgPermission("MANAGER", "programs.assign")).toBe(true);
    expect(hasOrgPermission("MANAGER", "programs.manage")).toBe(false);
    expect(hasOrgPermission("BILLING_ADMIN", "programs.assign")).toBe(false);
  });
});

/**
 * Parity: each changed API guard reads the same key as the page or tab that
 * shows the surface, so the UI never offers what the route refuses.
 */
describe("API guard ↔ page/tab gate parity (#1527)", () => {
  const DASH = "app/dashboard/organization/[orgId]";
  it.each([
    [
      `${API}/programs/[programId]/assignments/route.ts`,
      "programs.assign",
      `${DASH}/programs/page.tsx`,
    ],
    [
      `${API}/programs/[programId]/auto-enroll/route.ts`,
      "programs.assign",
      `${DASH}/programs/page.tsx`,
    ],
    [`${API}/programs/route.ts`, "programs.read", `${DASH}/programs/page.tsx`],
    [
      `${API}/earnings/route.ts`,
      "payouts.read",
      `${DASH}/payouts/PayoutsPageClient.tsx`,
    ],
    [
      `${API}/payout-account/route.ts`,
      "payouts.read",
      `${DASH}/payouts/PayoutsPageClient.tsx`,
    ],
    [
      `${API}/sso/route.ts`,
      "identity.read",
      "lib/dashboard/org-settings-sections.ts",
    ],
    [
      `${API}/branding/[asset]/route.ts`,
      "settings.manage",
      "lib/dashboard/org-settings-sections.ts",
    ],
    [
      `${API}/audit/export/route.ts`,
      "dataExports.people",
      `${DASH}/audit/page.tsx`,
    ],
    [`${API}/consent/route.ts`, "consent.read", `${DASH}/consent/page.tsx`],
    [
      `${API}/members/directory/route.ts`,
      "members.directory",
      `${DASH}/members/MembersTabs.tsx`,
    ],
    // #1527 — payout routing on member rows is shaped by payouts.read.
    [`${API}/members/route.ts`, "payouts.read", `${DASH}/members/page.tsx`],
  ])("%s ↔ %s", (route, key, gate) => {
    expect(read(route)).toContain(`"${key}"`);
    expect(read(gate)).toContain(`"${key}"`);
  });
});

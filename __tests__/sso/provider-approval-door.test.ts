/**
 * @jest-environment node
 */

/**
 * The approval door is the only writer of SsoProvider.domainVerified. Approve
 * re-checks a verified DNS claim for every covered domain; revoke needs none;
 * both write the OpsActionLog row in the transaction and email the OWNERs after.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
const sendSsoProviderDecisionEmail = jest.fn(async (_a: unknown) => ({}));
jest.mock("../../lib/email", () => ({
  sendSsoProviderDecisionEmail: (a: unknown) => sendSsoProviderDecisionEmail(a),
}));
const scheduled: Array<() => unknown> = [];
jest.mock("../../lib/api/after-safe", () => ({
  scheduleAfter: (task: () => unknown) => scheduled.push(task),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: { user: { id: "admin_1", role: "ADMIN" } },
  })),
}));

const tx = {
  ssoProvider: { findFirst: jest.fn(), update: jest.fn(), count: jest.fn() },
  orgDomainClaim: { findMany: jest.fn() },
  organizationSSOSettings: { findUnique: jest.fn() },
  opsActionLog: { create: jest.fn(async () => ({ id: "row" })) },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
  },
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/organizations/[orgId]/sso-providers/[providerId]/approval/route";

const call = (body: unknown) =>
  POST(
    new NextRequest("https://x.test/api", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ orgId: "org_1", providerId: "oidc-abc" }) },
  );

const PROVIDER = {
  id: "row_1",
  domain: "acme.co.in,acme.com",
  issuer: "https://idp.acme.com",
  organization: { name: "Acme" },
};

beforeEach(() => {
  jest.clearAllMocks();
  scheduled.length = 0;
  tx.ssoProvider.findFirst.mockResolvedValue({
    ...PROVIDER,
    domainVerified: false,
  });
});

it("approves when the org holds a verified claim for every covered domain, then emails the owners", async () => {
  tx.orgDomainClaim.findMany.mockResolvedValue([
    { domain: "acme.com" },
    { domain: "acme.co.in" },
  ]);

  const res = await call({ approve: true, reason: "checked the DNS record" });

  expect(res.status).toBe(200);
  expect(tx.ssoProvider.update).toHaveBeenCalledWith({
    where: { id: "row_1" },
    data: { domainVerified: true },
  });
  expect(tx.opsActionLog.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        action: "sso-provider.approve",
        surface: "organizations.manage",
        targetKind: "SsoProvider",
        targetId: "row_1",
        before: { domainVerified: false },
        after: { domainVerified: true },
      }),
    }),
  );
  expect(tx.orgDomainClaim.findMany).toHaveBeenCalledWith({
    where: {
      organizationId: "org_1",
      domain: { in: ["acme.co.in", "acme.com"] },
      verifiedAt: { not: null },
    },
    select: { domain: true },
  });
  expect(scheduled).toHaveLength(1);
  await scheduled[0]();
  expect(sendSsoProviderDecisionEmail).toHaveBeenCalledWith(
    expect.objectContaining({
      organizationId: "org_1",
      orgName: "Acme",
      providerId: "oidc-abc",
      domains: ["acme.co.in", "acme.com"],
      approved: true,
    }),
  );
});

it.each([
  ["no verified claim", []],
  ["a verified claim for only one of its domains", [{ domain: "acme.com" }]],
])("refuses to approve with %s and writes nothing", async (_label, claims) => {
  tx.orgDomainClaim.findMany.mockResolvedValue(claims);

  const res = await call({ approve: true, reason: "checked the DNS record" });

  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("DOMAIN_NOT_VERIFIED");
  expect(tx.ssoProvider.update).not.toHaveBeenCalled();
  expect(tx.opsActionLog.create).not.toHaveBeenCalled();
  expect(scheduled).toHaveLength(0);
});

it("revokes without consulting the claim", async () => {
  const res = await call({ approve: false, reason: "customer asked us to" });

  expect(res.status).toBe(200);
  expect(tx.orgDomainClaim.findMany).not.toHaveBeenCalled();
  expect(tx.ssoProvider.update).toHaveBeenCalledWith({
    where: { id: "row_1" },
    data: { domainVerified: false },
  });
});

it("404s a provider that is not this org's", async () => {
  tx.ssoProvider.findFirst.mockResolvedValue(null);

  const res = await call({ approve: true, reason: "checked the DNS record" });

  expect(res.status).toBe(404);
  expect(tx.ssoProvider.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { providerId: "oidc-abc", organizationId: "org_1" },
    }),
  );
});

describe("revoking an approved provider", () => {
  beforeEach(() => {
    tx.ssoProvider.findFirst.mockResolvedValue({
      ...PROVIDER,
      domainVerified: true,
    });
  });

  it("refuses the last one while SSO is enforced", async () => {
    tx.organizationSSOSettings.findUnique.mockResolvedValue({
      enforceSSO: true,
    });
    tx.ssoProvider.count.mockResolvedValue(1);

    const res = await call({ approve: false, reason: "customer asked us to" });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("LAST_APPROVED_SSO_PROVIDER");
    expect(tx.ssoProvider.update).not.toHaveBeenCalled();
  });

  it.each([
    ["enforcement is off", { enforceSSO: false }, 1],
    ["another approved provider remains", { enforceSSO: true }, 2],
  ])("allows it when %s", async (_label, settings, approved) => {
    tx.organizationSSOSettings.findUnique.mockResolvedValue(settings);
    tx.ssoProvider.count.mockResolvedValue(approved);

    const res = await call({ approve: false, reason: "customer asked us to" });

    expect(res.status).toBe(200);
    expect(tx.ssoProvider.update).toHaveBeenCalled();
  });
});

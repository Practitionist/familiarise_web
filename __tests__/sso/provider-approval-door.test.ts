/**
 * @jest-environment node
 */

/**
 * D10b — the approval door is the only writer of SsoProvider.domainVerified.
 * Approve must re-check the org's verified DNS claim; revoke must not need
 * one; both write the OpsActionLog row in the same transaction.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: { user: { id: "admin_1", role: "ADMIN" } },
  })),
}));

const tx = {
  ssoProvider: { findFirst: jest.fn(), update: jest.fn() },
  orgDomainClaim: { findUnique: jest.fn() },
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

beforeEach(() => {
  jest.clearAllMocks();
  tx.ssoProvider.findFirst.mockResolvedValue({
    id: "row_1",
    domain: "acme.com",
    domainVerified: false,
  });
});

it("approves when the org holds a verified claim for the provider's domain", async () => {
  tx.orgDomainClaim.findUnique.mockResolvedValue({
    organizationId: "org_1",
    verifiedAt: new Date(),
  });

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
});

it.each([
  ["no claim", null],
  ["another org's claim", { organizationId: "org_2", verifiedAt: new Date() }],
  ["an unverified claim", { organizationId: "org_1", verifiedAt: null }],
])("refuses to approve with %s and writes nothing", async (_label, claim) => {
  tx.orgDomainClaim.findUnique.mockResolvedValue(claim);

  const res = await call({ approve: true, reason: "checked the DNS record" });

  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("DOMAIN_NOT_VERIFIED");
  expect(tx.ssoProvider.update).not.toHaveBeenCalled();
  expect(tx.opsActionLog.create).not.toHaveBeenCalled();
});

it("revokes without consulting the claim", async () => {
  const res = await call({ approve: false, reason: "customer asked us to" });

  expect(res.status).toBe(200);
  expect(tx.orgDomainClaim.findUnique).not.toHaveBeenCalled();
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

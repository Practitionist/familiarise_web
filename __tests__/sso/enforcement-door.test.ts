/**
 * @jest-environment node
 */

/**
 * Staff turn an org's SSO enforcement on or off. Off is the recovery path
 * for a broken IdP; on needs an approved provider. Both bump the settings
 * version and write the OpsActionLog row in the same transaction.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: { user: { id: "admin_1", role: "ADMIN" } },
  })),
}));

const tx = {
  organization: { findUnique: jest.fn() },
  ssoProvider: { count: jest.fn(), findMany: jest.fn(async () => []) },
  organizationSSOSettings: {
    findUnique: jest.fn(),
    upsert: jest.fn(async () => ({ id: "settings_1" })),
  },
  orgDomainClaim: { findMany: jest.fn(async () => []) },
  membership: { findMany: jest.fn(async () => []) },
  session: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  opsActionLog: { create: jest.fn(async () => ({ id: "row" })) },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
  },
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/organizations/[orgId]/sso-enforcement/route";

const call = (body: unknown) =>
  POST(
    new NextRequest("https://x.test/api", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ orgId: "org_1" }) },
  );

beforeEach(() => {
  jest.clearAllMocks();
  tx.organization.findUnique.mockResolvedValue({ id: "org_1" });
});

it("answers 404 for an organization that does not exist", async () => {
  tx.organization.findUnique.mockResolvedValue(null);

  const res = await call({ enforce: false, reason: "their IdP is down" });

  expect(res.status).toBe(404);
  expect((await res.json()).code).toBe("ORGANIZATION_NOT_FOUND");
  expect(tx.organizationSSOSettings.upsert).not.toHaveBeenCalled();
});

it("turns enforcement off, bumping the version, and logs it", async () => {
  tx.organizationSSOSettings.findUnique.mockResolvedValue({ enforceSSO: true });

  const res = await call({ enforce: false, reason: "their IdP is down" });

  expect(res.status).toBe(200);
  expect(tx.ssoProvider.count).not.toHaveBeenCalled();
  expect(tx.organizationSSOSettings.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { organizationId: "org_1" },
      update: { enforceSSO: false, version: { increment: 1 } },
    }),
  );
  expect(tx.opsActionLog.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        action: "sso-enforcement.disable",
        surface: "organizations.manage",
        targetKind: "OrganizationSSOSettings",
        before: { enforceSSO: true },
        after: { enforceSSO: false },
      }),
    }),
  );
});

it("refuses to turn enforcement on without an approved provider", async () => {
  tx.ssoProvider.count.mockResolvedValue(0);

  const res = await call({ enforce: true, reason: "customer asked us to" });

  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("NO_APPROVED_SSO_PROVIDER");
  expect(tx.organizationSSOSettings.upsert).not.toHaveBeenCalled();
  expect(tx.opsActionLog.create).not.toHaveBeenCalled();
});

it("refuses to turn enforcement on until an owner has proven a provider", async () => {
  // approved = 1, proven = 0
  tx.ssoProvider.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

  const res = await call({ enforce: true, reason: "customer asked us to" });

  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("SSO_NOT_PROVEN");
  expect(tx.ssoProvider.count).toHaveBeenLastCalledWith({
    where: {
      organizationId: "org_1",
      domainVerified: true,
      provenAt: { not: null },
    },
  });
  expect(tx.organizationSSOSettings.upsert).not.toHaveBeenCalled();
});

it("turns enforcement on when a provider is approved and proven", async () => {
  tx.ssoProvider.count.mockResolvedValue(1);
  tx.organizationSSOSettings.findUnique
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ enforceSSO: true });

  const res = await call({ enforce: true, reason: "customer asked us to" });

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ enforceSSO: true });
});

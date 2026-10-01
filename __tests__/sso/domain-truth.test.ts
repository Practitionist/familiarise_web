/**
 * @jest-environment node
 */

/**
 * One domain truth (D20/D21): enforcement covers the org's verified
 * OrgDomainClaims and only bites through a staff-approved provider, so the
 * routes refuse to leave enforcement on with no approved provider.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgSsoProviderDeleted: jest.fn(async () => undefined),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(async () => ({
    member: { id: "m_1" },
    org: { name: "Acme" },
    session: { user: { name: "Owner", email: "o@acme.com" } },
  })),
}));
jest.mock("../../lib/enterprise/governance", () => ({
  DomainVerificationRequiredError: class extends Error {},
  hasVerifiedDomain: jest.fn(async () => true),
}));

const tx = {
  ssoProvider: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    delete: jest.fn(),
    updateMany: jest.fn(),
  },
  organizationSSOSettings: {
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
  },
  orgDomainClaim: { findUnique: jest.fn(), delete: jest.fn() },
  orgAuditLog: { create: jest.fn() },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) },
}));

import { NextRequest } from "next/server";
import { DELETE as deleteProvider } from "@/app/api/organizations/[orgId]/sso/providers/[providerId]/route";
import { PATCH as patchSettings } from "@/app/api/organizations/[orgId]/sso/route";

const req = (method: string, body?: unknown) =>
  new NextRequest("https://x.test/api", {
    method,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  jest.clearAllMocks();
  tx.organizationSSOSettings.findUnique.mockResolvedValue({
    enforceSSO: true,
    version: 1,
  });
  tx.organizationSSOSettings.updateMany.mockResolvedValue({ count: 1 });
});

describe("DELETE provider", () => {
  const call = () =>
    deleteProvider(req("DELETE"), {
      params: Promise.resolve({ orgId: "org_1", providerId: "oidc-a" }),
    });

  beforeEach(() => {
    tx.ssoProvider.findFirst.mockResolvedValue({
      id: "row_a",
      domain: "acme.com",
      issuer: "https://idp",
      domainVerified: true,
    });
  });

  it("refuses to delete the last approved provider while SSO is enforced", async () => {
    tx.ssoProvider.count.mockResolvedValue(0);
    const res = await call();
    expect(res.status).toBe(409);
    expect(tx.ssoProvider.delete).not.toHaveBeenCalled();
  });

  it("deletes when another approved provider remains", async () => {
    tx.ssoProvider.count.mockResolvedValue(1);
    const res = await call();
    expect(res.status).toBe(204);
    expect(tx.ssoProvider.delete).toHaveBeenCalledWith({
      where: { id: "row_a" },
    });
  });
});

describe("PATCH settings", () => {
  const call = (body: unknown) =>
    patchSettings(req("PATCH", body), {
      params: Promise.resolve({ orgId: "org_1" }),
    });

  it("refuses to enforce SSO before any provider is approved", async () => {
    tx.ssoProvider.count.mockResolvedValue(0);
    const res = await call({ enforceSSO: true });
    expect(res.status).toBe(409);
    expect(tx.ssoProvider.count).toHaveBeenCalledWith({
      where: { organizationId: "org_1", domainVerified: true },
    });
    expect(tx.organizationSSOSettings.upsert).not.toHaveBeenCalled();
  });

  it("rejects the removed allowedEmailDomains field as an empty body", async () => {
    const res = await call({ allowedEmailDomains: ["acme.com"] });
    expect(res.status).toBe(400);
  });
});

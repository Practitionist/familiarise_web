/**
 * @jest-environment node
 */

/**
 * Provider lifecycle: enforce-on needs a provider an OWNER has signed in
 * through and spares the enabling OWNER's session; the first OWNER login
 * stamps the proof once; PATCH rotates the client secret in place and clears
 * the proof, refusing while it is the only proven provider of an enforcing org.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgSsoProviderDeleted: jest.fn(async () => undefined),
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(async () => ({
    member: { id: "m_owner" },
    org: { name: "Acme" },
    session: {
      session: { id: "sess_owner" },
      user: { name: "Owner", email: "o@acme.com" },
    },
  })),
}));
jest.mock("../../lib/enterprise/governance", () => ({
  DomainVerificationRequiredError: class extends Error {},
  hasVerifiedDomain: jest.fn(async () => true),
}));
const revokeEnforcedDomainSessions = jest.fn(async (..._a: unknown[]) => 0);
jest.mock("../../lib/sso/session-sweeps", () => ({
  revokeEnforcedDomainSessions: (...a: unknown[]) =>
    revokeEnforcedDomainSessions(...a),
}));
jest.mock("../../lib/sso/secret-crypto", () => ({
  isEncryptionKeyUsable: () => true,
  encryptSecretPayload: (payload: unknown) =>
    `sso:v1:${JSON.stringify(payload)}`,
}));

const tx = {
  ssoProvider: {
    count: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(async () => []),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
  organizationSSOSettings: {
    findUnique: jest.fn(),
    updateMany: jest.fn(async () => ({ count: 1 })),
    upsert: jest.fn(async () => ({
      enforceSSO: true,
      defaultRoleForAutoJoin: "LEARNER",
    })),
  },
  orgDomainClaim: { findMany: jest.fn(async () => []) },
  orgAuditLog: { create: jest.fn() },
};
const db = {
  ...tx,
  membership: { findFirst: jest.fn() },
  $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return db;
  },
}));

import { NextRequest } from "next/server";
import { PATCH as patchSettings } from "@/app/api/organizations/[orgId]/sso/route";
import { PATCH as patchProvider } from "@/app/api/organizations/[orgId]/sso/providers/[providerId]/route";
import { stampProviderProven } from "@/lib/sso/provider-proof";

const req = (body: unknown) =>
  new NextRequest("https://x.test/api", {
    method: "PATCH",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  jest.clearAllMocks();
  tx.organizationSSOSettings.findUnique.mockResolvedValue({
    enforceSSO: false,
    defaultRoleForAutoJoin: "LEARNER",
    version: 1,
  });
});

describe("prove before enforce", () => {
  const call = (body: unknown) =>
    patchSettings(req(body), { params: Promise.resolve({ orgId: "org_1" }) });

  it("answers 409 SSO_NOT_PROVEN while no approved provider has an owner login", async () => {
    tx.ssoProvider.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const res = await call({ enforceSSO: true });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SSO_NOT_PROVEN");
    expect(tx.organizationSSOSettings.upsert).not.toHaveBeenCalled();
    expect(revokeEnforcedDomainSessions).not.toHaveBeenCalled();
  });

  it("enforces once proven, signing out the domain but not the enabling owner", async () => {
    tx.ssoProvider.count.mockResolvedValue(1);

    const res = await call({ enforceSSO: true });

    expect(res.status).toBe(200);
    expect(revokeEnforcedDomainSessions).toHaveBeenCalledWith(tx, "org_1", {
      keepSessionId: "sess_owner",
    });
  });
});

describe("stampProviderProven", () => {
  const input = {
    providerId: "oidc-a",
    organizationId: "org_1",
    userId: "u_1",
  };

  it("stamps the first OWNER login once (CAS on provenAt null)", async () => {
    db.membership.findFirst.mockResolvedValue({ id: "m_1" });

    await expect(stampProviderProven(input)).resolves.toBe(true);
    expect(db.membership.findFirst).toHaveBeenCalledWith({
      where: {
        userId: "u_1",
        organizationId: "org_1",
        role: "OWNER",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    expect(tx.ssoProvider.updateMany).toHaveBeenCalledWith({
      where: {
        providerId: "oidc-a",
        organizationId: "org_1",
        domainVerified: true,
        provenAt: null,
      },
      data: { provenAt: expect.any(Date), provenByUserId: "u_1" },
    });
  });

  it("ignores a non-owner login", async () => {
    db.membership.findFirst.mockResolvedValue(null);

    await expect(stampProviderProven(input)).resolves.toBe(false);
    expect(tx.ssoProvider.updateMany).not.toHaveBeenCalled();
  });
});

describe("PATCH provider (secret rotation)", () => {
  const call = (body: unknown) =>
    patchProvider(req(body), {
      params: Promise.resolve({ orgId: "org_1", providerId: "oidc-a" }),
    });
  const updatedAt = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    tx.ssoProvider.findFirst.mockResolvedValue({
      id: "row_a",
      domain: "acme.com",
      updatedAt,
      oidcConfig: { clientId: "cid", clientSecret: "old", pkce: true },
      domainVerified: true,
      provenAt: new Date("2026-01-02T00:00:00Z"),
    });
  });

  it("re-encrypts the new secret in place, keeps providerId and approval, and audits it", async () => {
    const res = await call({ clientSecret: "new-secret" });

    expect(res.status).toBe(200);
    expect(tx.ssoProvider.updateMany).toHaveBeenCalledWith({
      where: { id: "row_a", updatedAt },
      data: {
        oidcConfig: `sso:v1:${JSON.stringify({
          clientId: "cid",
          clientSecret: "new-secret",
          pkce: true,
        })}`,
        provenAt: null,
        provenByUserId: null,
      },
    });
    expect(tx.orgAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "SSO_PROVIDER_UPDATED",
        details: { providerId: "oidc-a", secretRotated: true },
      }),
    });
    expect(revokeEnforcedDomainSessions).not.toHaveBeenCalled();
  });

  it("refuses rotating the only proven provider of an enforcing org", async () => {
    tx.organizationSSOSettings.findUnique.mockResolvedValue({
      enforceSSO: true,
      defaultRoleForAutoJoin: "LEARNER",
      version: 1,
    });
    tx.ssoProvider.count.mockResolvedValue(0);

    const res = await call({ clientSecret: "new-secret" });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SSO_ENFORCED_REPROVE");
    expect(tx.ssoProvider.count).toHaveBeenCalledWith({
      where: {
        organizationId: "org_1",
        domainVerified: true,
        provenAt: { not: null },
        id: { not: "row_a" },
      },
    });
    expect(tx.ssoProvider.updateMany).not.toHaveBeenCalled();
  });

  it("rotates under enforcement when another proven provider remains", async () => {
    tx.organizationSSOSettings.findUnique.mockResolvedValue({
      enforceSSO: true,
      defaultRoleForAutoJoin: "LEARNER",
      version: 1,
    });
    tx.ssoProvider.count.mockResolvedValue(1);

    const res = await call({ clientSecret: "new-secret" });

    expect(res.status).toBe(200);
    expect(tx.ssoProvider.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provenAt: null, provenByUserId: null }),
      }),
    );
  });

  it("answers 409 on a concurrent edit", async () => {
    tx.ssoProvider.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await call({ clientSecret: "new-secret" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("VERSION_CONFLICT");
  });

  it("refuses an unreadable stored config", async () => {
    tx.ssoProvider.findFirst.mockResolvedValue({
      id: "row_a",
      domain: "acme.com",
      updatedAt,
      oidcConfig: null,
    });
    const res = await call({ clientSecret: "new-secret" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("SSO_PROVIDER_MISCONFIGURED");
  });

  it("adds a verified domain and sweeps sessions on the newly covered one", async () => {
    tx.orgDomainClaim.findMany.mockResolvedValue([
      { domain: "acme.com", verifiedAt: new Date() },
      { domain: "acme.co.in", verifiedAt: new Date() },
    ] as never);

    const res = await call({ domains: ["acme.com", "ACME.co.in"] });

    expect(res.status).toBe(200);
    expect(tx.ssoProvider.updateMany).toHaveBeenCalledWith({
      where: { id: "row_a", updatedAt },
      data: { domain: "acme.co.in,acme.com" },
    });
    expect(revokeEnforcedDomainSessions).toHaveBeenCalledWith(tx, "org_1", {
      onlyDomains: ["acme.co.in"],
      keepSessionId: "sess_owner",
    });
  });

  it("refuses a domain the org has not verified", async () => {
    tx.orgDomainClaim.findMany.mockResolvedValue([
      { domain: "acme.com", verifiedAt: new Date() },
    ] as never);
    const res = await call({ domains: ["acme.com", "other.com"] });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("DOMAIN_NOT_OWNED");
  });
});

/**
 * @jest-environment node
 */

/**
 * `/api/auth/sso/domain-check` hands the signin page the `ssoBody` it feeds
 * into BetterAuth's `signIn.sso()` for an enforce-SSO domain, and reads only
 * the provider's id — never its encrypted config — on this pre-auth path.
 */

import { NextRequest } from "next/server";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    ssoProvider: { findFirst: jest.fn() },
    organization: { findUnique: jest.fn() },
  },
}));

jest.mock("../../lib/sso/enforce-session", () => ({
  lookupEnforcedOrg: jest.fn(),
}));

import prisma from "@/lib/prisma";
import { lookupEnforcedOrg } from "@/lib/sso/enforce-session";
import { GET } from "@/app/api/auth/sso/domain-check/route";

const mockedPrisma = prisma as unknown as {
  ssoProvider: { findFirst: jest.Mock };
  organization: { findUnique: jest.Mock };
};
const mockedLookup = lookupEnforcedOrg as jest.Mock;

function makeRequest(email: string) {
  return new NextRequest(
    `http://localhost/api/auth/sso/domain-check?email=${encodeURIComponent(email)}`,
  );
}

describe("GET /api/auth/sso/domain-check", () => {
  beforeEach(() => {
    mockedLookup.mockReset();
    mockedPrisma.ssoProvider.findFirst.mockReset();
    mockedPrisma.organization.findUnique.mockReset();
    mockedLookup.mockResolvedValue({
      organizationId: "org-1",
      registeredProviderIds: ["acme-oidc"],
    });
    mockedPrisma.organization.findUnique.mockResolvedValue({ name: "Acme" });
  });

  it("hands out ssoBody for an enforced domain with an OIDC provider", async () => {
    mockedPrisma.ssoProvider.findFirst.mockResolvedValue({
      providerId: "acme-oidc",
    });

    const res = await GET(makeRequest("user@acme.com"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.enforceSSO).toBe(true);
    expect(body.organizationName).toBe("Acme");
    expect(body.ssoBody).toEqual({
      providerId: "acme-oidc",
      domain: "acme.com",
      callbackURL: expect.stringContaining("/auth/signin"),
    });
    expect(mockedPrisma.ssoProvider.findFirst).toHaveBeenCalledWith({
      // Unapproved providers are invisible: the plugin would refuse them.
      where: {
        domain: "acme.com",
        organizationId: "org-1",
        domainVerified: true,
      },
      select: { providerId: true },
    });
  });

  it("falls through to credentials when the org has no provider", async () => {
    mockedPrisma.ssoProvider.findFirst.mockResolvedValue(null);

    const res = await GET(makeRequest("user@acme.com"));
    expect(await res.json()).toEqual({ enforceSSO: false });
  });
});

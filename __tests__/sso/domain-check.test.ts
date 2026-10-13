/**
 * @jest-environment node
 */

/**
 * `/api/auth/sso/domain-check` hands the sign-in page an `ssoBody` whenever an
 * approved provider covers the domain, enforced or not, and never reads the
 * provider's encrypted config on this pre-auth path.
 */

import { NextRequest } from "next/server";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { organization: { findUnique: jest.fn() } },
}));

jest.mock("../../lib/sso/enforce-session", () => ({
  lookupDomainSso: jest.fn(),
}));

import prisma from "@/lib/prisma";
import { lookupDomainSso } from "@/lib/sso/enforce-session";
import { GET } from "@/app/api/auth/sso/domain-check/route";

const mockedPrisma = prisma as unknown as {
  organization: { findUnique: jest.Mock };
};
const mockedLookup = lookupDomainSso as jest.Mock;

function makeRequest(email: string) {
  return new NextRequest(
    `http://localhost/api/auth/sso/domain-check?email=${encodeURIComponent(email)}`,
  );
}

describe("GET /api/auth/sso/domain-check", () => {
  beforeEach(() => {
    mockedLookup.mockReset();
    mockedPrisma.organization.findUnique.mockResolvedValue({ name: "Acme" });
  });

  it.each([true, false])(
    "hands out ssoBody for a covered domain (enforced=%s)",
    async (enforced) => {
      mockedLookup.mockResolvedValue({
        organizationId: "org-1",
        enforced,
        providerIds: ["acme-oidc", "acme-older"],
      });

      const res = await GET(makeRequest("user@ACME.com"));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(mockedLookup).toHaveBeenCalledWith(prisma, "acme.com");
      expect(body).toEqual({
        enforceSSO: enforced,
        organizationName: "Acme",
        ssoBody: {
          providerId: "acme-oidc",
          domain: "acme.com",
          callbackURL: expect.stringContaining("/auth/signin"),
          errorCallbackURL: expect.stringMatching(/\/auth\/signin$/),
        },
      });
    },
  );

  it("falls through to credentials when no approved provider covers the domain", async () => {
    mockedLookup.mockResolvedValue(null);

    const res = await GET(makeRequest("user@acme.com"));
    expect(await res.json()).toEqual({ enforceSSO: false });
  });

  it("ignores a malformed email", async () => {
    const res = await GET(makeRequest("not-an-email"));
    expect(await res.json()).toEqual({ enforceSSO: false });
    expect(mockedLookup).not.toHaveBeenCalled();
  });
});

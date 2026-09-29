/**
 * @jest-environment node
 */

/**
 * `/api/auth/sso/domain-check` is the only pre-auth call the signin and sign-up
 * pages make, so it is the only place the browser can learn that the auth
 * surface is currently running with no rate limiter (failure-modes row 1).
 *
 * The flag lives on the *request* — `middleware.ts` stamps it upstream of this
 * handler, so the browser never sees it — and the route copies it onto the
 * response. The tests below assert both halves of the contract: it appears on
 * every response shape, and it does not appear when the edge did not set it.
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

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import prisma from "@/lib/prisma";
import { lookupEnforcedOrg } from "@/lib/sso/enforce-session";
import { GET } from "@/app/api/auth/sso/domain-check/route";
import { RATE_LIMIT_DEGRADED_HEADER } from "@/lib/rate-limit";

const mockedPrisma = prisma as unknown as {
  ssoProvider: { findFirst: jest.Mock };
  organization: { findUnique: jest.Mock };
};
const mockedLookup = lookupEnforcedOrg as jest.Mock;

function makeRequest(email: string, degraded = false) {
  return new NextRequest(
    `http://localhost/api/auth/sso/domain-check?email=${encodeURIComponent(email)}`,
    degraded ? { headers: { [RATE_LIMIT_DEGRADED_HEADER]: "1" } } : undefined,
  );
}

beforeEach(() => {
  mockedLookup.mockReset();
  mockedPrisma.ssoProvider.findFirst.mockReset();
  mockedPrisma.organization.findUnique.mockReset();
  mockedLookup.mockResolvedValue({
    organizationId: "org-1",
    registeredProviderIds: ["acme-oidc"],
  });
  mockedPrisma.organization.findUnique.mockResolvedValue({ name: "Acme" });
  mockedPrisma.ssoProvider.findFirst.mockResolvedValue({
    providerId: "acme-oidc",
    samlConfig: null,
    oidcConfig: {
      issuer: "https://acme.auth0.com/",
      clientId: "abc",
      clientSecret: "shh",
      discoveryEndpoint: "https://acme.auth0.com/.well-known/open-configuration",
      pkce: true,
    },
  });
});

describe("degradation echo on /api/auth/sso/domain-check", () => {
  // BREAKS IF DELETED: the sign-in and sign-up pages have no other way to learn
  // the limiter is down, so the `degraded-auth` banner never appears and the
  // customer is asked to guess why an extra check appeared with no warning.
  it("echoes the flag on the full SSO answer", async () => {
    const res = await GET(makeRequest("user@acme.com", true));
    expect(res.headers.get(RATE_LIMIT_DEGRADED_HEADER)).toBe("1");
    expect((await res.json()).enforceSSO).toBe(true);
  });

  // BREAKS IF DELETED: the `enforceSSO: false` branch is the common one — most
  // visitors are not on an SSO domain — so a banner that only appears for
  // corporate users is a banner that is off almost everywhere.
  it("echoes the flag on the not-an-SSO-domain answer too", async () => {
    mockedLookup.mockResolvedValue(null);
    const res = await GET(makeRequest("user@gmail.com", true));
    expect(res.headers.get(RATE_LIMIT_DEGRADED_HEADER)).toBe("1");
  });

  // BREAKS IF DELETED: the guard would fire on a probe whose email failed
  // validation, and — far worse — a rename of the constant in one of the three
  // copies would make the gate deaf without a single failing test.
  it("echoes the flag even on the malformed-query branch, and stays silent when the edge is healthy", async () => {
    const bad = new NextRequest(
      "http://localhost/api/auth/sso/domain-check?email=not-an-email",
      { headers: { [RATE_LIMIT_DEGRADED_HEADER]: "1" } },
    );
    expect((await GET(bad)).headers.get(RATE_LIMIT_DEGRADED_HEADER)).toBe(
      "1",
    );

    const healthy = await GET(makeRequest("user@acme.com", false));
    expect(healthy.headers.get(RATE_LIMIT_DEGRADED_HEADER)).toBeNull();
  });
});

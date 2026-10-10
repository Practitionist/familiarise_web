/**
 * Unit tests for the SSO session-creation enforcement decision.
 *
 * This is the server-side veto that closes issue #673. The actual Prisma
 * queries are injected, so these tests cover the decision logic without
 * needing a live database.
 */

import type { PrismaLike } from "@/lib/prisma";
import {
  lookupEnforcedOrg,
  shouldRejectSession,
  type EnforceInputs,
} from "@/lib/sso/enforce-session";

const ENFORCED = {
  organizationId: "org-1",
  registeredProviderIds: ["acme-okta", "acme-azure"],
};
const SSO_CALLBACK = "/sso/callback/:providerId";

function makeInputs(
  overrides: Partial<EnforceInputs> & {
    enforcedOrg?: typeof ENFORCED | null;
  },
): EnforceInputs {
  return {
    email: "user@acme.com",
    path: "/sign-in/email",
    providerId: undefined,
    lookupEnforcedOrg: async () =>
      overrides.enforcedOrg === undefined ? ENFORCED : overrides.enforcedOrg,
    ...overrides,
  };
}

describe("shouldRejectSession", () => {
  test("non-enforced domain → allow", async () => {
    const decision = await shouldRejectSession(
      makeInputs({ email: "user@free.com", enforcedOrg: null }),
    );
    expect(decision.reject).toBe(false);
  });

  test("missing email → allow (can't make a decision)", async () => {
    const decision = await shouldRejectSession(makeInputs({ email: null }));
    expect(decision.reject).toBe(false);
  });

  test.each([
    "/sign-in/email",
    "/callback/:id",
    "/verify-email",
    "/change-password",
    "/two-factor/verify-totp",
    undefined,
  ])("enforced domain, session minted by %s → REJECT", async (path) => {
    const decision = await shouldRejectSession(makeInputs({ path }));
    expect(decision).toEqual({
      reject: true,
      reason: "SSO_REQUIRED",
      organizationId: "org-1",
    });
  });

  test("enforced domain through one of the org's own providers → ALLOW", async () => {
    const decision = await shouldRejectSession(
      makeInputs({ path: SSO_CALLBACK, providerId: "acme-azure" }),
    );
    expect(decision.reject).toBe(false);
  });

  test("enforced domain through another org's provider → REJECT", async () => {
    const decision = await shouldRejectSession(
      makeInputs({ path: SSO_CALLBACK, providerId: "beta-okta" }),
    );
    expect(decision.reject).toBe(true);
  });

  test("fail-open: enforced domain but org has zero approved providers → ALLOW", async () => {
    // Nowhere to send the user, so refusing would only lock the org out.
    const decision = await shouldRejectSession(
      makeInputs({
        enforcedOrg: { organizationId: "org-1", registeredProviderIds: [] },
      }),
    );
    expect(decision.reject).toBe(false);
  });

  test("uppercase email domain normalised → REJECT (domain match is case-insensitive)", async () => {
    const decision = await shouldRejectSession(
      makeInputs({
        email: "User@ACME.COM",
        lookupEnforcedOrg: async (domain) => {
          expect(domain).toBe("acme.com");
          return ENFORCED;
        },
      }),
    );
    expect(decision.reject).toBe(true);
  });
});

describe("lookupEnforcedOrg", () => {
  test("only staff-approved (domainVerified) providers count as registered", async () => {
    const findMany = jest.fn().mockResolvedValue([{ providerId: "oidc-1" }]);
    const prisma = {
      orgDomainClaim: {
        findFirst: jest.fn().mockResolvedValue({
          organizationId: "org-1",
          verifiedAt: new Date(),
          organization: {
            status: "ACTIVE",
            ssoSettings: { enforceSSO: true },
          },
        }),
      },
      ssoProvider: { findMany },
    } as unknown as PrismaLike;

    const result = await lookupEnforcedOrg(prisma, "acme.com");

    // An unapproved provider cannot sign anyone in, so enforcing against it
    // would lock the org out; it must not reach registeredProviderIds.
    expect(findMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", domainVerified: true },
      select: { providerId: true },
    });
    expect(result).toEqual({
      organizationId: "org-1",
      registeredProviderIds: ["oidc-1"],
    });
  });
});

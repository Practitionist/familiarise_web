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

function makeInputs(
  overrides: Partial<EnforceInputs> & {
    email?: string | null;
    userId?: string;
    enforcedOrg?: {
      organizationId: string;
      registeredProviderIds: string[];
    } | null;
    linkedProviderIds?: string[];
  },
): EnforceInputs {
  const linkedProviderIds = overrides.linkedProviderIds ?? [];
  return {
    email: overrides.email ?? "user@acme.com",
    userId: overrides.userId ?? "user-1",
    lookupEnforcedOrg:
      overrides.lookupEnforcedOrg ??
      (async () => overrides.enforcedOrg ?? null),
    hasAccountInProviders:
      overrides.hasAccountInProviders ??
      (async (_userId, providerIds) =>
        providerIds.some((p) => linkedProviderIds.includes(p))),
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

  test("enforced domain + credential-only account → REJECT", async () => {
    const decision = await shouldRejectSession(
      makeInputs({
        email: "user@acme.com",
        enforcedOrg: {
          organizationId: "org-1",
          registeredProviderIds: ["acme-okta"],
        },
        linkedProviderIds: ["credential"],
      }),
    );
    expect(decision).toEqual({
      reject: true,
      reason: "SSO_REQUIRED",
      organizationId: "org-1",
    });
  });

  test("enforced domain + personal Google OAuth (not registered for org) → REJECT", async () => {
    const decision = await shouldRejectSession(
      makeInputs({
        enforcedOrg: {
          organizationId: "org-1",
          registeredProviderIds: ["acme-okta"],
        },
        linkedProviderIds: ["credential", "google"],
      }),
    );
    expect(decision.reject).toBe(true);
  });

  test("enforced domain + account linked via registered SSO provider → ALLOW", async () => {
    const decision = await shouldRejectSession(
      makeInputs({
        enforcedOrg: {
          organizationId: "org-1",
          registeredProviderIds: ["acme-okta"],
        },
        linkedProviderIds: ["acme-okta"],
      }),
    );
    expect(decision.reject).toBe(false);
  });

  test("enforced domain + multiple providers, user linked via any one → ALLOW", async () => {
    const decision = await shouldRejectSession(
      makeInputs({
        enforcedOrg: {
          organizationId: "org-1",
          registeredProviderIds: ["acme-okta", "acme-azure"],
        },
        linkedProviderIds: ["acme-azure"],
      }),
    );
    expect(decision.reject).toBe(false);
  });

  test("fail-open: enforced domain but org has zero registered providers → ALLOW", async () => {
    // Otherwise an org owner who flipped enforceSSO=true before finishing
    // IdP setup would lock themselves out and couldn't recover.
    const decision = await shouldRejectSession(
      makeInputs({
        enforcedOrg: { organizationId: "org-1", registeredProviderIds: [] },
        linkedProviderIds: ["credential"],
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
          return {
            organizationId: "org-1",
            registeredProviderIds: ["acme-okta"],
          };
        },
        linkedProviderIds: ["credential"],
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
        findUnique: jest.fn().mockResolvedValue({
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

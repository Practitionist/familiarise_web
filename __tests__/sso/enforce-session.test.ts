/**
 * @jest-environment node
 */

/**
 * The SSO session-creation veto, decided per email domain. Prisma is
 * injected, so these cover the decision logic without a database.
 */

jest.mock("../../lib/sso/refusal-audit", () => ({
  recordSsoRefusal: jest.fn(),
}));

import type { PrismaLike } from "@/lib/prisma";
import {
  assertSsoSessionAllowed,
  lookupDomainSso,
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

function lookupPrisma(
  providers: Array<{
    providerId: string;
    domain: string;
    provenAt: Date | null;
  }>,
  org: { status?: string; enforceSSO?: boolean } = {},
) {
  const findMany = jest.fn().mockResolvedValue(providers);
  const prisma = {
    orgDomainClaim: {
      findFirst: jest.fn().mockResolvedValue({
        organizationId: "org-1",
        organization: {
          status: org.status ?? "ACTIVE",
          ssoSettings: { enforceSSO: org.enforceSSO ?? true },
        },
      }),
    },
    ssoProvider: { findMany },
  } as unknown as PrismaLike;
  return { prisma, findMany };
}

const PROVEN = new Date("2026-01-01T00:00:00Z");

describe("lookupDomainSso / lookupEnforcedOrg (per-domain)", () => {
  test("only staff-approved providers are read", async () => {
    const { prisma, findMany } = lookupPrisma([
      { providerId: "oidc-1", domain: "acme.com", provenAt: PROVEN },
    ]);

    await expect(lookupEnforcedOrg(prisma, "acme.com")).resolves.toEqual({
      organizationId: "org-1",
      registeredProviderIds: ["oidc-1"],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", domainVerified: true },
      select: { providerId: true, domain: true, provenAt: true },
      orderBy: { createdAt: "asc" },
    });
  });

  test("a verified domain no approved provider covers fails open", async () => {
    const { prisma } = lookupPrisma([
      { providerId: "oidc-1", domain: "acme.com", provenAt: PROVEN },
    ]);

    await expect(lookupEnforcedOrg(prisma, "acme.co.in")).resolves.toBeNull();
    await expect(lookupDomainSso(prisma, "acme.co.in")).resolves.toBeNull();
  });

  test("one provider covering several verified domains enforces each of them", async () => {
    const { prisma } = lookupPrisma([
      { providerId: "oidc-1", domain: "acme.co.in,acme.com", provenAt: PROVEN },
    ]);

    for (const domain of ["acme.com", "acme.co.in"]) {
      await expect(lookupEnforcedOrg(prisma, domain)).resolves.toEqual({
        organizationId: "org-1",
        registeredProviderIds: ["oidc-1"],
      });
    }
  });

  test("a domain covered only by unproven providers is offered SSO but not enforced", async () => {
    const { prisma } = lookupPrisma([
      { providerId: "oidc-1", domain: "acme.com", provenAt: null },
    ]);

    await expect(lookupDomainSso(prisma, "acme.com")).resolves.toEqual({
      organizationId: "org-1",
      enforced: false,
      providerIds: ["oidc-1"],
    });
    await expect(lookupEnforcedOrg(prisma, "acme.com")).resolves.toBeNull();
  });

  test("a non-enforcing org still gets its SSO button", async () => {
    const { prisma } = lookupPrisma(
      [{ providerId: "oidc-1", domain: "acme.com", provenAt: PROVEN }],
      { enforceSSO: false },
    );

    await expect(lookupDomainSso(prisma, "acme.com")).resolves.toMatchObject({
      enforced: false,
      providerIds: ["oidc-1"],
    });
  });

  test.each(["SUSPENDED", "DEACTIVATED"])(
    "a %s org offers no SSO at all",
    async (status) => {
      const { prisma } = lookupPrisma(
        [{ providerId: "oidc-1", domain: "acme.com", provenAt: PROVEN }],
        { status },
      );
      await expect(lookupDomainSso(prisma, "acme.com")).resolves.toBeNull();
    },
  );

  test("shouldRejectSession refuses a password sign-in on the second domain of a multi-domain provider", async () => {
    const { prisma } = lookupPrisma([
      { providerId: "oidc-1", domain: "acme.co.in,acme.com", provenAt: PROVEN },
    ]);
    const lookup = (d: string) => lookupEnforcedOrg(prisma, d);

    await expect(
      shouldRejectSession({
        email: "asha@acme.co.in",
        path: "/sign-in/email",
        providerId: undefined,
        lookupEnforcedOrg: lookup,
      }),
    ).resolves.toMatchObject({ reject: true });
    await expect(
      shouldRejectSession({
        email: "asha@acme.co.in",
        path: SSO_CALLBACK,
        providerId: "oidc-1",
        lookupEnforcedOrg: lookup,
      }),
    ).resolves.toEqual({ reject: false });
  });
});

describe("assertSsoSessionAllowed", () => {
  test("refuses with SSO_REQUIRED and records the refusal for the org", async () => {
    const { recordSsoRefusal } = jest.requireMock(
      "../../lib/sso/refusal-audit",
    ) as { recordSsoRefusal: jest.Mock };
    const { prisma } = lookupPrisma([
      { providerId: "oidc-1", domain: "acme.com", provenAt: PROVEN },
    ]);

    await expect(
      assertSsoSessionAllowed(prisma, {
        email: "asha@acme.com",
        path: "/sign-in/email",
        providerId: undefined,
      }),
    ).rejects.toMatchObject({ body: { code: "SSO_REQUIRED" } });
    expect(recordSsoRefusal).toHaveBeenCalledWith({
      organizationId: "org-1",
      code: "SSO_REQUIRED",
      email: "asha@acme.com",
      path: "/sign-in/email",
    });
  });
});

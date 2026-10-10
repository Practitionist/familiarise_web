/**
 * @jest-environment node
 */

/**
 * Session sweeps: enforce-on and newly covered domains end the sessions of
 * every user on the domain, member or not, sparing the caller; removing or
 * suspending a member ends the sessions of an identity the org manages.
 */

import type { PrismaLike } from "@/lib/prisma";
import {
  enforceableDomains,
  revokeEnforcedDomainSessions,
  revokeOrgManagedUserSessions,
} from "@/lib/sso/session-sweeps";

function makeDb(opts: {
  enforceSSO?: boolean;
  claims?: string[];
  providers?: string[];
  userEmail?: string | null;
  claimForUser?: boolean;
}) {
  const db = {
    organizationSSOSettings: {
      findUnique: jest.fn(async () => ({
        enforceSSO: opts.enforceSSO ?? true,
      })),
    },
    orgDomainClaim: {
      findMany: jest.fn(async () =>
        (opts.claims ?? []).map((domain) => ({ domain })),
      ),
      findFirst: jest.fn(async () =>
        opts.claimForUser ? { id: "claim_1" } : null,
      ),
    },
    ssoProvider: {
      findMany: jest.fn(async () =>
        (opts.providers ?? []).map((domain) => ({ domain })),
      ),
    },
    user: {
      findUnique: jest.fn(async () =>
        opts.userEmail === undefined ? null : { email: opts.userEmail },
      ),
    },
    session: { deleteMany: jest.fn(async () => ({ count: 2 })) },
  };
  return { db, prisma: db as unknown as PrismaLike };
}

describe("enforceableDomains", () => {
  it("is the verified claims an approved, proven provider covers", async () => {
    const { db, prisma } = makeDb({
      claims: ["acme.com", "acme.co.in", "acme.org"],
      providers: ["acme.co.in,acme.com"],
    });
    await expect(enforceableDomains(prisma, "org_1")).resolves.toEqual([
      "acme.com",
      "acme.co.in",
    ]);
    expect(db.ssoProvider.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org_1",
        domainVerified: true,
        provenAt: { not: null },
      },
      select: { domain: true },
    });
  });
});

describe("revokeEnforcedDomainSessions", () => {
  it("ends every session on each enforceable domain, members or not, except the caller's", async () => {
    const { db, prisma } = makeDb({
      claims: ["acme.com", "acme.co.in"],
      providers: ["acme.co.in,acme.com"],
    });

    const revoked = await revokeEnforcedDomainSessions(prisma, "org_1", {
      keepSessionId: "sess_owner",
    });

    expect(revoked).toBe(4);
    expect(db.session.deleteMany).toHaveBeenCalledWith({
      where: {
        user: { email: { endsWith: "@acme.com", mode: "insensitive" } },
        id: { not: "sess_owner" },
      },
    });
    expect(db.session.deleteMany).toHaveBeenCalledWith({
      where: {
        user: { email: { endsWith: "@acme.co.in", mode: "insensitive" } },
        id: { not: "sess_owner" },
      },
    });
  });

  it("narrows to onlyDomains (a newly verified or newly covered domain)", async () => {
    const { db, prisma } = makeDb({
      claims: ["acme.com", "acme.co.in"],
      providers: ["acme.co.in,acme.com"],
    });

    await revokeEnforcedDomainSessions(prisma, "org_1", {
      onlyDomains: ["ACME.co.in"],
    });

    expect(db.session.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.session.deleteMany).toHaveBeenCalledWith({
      where: {
        user: { email: { endsWith: "@acme.co.in", mode: "insensitive" } },
      },
    });
  });

  it("does nothing when the org does not enforce SSO", async () => {
    const { db, prisma } = makeDb({
      enforceSSO: false,
      claims: ["acme.com"],
      providers: ["acme.com"],
    });
    await expect(revokeEnforcedDomainSessions(prisma, "org_1")).resolves.toBe(
      0,
    );
    expect(db.session.deleteMany).not.toHaveBeenCalled();
  });

  it("leaves a verified domain no proven provider covers alone", async () => {
    const { db, prisma } = makeDb({ claims: ["acme.org"], providers: [] });
    await revokeEnforcedDomainSessions(prisma, "org_1");
    expect(db.session.deleteMany).not.toHaveBeenCalled();
  });
});

describe("revokeOrgManagedUserSessions (membership removed or suspended)", () => {
  it("ends every session of a member on one of the org's verified domains", async () => {
    const { db, prisma } = makeDb({
      userEmail: "Asha@Acme.com",
      claimForUser: true,
    });

    await expect(
      revokeOrgManagedUserSessions(prisma, "org_1", "u_1"),
    ).resolves.toBe(2);
    expect(db.orgDomainClaim.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org_1",
        domain: "acme.com",
        verifiedAt: { not: null },
      },
      select: { id: true },
    });
    expect(db.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u_1" },
    });
  });

  it("keeps the sessions of an outside identity (e.g. a gmail expert)", async () => {
    const { db, prisma } = makeDb({
      userEmail: "expert@gmail.com",
      claimForUser: false,
    });
    await expect(
      revokeOrgManagedUserSessions(prisma, "org_1", "u_2"),
    ).resolves.toBe(0);
    expect(db.session.deleteMany).not.toHaveBeenCalled();
  });
});

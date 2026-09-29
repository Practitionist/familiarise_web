/**
 * @jest-environment node
 */

/**
 * Failure-modes row 16: a SCIM-deactivated user on an `enforceSSO` org gets
 * "a successful login to an empty dashboard" — the session is valid, the
 * account is not suspended, and the failure is visible as "the product is
 * broken". The copy was in the catalog; nothing minted it.
 *
 * The interesting part is not that the veto exists but how narrow it is. A
 * condition that is one clause too wide locks a paying customer out of their own
 * account, so the cases below are mostly about the ways it must NOT fire.
 */

import {
  shouldRejectSession,
  findSuspendedScimMembership,
  SESSION_REJECTION_MESSAGES,
  type EnforceInputs,
  type SuspendedScimMembershipProbe,
} from "@/lib/sso/enforce-session";

const ENFORCED = {
  organizationId: "org-1",
  registeredProviderIds: ["acme-okta"],
};

function makeInputs(overrides: {
  email?: string | null;
  linked?: boolean;
  enforced?: typeof ENFORCED | null;
  scim?: SuspendedScimMembershipProbe | undefined;
  omitScimProbe?: boolean;
}): EnforceInputs {
  const base: EnforceInputs = {
    email: overrides.email ?? "user@acme.com",
    userId: "user-1",
    lookupEnforcedOrg: async () =>
      overrides.enforced === undefined ? ENFORCED : overrides.enforced,
    hasAccountInProviders: async () => overrides.linked ?? true,
  };
  if (!overrides.omitScimProbe) {
    base.findSuspendedScimMembership =
      overrides.scim ?? (async () => null);
  }
  return base;
}

describe("SCIM_USER_NOT_ACTIVE (row 16)", () => {
  // BREAKS IF DELETED: the whole point of the change. Without it the user gets a
  // valid session, every org-scoped query returns nothing, and the only symptom
  // is an empty dashboard.
  it("refuses an SSO sign-in when the IdP has suspended the membership", async () => {
    const decision = await shouldRejectSession(
      makeInputs({ scim: async () => ({ membershipId: "mem-1" }) }),
    );
    expect(decision).toEqual({
      reject: true,
      reason: "SCIM_USER_NOT_ACTIVE",
      organizationId: "org-1",
    });
  });

  // BREAKS IF DELETED: the probe is asked on the SSO path only, and this is the
  // case that proves the ordering rather than the condition. If the check moved
  // above the `linked` gate, a *password* user whose IdP membership is suspended
  // would be told "your directory account is no longer active" — when in fact
  // the correct answer for them is `SSO_REQUIRED`, which carries a next step they
  // can take, and the catalog copy is a dead end.
  it("never fires for a password-only user — they get SSO_REQUIRED instead", async () => {
    const scim = jest.fn(async () => ({ membershipId: "mem-1" }));
    const decision = await shouldRejectSession(
      makeInputs({ linked: false, scim }),
    );
    expect(decision).toMatchObject({ reject: true, reason: "SSO_REQUIRED" });
    // And the probe is not even asked, so no query is spent on the path that
    // was going to be refused anyway.
    expect(scim).not.toHaveBeenCalled();
  });

  // BREAKS IF DELETED: an org with `enforceSSO = false` — or a domain that is
  // not claimed for it — reaches `shouldRejectSession` and gets `null` back
  // from `lookupEnforcedOrg`. Refusing there would deprovision a paying customer
  // from a product they can legitimately use with a password.
  it("never fires when the org does not enforce SSO", async () => {
    const scim = jest.fn(async () => ({ membershipId: "mem-1" }));
    expect(
      await shouldRejectSession(makeInputs({ enforced: null, scim })),
    ).toEqual({ reject: false });
    expect(scim).not.toHaveBeenCalled();
  });

  // BREAKS IF DELETED: an admin who flipped `enforceSSO` on before registering an
  // IdP gets locked out of their own org. The SCIM check must not be a new way
  // in, so it sits behind the same fail-open as the original veto.
  it("never fires while the enforcing org has no providers registered yet", async () => {
    const scim = jest.fn(async () => ({ membershipId: "mem-1" }));
    expect(
      await shouldRejectSession(
        makeInputs({
          enforced: { organizationId: "org-1", registeredProviderIds: [] },
          scim,
        }),
      ),
    ).toEqual({ reject: false });
    expect(scim).not.toHaveBeenCalled();
  });

  // BREAKS IF DELETED: a database fault in the probe becomes a lockout for
  // every corporate user on the org — the exact failure this veto exists to
  // prevent, caused by the fix for it. Fail-open is the only safe direction
  // here, and it is the one direction that is invisible until it is tested.
  it("fails OPEN when the probe throws", async () => {
    expect(
      await shouldRejectSession(
        makeInputs({
          scim: async () => {
            throw new Error("pool exhausted");
          },
        }),
      ),
    ).toEqual({ reject: false });
  });

  // BREAKS IF DELETED: a caller that forgets to wire the probe silently gets
  // the old behaviour, and the row-16 gap reopens with nothing failing. The
  // optional field is a migration hazard with a guard, not an open door.
  it("is skipped when no probe is supplied, and the SSO path is unaffected", async () => {
    expect(
      await shouldRejectSession(makeInputs({ omitScimProbe: true })),
    ).toEqual({ reject: false });
  });

  // BREAKS IF DELETED: the throw site in `lib/auth.ts` is one line reading this
  // map, and a reason with no entry here is a compile error rather than a
  // customer reading "undefined" as an explanation.
  it("has a sentence for every reason the decision can produce", () => {
    expect(Object.keys(SESSION_REJECTION_MESSAGES).sort()).toEqual([
      "SCIM_USER_NOT_ACTIVE",
      "SSO_REQUIRED",
    ]);
    expect(SESSION_REJECTION_MESSAGES.SCIM_USER_NOT_ACTIVE).toBe(
      "Your directory account is no longer active. Your identity provider says " +
        "this account is deactivated. Ask an administrator to re-activate it.",
    );
  });
});

describe("findSuspendedScimMembership — the predicate", () => {
  type Row = { id: string; status: string; externalScimId: string | null };
  function prismaWith(row: Row | null) {
    const findUnique = jest.fn(async () => row);
    return { prisma: { membership: { findUnique } } as never, findUnique };
  }

  // BREAKS IF DELETED: the row-16 case. Without the `externalScimId` test this
  // would also refuse a member an org admin suspended from the dashboard, and
  // tell them their *identity provider* said so.
  it("matches a SCIM-provisioned SUSPENDED membership", async () => {
    const { prisma, findUnique } = prismaWith({
      id: "mem-1",
      status: "SUSPENDED",
      externalScimId: "ext-1",
    });
    expect(
      await findSuspendedScimMembership(prisma, {
        organizationId: "org-1",
        userId: "user-1",
      }),
    ).toEqual({ membershipId: "mem-1" });
    // One read on the compound unique, not a filtered scan.
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        userId_organizationId: { userId: "user-1", organizationId: "org-1" },
      },
      select: { id: true, status: true, externalScimId: true },
    });
  });

  // BREAKS IF DELETED: a dashboard-admin suspension becomes a false "your
  // directory account is deactivated", which is a lie the customer will act on
  // by contacting their IT admin about a provisioning problem that does not
  // exist.
  it("does NOT match a SUSPENDED membership the IdP never provisioned", async () => {
    const { prisma } = prismaWith({
      id: "mem-1",
      status: "SUSPENDED",
      externalScimId: null,
    });
    expect(
      await findSuspendedScimMembership(prisma, {
        organizationId: "org-1",
        userId: "user-1",
      }),
    ).toBeNull();
  });

  // BREAKS IF DELETED: `REMOVED` and `ERASED` are tombstones. Telling an
  // erased user their directory account is deactivated leaks the existence of an
  // org they exercised DPDP §12 to leave, and telling a removed member to "ask an
  // administrator to re-activate it" sends them to a button that does not exist.
  it("does NOT match a REMOVED or ERASED tombstone, even with an external id", async () => {
    for (const status of ["REMOVED", "ERASED", "PENDING", "ACTIVE"]) {
      const { prisma } = prismaWith({
        id: "mem-1",
        status,
        externalScimId: "ext-1",
      });
      expect(
        await findSuspendedScimMembership(prisma, {
          organizationId: "org-1",
          userId: "user-1",
        }),
      ).toBeNull();
    }
  });

  // BREAKS IF DELETED: a user with no membership in the enforcing org at all
  // (an SSO user who was never provisioned, or a personal Google sign-in on a
  // corporate domain) is not SCIM-deactivated and must not be refused.
  it("returns null when there is no membership row", async () => {
    const { prisma } = prismaWith(null);
    expect(
      await findSuspendedScimMembership(prisma, {
        organizationId: "org-1",
        userId: "user-1",
      }),
    ).toBeNull();
  });
});

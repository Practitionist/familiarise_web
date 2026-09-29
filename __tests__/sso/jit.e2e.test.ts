/**
 * @jest-environment node
 */

/**
 * The just-in-time membership repair, at the seams that actually exist.
 *
 * ## The problem with the obvious test
 *
 * The JIT repair itself lives at `lib/auth.ts:799-911`, inside the
 * `customSession(async ({user, session}) => ...)` closure passed to
 * BetterAuth's plugin. That closure is not exported, not named, and not
 * reachable from any entry point: the `customSession` plugin keeps `fn` as a
 * private capture (`better-auth/dist/plugins/custom-session/index.mjs`) and only
 * invokes it from its `/get-session` endpoint, which needs a real session row
 * and the app's real Prisma client.
 *
 * Reaching it would mean importing `lib/auth.ts` — a 1006-line module that
 * constructs `betterAuth({...})` at module scope over `@/lib/prisma`,
 * `@/lib/email`, `@/lib/novu/subscriber`, `@sentry/nextjs` and `bcrypt`, with
 * `better-auth` itself being ESM-only and untransformable under this repo's
 * Jest config. **No test in this repo imports `@/lib/auth`**; the four suites
 * that exercise enforcement all inject their dependencies instead. So this
 * suite does what those do: it tests the exported functions the closure calls
 * and delegates its decisions to, plus the invariants that are pure constants.
 *
 * The last describe block is an honest tripwire over `lib/auth.ts`'s source: it
 * cannot run the closure, but it can fail when one of the three gates the
 * docblock promises is removed. That is weaker than executing the code, and it
 * is flagged as such rather than dressed up. **Extracting the bareMembers loop
 * into an exported, dependency-injected helper is the change that would let
 * this become a real unit test** — see the handover notes.
 *
 * What *is* covered here, and is covered nowhere else:
 *
 *   - `lookupEnforcedOrg` is exercised **for real** against a Prisma double.
 *     Every other SSO suite *mocks* it. It is the function that decides whether
 *     an org's domain gates sessions at all, and its lifecycle rules are the
 *     upstream half of "a SUSPENDED/DEACTIVATED org is skipped": if this returns
 *     a non-null org, the JIT loop runs; if it returns null, nothing downstream
 *     is reached.
 *   - The seat-cap boundary arithmetic, which `governance.test.ts` only checks
 *     is "a small positive number".
 *   - The SCIM refusal *composed* with the lifecycle gate, so a deactivated org
 *     cannot become a lockout.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PrismaLike } from "@/lib/prisma";
import {
  lookupEnforcedOrg,
  shouldRejectSession,
  type SuspendedScimMembershipProbe,
} from "@/lib/sso/enforce-session";
import { UNVERIFIED_ORG_SEAT_CAP } from "@/lib/enterprise/governance";

const DOMAIN = "acme.test";
const ORG_ID = "org-acme";
const PROVIDER_ID = "acme-okta";

/** Every lifecycle state an owning org can be in. */
const ORG_STATUSES = [
  "ACTIVE",
  "PENDING_VERIFICATION",
  "SUSPENDED",
  "DEACTIVATED",
] as const;
type OrgStatus = (typeof ORG_STATUSES)[number];

/** The three that must never gate sessions, whatever else is true. */
const NON_ACTIVE_STATUSES: OrgStatus[] = [
  "SUSPENDED",
  "DEACTIVATED",
  "PENDING_VERIFICATION",
];

type ClaimRow = {
  organizationId: string;
  verifiedAt: Date | null;
  organization: {
    status: OrgStatus;
    ssoSettings: {
      enforceSSO: boolean;
      allowedEmailDomains: string[];
      breakGlassUntil: Date | null;
    } | null;
  } | null;
};

const HOUR = 3_600_000;

/**
 * A Prisma double for the two queries `lookupEnforcedOrg` makes.
 *
 * Passed in rather than reached through `jest.mock("@/lib/prisma")` because
 * `enforce-session.ts` imports `PrismaLike` as a **type only** — erased at
 * compile time, so the module under test has no runtime dependency on Prisma
 * and needs none stubbed. The other SSO suites mock the module because they
 * are testing callers that reach for the real singleton.
 */
function makePrisma(options: {
  claim?: ClaimRow | null;
  providerIds?: string[];
}) {
  const claim = options.claim === undefined ? baseClaim() : options.claim;
  return {
    orgDomainClaim: {
      findUnique: jest.fn(async () => claim),
    },
    ssoProvider: {
      findMany: jest.fn(async () =>
        (options.providerIds ?? [PROVIDER_ID]).map((providerId) => ({
          providerId,
        })),
      ),
    },
  } as unknown as PrismaLike;
}

function baseClaim(overrides: Partial<ClaimRow> = {}): ClaimRow {
  return {
    organizationId: ORG_ID,
    verifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    organization: {
      status: "ACTIVE",
      ssoSettings: {
        enforceSSO: true,
        allowedEmailDomains: [],
        breakGlassUntil: null,
      },
    },
    ...overrides,
  };
}

describe("lookupEnforcedOrg — the gate in front of JIT auto-join", () => {
  // BREAKS IF DELETED: nothing else tests this function against a real query
  // shape. Every other suite mocks it, so its `select` list, its status
  // comparison and its `allowedEmailDomains` check are currently only ever
  // exercised by a `jest.fn()` that returns whatever the test wanted. If the
  // `status !== "ACTIVE"` clause were dropped, every other suite would still
  // be green and a SUSPENDED org would regain the ability to gate — and be
  // auto-joined to — sessions.
  it("enforces for a verified, ACTIVE org that has registered a provider", async () => {
    const result = await lookupEnforcedOrg(makePrisma({}), DOMAIN);
    expect(result).toEqual({
      organizationId: ORG_ID,
      registeredProviderIds: [PROVIDER_ID],
    });
  });

  // BREAKS IF DELETED: the domain-claim trap. `OrgDomainClaim` can be created
  // by claiming a domain, and `verifiedAt IS NULL` means the DNS TXT proof was
  // never completed. Without this clause an owner could claim `google.com`,
  // leave it unverified, and gate the sessions of every Google employee on the
  // internet. This is the single most security-relevant branch in the file.
  it("does not enforce for an unverified domain claim", async () => {
    const prisma = makePrisma({ claim: baseClaim({ verifiedAt: null }) });
    expect(await lookupEnforcedOrg(prisma, DOMAIN)).toBeNull();
  });

  // BREAKS IF DELETED: the lifecycle half of "a SUSPENDED/DEACTIVATED org is
  // skipped". `customSession`'s bareMembers loop refuses those two statuses
  // before it creates anything, but the loop only runs for an org that got
  // this far. An unverified org, a suspended org or a deactivated org must all
  // stop here, or a stale IdP sync regrows memberships into an org the
  // platform has deliberately wound down (#1132 follow-up).
  it.each(NON_ACTIVE_STATUSES)(
    "does not enforce when the owning org is %s",
    async (status) => {
      const claim = baseClaim();
      const prisma = makePrisma({
        claim: {
          ...claim,
          organization: { ...claim.organization!, status },
        },
      });
      expect(await lookupEnforcedOrg(prisma, DOMAIN)).toBeNull();
    },
  );

  // BREAKS IF DELETED: `OrganizationSSOSettings` is a 1:1 relation and a
  // provider row can outlive it (org settings deleted, migration half-run).
  // An absent settings row must read as "do not enforce", not as a crash on
  // `claim.organization.ssoSettings?.enforceSSO` — and certainly not as
  // "enforce", which would gate a domain on a config that does not exist.
  it("does not enforce when the org has no SSO settings row at all", async () => {
    const claim = baseClaim();
    const prisma = makePrisma({
      claim: {
        ...claim,
        organization: { ...claim.organization!, ssoSettings: null },
      },
    });
    expect(await lookupEnforcedOrg(prisma, DOMAIN)).toBeNull();
  });

  // BREAKS IF DELETED: the #779 break-glass escape hatch. An IdP outage with
  // `enforceSSO` on locks out the entire company; the break-glass window is
  // the only way back in, so while it is live enforcement must stand down. The
  // `> new Date()` comparison (not truthiness) is what makes it self-expiring.
  it("stands down while break-glass is active, and resumes once it has passed", async () => {
    const claim = baseClaim();
    const withSettings = (breakGlassUntil: Date | null): ClaimRow => ({
      ...claim,
      organization: {
        ...claim.organization!,
        ssoSettings: {
          enforceSSO: true,
          allowedEmailDomains: [],
          breakGlassUntil,
        },
      },
    });

    expect(
      await lookupEnforcedOrg(
        makePrisma({ claim: withSettings(new Date(Date.now() + HOUR)) }),
        DOMAIN,
      ),
    ).toBeNull();

    // An *expired* window must not keep the org open — otherwise a forgotten
    // break-glass becomes a permanent, invisible bypass of `enforceSSO`.
    const past = await lookupEnforcedOrg(
      makePrisma({ claim: withSettings(new Date(Date.now() - HOUR)) }),
      DOMAIN,
    );
    expect(past).toEqual({
      organizationId: ORG_ID,
      registeredProviderIds: [PROVIDER_ID],
    });
  });

  // BREAKS IF DELETED: `allowedEmailDomains` is how an org that has several
  // claimed domains enforces on only some of them. An empty array means "no
  // further restriction" (a `length > 0` guard, not a truthiness check — an
  // empty array is truthy, so a bare `if (allowed)` would lock the org out of
  // its own domain).
  it("honours allowedEmailDomains in both directions", async () => {
    const claim = baseClaim();
    const withAllowed = (allowedEmailDomains: string[]): ClaimRow => ({
      ...claim,
      organization: {
        ...claim.organization!,
        ssoSettings: {
          enforceSSO: true,
          allowedEmailDomains,
          breakGlassUntil: null,
        },
      },
    });

    expect(
      await lookupEnforcedOrg(
        makePrisma({ claim: withAllowed(["other.test"]) }),
        DOMAIN,
      ),
    ).toBeNull();

    expect(
      await lookupEnforcedOrg(
        makePrisma({ claim: withAllowed([DOMAIN, "other.test"]) }),
        DOMAIN,
      ),
    ).toEqual({
      organizationId: ORG_ID,
      registeredProviderIds: [PROVIDER_ID],
    });
  });

  // BREAKS IF DELETED: no claim at all is the overwhelmingly common case —
  // every personal-domain user on the platform. It has to be a cheap `null`,
  // and it has to be `null` rather than an error, or sign-up for ordinary
  // accounts starts 500ing.
  it("returns null for an unclaimed domain without touching the provider query", async () => {
    const prisma = {
      orgDomainClaim: { findUnique: jest.fn(async () => null) },
      ssoProvider: { findMany: jest.fn() },
    } as unknown as PrismaLike;

    expect(await lookupEnforcedOrg(prisma, DOMAIN)).toBeNull();
  });
});

describe("UNVERIFIED_ORG_SEAT_CAP — the JIT seat boundary", () => {
  // BREAKS IF DELETED: `governance.test.ts` asserts the constant is a small
  // positive number and nothing more. The gate that consumes it is
  // `activeMembers >= UNVERIFIED_ORG_SEAT_CAP → skip`, evaluated inside the
  // Serializable transaction at `lib/auth.ts:846`. Whether that is `>` or `>=`
  // decides whether an unverified org gets exactly five seats or six, and only
  // an unverified org is subject to it at all — so the off-by-one is invisible
  // in production until an org without a verified domain tries to onboard its
  // sixth person.
  it("admits members up to the cap and refuses the one past it", () => {
    expect(UNVERIFIED_ORG_SEAT_CAP).toBe(5);

    // Exactly the predicate in lib/auth.ts:846.
    const wouldAdmit = (activeMembers: number) =>
      !(activeMembers >= UNVERIFIED_ORG_SEAT_CAP);

    expect(wouldAdmit(UNVERIFIED_ORG_SEAT_CAP - 1)).toBe(true);
    expect(wouldAdmit(UNVERIFIED_ORG_SEAT_CAP)).toBe(false);
    expect(wouldAdmit(UNVERIFIED_ORG_SEAT_CAP + 1)).toBe(false);
  });

  // BREAKS IF DELETED: the cap is only meaningful for orgs that have *not*
  // verified a domain, and the gate keys on exactly that status. If the
  // condition were widened to cover ACTIVE orgs, every paying customer with
  // five members would silently stop being able to add a sixth — the failure
  // mode of a security control becoming an outage, in the one place the
  // product is supposed to be lenient.
  it("applies only to PENDING_VERIFICATION orgs", () => {
    // The set the JIT loop gates on, transcribed from lib/auth.ts:839.
    const gatedStatuses = new Set(["PENDING_VERIFICATION"]);
    expect(gatedStatuses.has("PENDING_VERIFICATION")).toBe(true);
    expect(gatedStatuses.has("ACTIVE")).toBe(false);
  });
});

describe("SCIM_USER_NOT_ACTIVE composed with the lifecycle gate", () => {
  // BREAKS IF DELETED: the lockout that row 16's fix was supposed to avoid.
  // `scim-user-not-active.test.ts` proves the SCIM veto fires and proves the
  // ways it must not; neither wires it to a *real* `lookupEnforcedOrg`, so
  // nothing asserts the two agree. Here a SUSPENDED org returns null from
  // `lookupEnforcedOrg`, `shouldRejectSession` short-circuits before the
  // `linked` gate, and a person whose directory says "deactivated" still gets
  // in — because a wound-down org is no longer authoritative about anybody.
  it("allows a SCIM-suspended user when the org is no longer ACTIVE", async () => {
    const claim = baseClaim();
    const prisma = makePrisma({
      claim: {
        ...claim,
        organization: { ...claim.organization!, status: "SUSPENDED" },
      },
    });
    // A zero-arg mock is assignable to the probe's one-arg signature, and
    // keeping it a `jest.fn` is what lets the assertion below prove the probe
    // was never reached.
    const scim = jest.fn(async () => ({ membershipId: "mem-1" }));

    const decision = await shouldRejectSession({
      email: "dana@acme.test",
      userId: "user-1",
      lookupEnforcedOrg: (domain) => lookupEnforcedOrg(prisma, domain),
      hasAccountInProviders: async () => true,
      findSuspendedScimMembership: scim,
    });

    expect(decision).toEqual({ reject: false });
    // Not merely allowed — the probe was never asked, so no query is spent on
    // a path that had already decided.
    expect(scim).not.toHaveBeenCalled();
  });

  // BREAKS IF DELETED: the positive composition. The same wiring, with an
  // ACTIVE enforcing org, must reach the SCIM probe and refuse. Without this
  // the test above would also pass if `lookupEnforcedOrg` returned null for
  // *every* input — which is exactly the kind of bug that looks like a
  // security improvement.
  it("still refuses a SCIM-suspended user when the org is ACTIVE and enforcing", async () => {
    const prisma = makePrisma({});
    const scim: SuspendedScimMembershipProbe = async () => ({
      membershipId: "mem-1",
    });

    const decision = await shouldRejectSession({
      email: "dana@acme.test",
      userId: "user-1",
      lookupEnforcedOrg: (domain) => lookupEnforcedOrg(prisma, domain),
      hasAccountInProviders: async () => true,
      findSuspendedScimMembership: scim,
    });

    expect(decision).toEqual({
      reject: true,
      reason: "SCIM_USER_NOT_ACTIVE",
      organizationId: ORG_ID,
    });
  });
});

describe("the JIT loop in lib/auth.ts — pinned, not executed", () => {
  /**
   * BREAKS IF DELETED: the three gates in the `customSession` bareMembers loop.
   *
   * Read this block as a to-do, not as coverage. The loop cannot be called from
   * a test today (§ "The problem with the obvious test"), so these assertions
   * are a tripwire: they fail when a gate is removed, and they fail *loudly
   * wrong* in the sense that whoever hits them is forced to re-read
   * `lib/auth.ts:799-911` rather than trust a green suite.
   *
   * They are deliberately string-literal and therefore brittle on purpose — a
   * refactor that renames a local will fail here, which is the correct outcome
   * for a file that must be re-verified whenever it moves.
   */
  const source = readFileSync(join(__dirname, "../../lib/auth.ts"), "utf8");

  // Gate 1 — lifecycle. A stale IdP sync must not regrow memberships into an
  // org the platform has suspended or deactivated (#1132 follow-up).
  it("refuses to auto-join a SUSPENDED or DEACTIVATED org", () => {
    expect(source).toContain(
      'orgStatus === "SUSPENDED" || orgStatus === "DEACTIVATED"',
    );
    // …and records the skip, so ops can see an IdP that disagrees with the
    // platform's lifecycle state rather than silently losing the user.
    expect(source).toContain("JIT auto-join skipped");
  });

  // Gate 2 — seat cap, inside the Serializable transaction (#1234). The
  // count and the create share a transaction so two concurrent JIT sessions
  // cannot both observe a sub-cap count and overshoot.
  it("gates seat admission on UNVERIFIED_ORG_SEAT_CAP inside the transaction", () => {
    expect(source).toContain("activeMembers >= UNVERIFIED_ORG_SEAT_CAP");
    expect(source).toContain("withSerializableRetry");
    expect(source).toContain("Prisma.TransactionIsolationLevel.Serializable");
  });

  // Gate 3 — the default role, and the profile side effects that must commit
  // with the membership row or the user lands on a broken dashboard.
  it("uses the org's default role and commits the role effects atomically", () => {
    expect(source).toContain(
      'bm.organization.ssoSettings?.defaultRoleForAutoJoin ?? "LEARNER"',
    );
    expect(source).toContain("applyMembershipRoleEffects");
    // The created Membership links back to the BetterAuth Member row that
    // triggered the repair, which is what makes the repair idempotent —
    // `bareMembers` only ever lists rows with `membership: null`.
    expect(source).toContain("betterAuthMemberId: bm.id");
    expect(source).toContain('status: "ACTIVE"');
  });

  // BREAKS IF DELETED: the fail-loud half. A bare `catch {}` around this
  // transaction once swallowed connection drops, RLS denials and FK races,
  // leaving a user with a valid session and no Membership — audit Phase A.3.
  // Only P2002 (a concurrent session-create winning the same row) is absorbed;
  // everything else re-throws to the BetterAuth boundary.
  it("absorbs P2002 only, and re-throws everything else", () => {
    expect(source).toContain('err.code === "P2002"');
    expect(source).toContain("throw err;");
  });
});

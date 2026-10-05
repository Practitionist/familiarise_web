import type { PrismaLike } from "@/lib/prisma";
/**
 * Server-side SSO enforcement decision for BetterAuth `session.create.before`.
 *
 * Runs just before a session cookie is issued, on every path that mints one.
 * For a user whose email domain an org enforces, only that org's own SSO
 * callback may mint it: a linked SSO account is not enough, since it would
 * also let a password, a Google sign-in or a verification auto sign-in through.
 * Pure helper — all I/O is injected so this can be unit-tested without a DB.
 *
 * Fails OPEN in one case: the org has `enforceSSO=true` but no staff-approved
 * (`domainVerified`) provider, so there is nowhere to send its users. Staff
 * recover an org whose IdP breaks by turning enforcement off from the back
 * office (app/api/admin/organizations/[orgId]/sso-enforcement).
 */

export type EnforceDecision =
  | { reject: false }
  | { reject: true; reason: "SSO_REQUIRED"; organizationId: string };

export interface EnforcedOrgInfo {
  organizationId: string;
  registeredProviderIds: string[];
}

/**
 * Single source of truth for "given an email domain, which org enforces SSO
 * for it?" (#673). Two call sites:
 *
 *   1. `lib/auth.ts` databaseHooks.session.create.before — pre-cookie veto
 *   2. `app/api/auth/sso/domain-check/route.ts` — unauth pre-login probe
 *
 * Returns `null` (= don't enforce) when any precondition fails:
 *   - No `OrgDomainClaim` row for the domain.
 *   - Claim exists but `verifiedAt IS NULL` (DNS TXT proof missing — a
 *     malicious OWNER who claimed a public domain like `google.com`
 *     without verifying must NOT be able to gate sessions for unrelated
 *     users).
 *   - Owning org is not ACTIVE (PENDING_VERIFICATION, SUSPENDED, DEACTIVATED).
 *   - `OrganizationSSOSettings.enforceSSO` is false.
 *
 * The verified claim is the only domain truth: every verified domain of an
 * enforcing org is enforced.
 *
 * See `docs/authentication/sso.md` §3.
 */
export async function lookupEnforcedOrg(
  prisma: PrismaLike, // #780 extended client
  domain: string,
): Promise<EnforcedOrgInfo | null> {
  const selectShape = {
    organizationId: true,
    verifiedAt: true,
    organization: {
      select: {
        status: true,
        ssoSettings: { select: { enforceSSO: true } },
      },
    },
  } as const;

  const claim =
    typeof prisma.orgDomainClaim.findFirst === "function"
      ? await prisma.orgDomainClaim.findFirst({
          where: { domain, verifiedAt: { not: null } },
          select: selectShape,
        })
      : await (
          prisma.orgDomainClaim as unknown as {
            findUnique: (args: {
              where: { domain: string };
              select: typeof selectShape;
            }) => Promise<{
              organizationId: string;
              verifiedAt: Date | null;
              organization: {
                status: string;
                ssoSettings: { enforceSSO: boolean } | null;
              } | null;
            } | null>;
          }
        ).findUnique({
          where: { domain },
          select: selectShape,
        });

  if (
    !claim ||
    !claim.verifiedAt ||
    !claim.organization ||
    claim.organization.status !== "ACTIVE" ||
    !claim.organization.ssoSettings?.enforceSSO
  ) {
    return null;
  }

  // Only staff-approved providers count. The sso() plugin refuses sign-in
  // through an unapproved one, so enforcing against it would lock the org
  // out; until approval the org fails open like it has no provider.
  const rows = await prisma.ssoProvider.findMany({
    where: { organizationId: claim.organizationId, domainVerified: true },
    select: { providerId: true },
  });

  return {
    organizationId: claim.organizationId,
    registeredProviderIds: rows.map((r) => r.providerId),
  };
}

export interface EnforceInputs {
  /** Email of the user the session is for. */
  email: string | null | undefined;
  /** BetterAuth's route template for the request, e.g. `/sso/callback/:providerId`. */
  path: string | null | undefined;
  /** `ctx.params.providerId` on the SSO callback. */
  providerId: string | null | undefined;
  /** The enforcing org and its approved provider ids, or null if the domain is not enforced. */
  lookupEnforcedOrg: (domain: string) => Promise<EnforcedOrgInfo | null>;
}

export async function shouldRejectSession(
  inputs: EnforceInputs,
): Promise<EnforceDecision> {
  const domain = inputs.email?.toLowerCase().split("@")[1];
  if (!domain) return { reject: false };

  const enforced = await inputs.lookupEnforcedOrg(domain);
  if (!enforced || enforced.registeredProviderIds.length === 0) {
    return { reject: false };
  }

  const viaOwnSso =
    inputs.path === "/sso/callback/:providerId" &&
    !!inputs.providerId &&
    enforced.registeredProviderIds.includes(inputs.providerId);
  if (viaOwnSso) return { reject: false };

  return {
    reject: true,
    reason: "SSO_REQUIRED",
    organizationId: enforced.organizationId,
  };
}

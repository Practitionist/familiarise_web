import type { PrismaLike } from "@/lib/prisma";
import {
  revokeAllUserSessions,
  revokeEmailDomainSessions,
  type RevokeResult,
} from "@/lib/auth/session-revoke";
import { emailDomain, providerDomains } from "@/lib/sso/domains";

/** The org's verified domains that an approved, proven provider covers. */
export async function enforceableDomains(
  db: PrismaLike,
  organizationId: string,
): Promise<string[]> {
  const claims = await db.orgDomainClaim.findMany({
    where: { organizationId, verifiedAt: { not: null } },
    select: { domain: true },
  });
  const providers = await db.ssoProvider.findMany({
    where: { organizationId, domainVerified: true, provenAt: { not: null } },
    select: { domain: true },
  });
  const covered = new Set(providers.flatMap((p) => providerDomains(p.domain)));
  return claims
    .map((c) => c.domain.trim().toLowerCase())
    .filter((d) => covered.has(d));
}

/**
 * When the org enforces SSO, ends the sessions of every user (member or not)
 * on its enforceable domains. `onlyDomains` narrows the sweep and
 * `keepSessionId` spares the caller's own session. The caller stamps `ended`
 * after commit.
 */
export async function revokeEnforcedDomainSessions(
  db: PrismaLike,
  organizationId: string,
  opts: { onlyDomains?: readonly string[]; keepSessionId?: string } = {},
): Promise<RevokeResult> {
  const swept: RevokeResult = { revoked: 0, ended: [] };
  const settings = await db.organizationSSOSettings.findUnique({
    where: { organizationId },
    select: { enforceSSO: true },
  });
  if (!settings?.enforceSSO) return swept;

  const only = opts.onlyDomains?.map((d) => d.toLowerCase());
  const domains = (await enforceableDomains(db, organizationId)).filter(
    (d) => !only || only.includes(d),
  );
  for (const domain of domains) {
    const result = await revokeEmailDomainSessions(
      db,
      domain,
      opts.keepSessionId,
    );
    swept.revoked += result.revoked;
    swept.ended.push(...result.ended);
  }
  return swept;
}

/**
 * Removing or suspending a member ends their sessions when their email is on
 * one of the org's verified domains, i.e. the org manages that identity.
 * The caller stamps `ended` after commit.
 */
export async function revokeOrgManagedUserSessions(
  db: PrismaLike,
  organizationId: string,
  userId: string,
): Promise<RevokeResult> {
  const none: RevokeResult = { revoked: 0, ended: [] };
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  const domain = emailDomain(user?.email);
  if (!domain) return none;
  const claim = await db.orgDomainClaim.findFirst({
    where: { organizationId, domain, verifiedAt: { not: null } },
    select: { id: true },
  });
  if (!claim) return none;
  return revokeAllUserSessions(db, userId);
}

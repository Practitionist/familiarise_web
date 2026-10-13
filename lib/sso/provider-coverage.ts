import type { PrismaLike } from "@/lib/prisma";
import { providerDomains } from "@/lib/sso/domains";

type GateError = Error & { httpStatus: number; code: string };

function gateError(
  httpStatus: number,
  code: string,
  message: string,
): GateError {
  return Object.assign(new Error(message), { httpStatus, code });
}

/**
 * Throws a tagged 422/409 unless every domain is a verified claim of the org
 * and no other provider of the org already covers it.
 */
export async function assertProviderDomains(
  db: PrismaLike,
  organizationId: string,
  domains: readonly string[],
  excludeProviderId?: string,
): Promise<void> {
  const claims = await db.orgDomainClaim.findMany({
    where: { organizationId, domain: { in: [...domains] } },
    select: { domain: true, verifiedAt: true },
  });
  const byDomain = new Map(claims.map((c) => [c.domain, c]));
  for (const domain of domains) {
    const claim = byDomain.get(domain);
    if (!claim) {
      throw gateError(
        422,
        "DOMAIN_NOT_OWNED",
        `Domain '${domain}' is not claimed by this organization. Claim and verify it first under Settings → SSO → Domains.`,
      );
    }
    if (!claim.verifiedAt) {
      throw gateError(
        422,
        "DOMAIN_NOT_VERIFIED",
        `Domain '${domain}' is claimed but not yet verified. Add the DNS TXT record and verify it first.`,
      );
    }
  }

  const others = await db.ssoProvider.findMany({
    where: {
      organizationId,
      ...(excludeProviderId ? { providerId: { not: excludeProviderId } } : {}),
    },
    select: { domain: true },
  });
  const taken = new Set(others.flatMap((p) => providerDomains(p.domain)));
  const clash = domains.find((d) => taken.has(d));
  if (clash) {
    throw gateError(
      409,
      "DOMAIN_ALREADY_COVERED",
      `Domain '${clash}' is already covered by another SSO provider of this organization.`,
    );
  }
}

import { APIError } from "better-auth/api";
import type { PrismaLike } from "@/lib/prisma";
import { emailDomain, providerDomains } from "@/lib/sso/domains";
import { recordSsoRefusal } from "@/lib/sso/refusal-audit";

/**
 * SSO enforcement is per email domain: a domain is enforced only when its
 * verified org enforces SSO and an approved provider an OWNER has proven covers
 * it. Every other domain fails open, so it is never locked out.
 */

export type EnforceDecision =
  | { reject: false }
  | { reject: true; reason: "SSO_REQUIRED"; organizationId: string };

export interface EnforcedOrgInfo {
  organizationId: string;
  registeredProviderIds: string[];
}

export interface DomainSso {
  organizationId: string;
  /** The org is ACTIVE, enforces SSO, and a covering provider is proven. */
  enforced: boolean;
  /** Approved providers that cover the domain, oldest first. */
  providerIds: string[];
}

/**
 * The approved SSO providers covering `domain`, and whether its org enforces
 * them. Null when no verified claim exists, the org is suspended or
 * deactivated, or no approved provider covers the domain.
 */
export async function lookupDomainSso(
  prisma: PrismaLike,
  domain: string,
): Promise<DomainSso | null> {
  const claim = await prisma.orgDomainClaim.findFirst({
    where: { domain, verifiedAt: { not: null } },
    select: {
      organizationId: true,
      organization: {
        select: {
          status: true,
          ssoSettings: { select: { enforceSSO: true } },
        },
      },
    },
  });
  const status = claim?.organization?.status;
  if (!claim || !status || status === "SUSPENDED" || status === "DEACTIVATED") {
    return null;
  }

  const rows = await prisma.ssoProvider.findMany({
    where: { organizationId: claim.organizationId, domainVerified: true },
    select: { providerId: true, domain: true, provenAt: true },
    orderBy: { createdAt: "asc" },
  });
  const covering = rows.filter((r) =>
    providerDomains(r.domain).includes(domain),
  );
  if (covering.length === 0) return null;

  return {
    organizationId: claim.organizationId,
    enforced:
      status === "ACTIVE" &&
      !!claim.organization?.ssoSettings?.enforceSSO &&
      covering.some((r) => r.provenAt !== null),
    providerIds: covering.map((r) => r.providerId),
  };
}

/** The enforcing org and the providers that may mint a session for `domain`. */
export async function lookupEnforcedOrg(
  prisma: PrismaLike,
  domain: string,
): Promise<EnforcedOrgInfo | null> {
  const sso = await lookupDomainSso(prisma, domain);
  return sso?.enforced
    ? {
        organizationId: sso.organizationId,
        registeredProviderIds: sso.providerIds,
      }
    : null;
}

export interface EnforceInputs {
  /** Email of the user the session is for. */
  email: string | null | undefined;
  /** BetterAuth's route template for the request, e.g. `/sso/callback/:providerId`. */
  path: string | null | undefined;
  /** `ctx.params.providerId` on the SSO callback. */
  providerId: string | null | undefined;
  /** The enforcing org and the providers covering the domain, or null if not enforced. */
  lookupEnforcedOrg: (domain: string) => Promise<EnforcedOrgInfo | null>;
}

export async function shouldRejectSession(
  inputs: EnforceInputs,
): Promise<EnforceDecision> {
  const domain = emailDomain(inputs.email);
  if (!domain) return { reject: false };

  const enforced = await inputs.lookupEnforcedOrg(domain);
  if (!enforced || enforced.registeredProviderIds.length === 0) {
    return { reject: false };
  }

  const viaCoveringSso =
    inputs.path === "/sso/callback/:providerId" &&
    !!inputs.providerId &&
    enforced.registeredProviderIds.includes(inputs.providerId);
  if (viaCoveringSso) return { reject: false };

  return {
    reject: true,
    reason: "SSO_REQUIRED",
    organizationId: enforced.organizationId,
  };
}

/** `session.create.before` gate: throws SSO_REQUIRED and records the refusal. */
export async function assertSsoSessionAllowed(
  prisma: PrismaLike,
  input: Omit<EnforceInputs, "lookupEnforcedOrg">,
): Promise<void> {
  const decision = await shouldRejectSession({
    ...input,
    lookupEnforcedOrg: (domain) => lookupEnforcedOrg(prisma, domain),
  });
  if (!decision.reject) return;
  if (input.email) {
    await recordSsoRefusal({
      organizationId: decision.organizationId,
      code: "SSO_REQUIRED",
      email: input.email,
      path: input.path,
    });
  }
  throw new APIError("FORBIDDEN", {
    message:
      "This email domain requires SSO sign-in through your organization's provider. Password and Google sign-in are off for it.",
    code: "SSO_REQUIRED",
  });
}

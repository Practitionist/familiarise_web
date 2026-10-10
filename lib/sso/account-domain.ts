import { APIError } from "better-auth/api";
import prisma from "@/lib/prisma";
import { emailDomain, providerDomains } from "@/lib/sso/domains";
import { recordSsoRefusal } from "@/lib/sso/refusal-audit";

// Every other Account.providerId is treated as an SsoProvider.providerId. A new
// social provider must be added here; until it is, its sign-ins fail closed
// with SSO_EMAIL_DOMAIN_MISMATCH rather than skipping the domain check.
const NON_SSO_PROVIDERS = new Set(["credential", "google", "github"]);

export function isSsoProviderId(providerId: string): boolean {
  return !NON_SSO_PROVIDERS.has(providerId);
}

/**
 * Throws unless the provider is staff-approved, covers the email's domain, and
 * its org still holds a verified claim for that domain. Otherwise an approved
 * org's IdP could assert victim@gmail.com and own that address.
 */
export async function assertSsoEmailOnDomain(
  providerId: string | undefined,
  email: string | null | undefined,
): Promise<void> {
  const domain = emailDomain(email);
  const provider =
    providerId && domain
      ? await prisma.ssoProvider.findUnique({
          where: { providerId },
          select: { domain: true, domainVerified: true, organizationId: true },
        })
      : null;
  const organizationId = provider?.organizationId;
  const covered =
    !!provider?.domainVerified &&
    !!organizationId &&
    !!domain &&
    providerDomains(provider.domain).includes(domain) &&
    !!(await prisma.orgDomainClaim.findFirst({
      where: { organizationId, domain, verifiedAt: { not: null } },
      select: { id: true },
    }));
  if (covered) return;
  if (organizationId && email) {
    await recordSsoRefusal({
      organizationId,
      code: "SSO_EMAIL_DOMAIN_MISMATCH",
      email,
    });
  }
  throw new APIError("FORBIDDEN", {
    message:
      "This sign-in returned an email outside the organization's domain.",
    code: "SSO_EMAIL_DOMAIN_MISMATCH",
  });
}

/**
 * `account.create.before` for SSO providers: the domain check above, and at
 * most one identity per provider per user, so a second IdP subject cannot
 * link into an account that already has one.
 */
export async function assertSsoAccountLink(
  account: { userId: string; providerId: string; accountId: string },
  email: string | null | undefined,
): Promise<void> {
  await assertSsoEmailOnDomain(account.providerId, email);
  const other = await prisma.account.findFirst({
    where: {
      userId: account.userId,
      providerId: account.providerId,
      accountId: { not: account.accountId },
    },
    select: { id: true },
  });
  if (other) {
    throw new APIError("FORBIDDEN", {
      message:
        "This account is already linked to a different identity at your organization's provider.",
      code: "SSO_ACCOUNT_ALREADY_LINKED",
    });
  }
}

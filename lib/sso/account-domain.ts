import { APIError } from "better-auth/api";
import prisma from "@/lib/prisma";

// Every other Account.providerId is treated as an SsoProvider.providerId. A new
// social provider must be added here; until it is, its sign-ins fail closed
// with SSO_EMAIL_DOMAIN_MISMATCH rather than skipping the domain check.
const NON_SSO_PROVIDERS = new Set(["credential", "google", "github"]);

export function isSsoProviderId(providerId: string): boolean {
  return !NON_SSO_PROVIDERS.has(providerId);
}

/**
 * Throws unless the SSO provider is staff-approved and the email is on its own
 * domain. Otherwise an approved org's IdP could assert victim@gmail.com and own
 * that address before its real owner signs up — and the link would survive
 * their later password reset.
 */
export async function assertSsoEmailOnDomain(
  providerId: string | undefined,
  email: string | null | undefined,
): Promise<void> {
  const domain = email?.toLowerCase().split("@")[1];
  const provider =
    providerId && domain
      ? await prisma.ssoProvider.findUnique({
          where: { providerId },
          select: { domain: true, domainVerified: true },
        })
      : null;
  if (provider?.domainVerified && provider.domain.toLowerCase() === domain) {
    return;
  }
  throw new APIError("FORBIDDEN", {
    message:
      "This sign-in returned an email outside the organization's domain.",
    code: "SSO_EMAIL_DOMAIN_MISMATCH",
  });
}

import type { SSOOptions } from "@better-auth/sso";
import prisma from "@/lib/prisma";
import { emailDomain, providerDomains } from "@/lib/sso/domains";
import { assertIdpClaims, decodeIdTokenClaims } from "@/lib/sso/idp-claims";
import { provisionSsoMembership } from "@/lib/sso/jit-membership";
import { stampProviderProven } from "@/lib/sso/provider-proof";

/**
 * Options for the sso() plugin, kept out of lib/auth.ts so the OIDC round-trip
 * test (__tests__/sso/oidc-round-trip.test.ts) mounts exactly this config.
 */
export const ssoPluginOptions = {
  // Sign-in and the callback refuse a provider until the ADMIN approval door
  // sets `domainVerified`; the plugin's verify-domain endpoints are disabled.
  domainVerification: { enabled: true },
  // Belt to `/sso/register` being disabled: no user may own a provider.
  providersLimit: 0,
  // Membership comes from `provisionUser`, which applies our lifecycle and
  // seat gates; the plugin's org-plugin provisioning would skip them.
  organizationProvisioning: { disabled: true },
  // Every login, so the claim checks always run and a join refused by the seat
  // cap goes through once a seat frees up.
  provisionUserOnEveryLogin: true,
  provisionUser: async ({ user, token, provider }) => {
    const domains = providerDomains(provider.domain);
    try {
      assertIdpClaims(decodeIdTokenClaims(token?.idToken), domains);
    } catch (refusal) {
      // No cookie is set after a throw here; drop the link this login made so
      // a refused identity cannot block the real one (one identity per provider).
      await prisma.account.deleteMany({
        where: { userId: user.id, providerId: provider.providerId },
      });
      throw refusal;
    }
    const domain = emailDomain(user.email);
    if (!domain || !domains.includes(domain)) return;
    const outcome = await provisionSsoMembership({
      userId: user.id,
      email: user.email,
      providerId: provider.providerId,
      organizationId: provider.organizationId,
    });
    if (outcome.kind !== "skipped") {
      await stampProviderProven({
        providerId: provider.providerId,
        organizationId: outcome.organizationId,
        userId: user.id,
      });
    }
  },
} satisfies SSOOptions;

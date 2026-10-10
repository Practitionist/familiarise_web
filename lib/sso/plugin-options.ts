import type { SSOOptions } from "@better-auth/sso";
import { emailDomain, providerDomains } from "@/lib/sso/domains";
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
  // Every login, so a join refused by the seat cap goes through once a seat
  // frees up. IdP claims are checked earlier, in the account hooks (lib/auth.ts).
  provisionUserOnEveryLogin: true,
  provisionUser: async ({ user, provider }) => {
    const domains = providerDomains(provider.domain);
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

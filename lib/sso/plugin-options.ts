import type { SSOOptions } from "@better-auth/sso";
import { provisionSsoMembership } from "@/lib/sso/jit-membership";

/**
 * Options for the sso() plugin, kept out of lib/auth.ts so the OIDC round-trip
 * test (__tests__/sso/oidc-round-trip.test.ts) mounts exactly this config.
 */
export const ssoPluginOptions = {
  // D10b: sign-in and the OIDC callback refuse any provider whose
  // `domainVerified` is false. The org proves the domain with the app's
  // own DNS TXT claim (OrgDomainClaim.verifiedAt, required at create),
  // and only the ADMIN approval door flips the flag. The plugin's own
  // verify-domain endpoints are in `disabledPaths` in lib/auth.ts.
  domainVerification: { enabled: true },
  // Belt to `/sso/register` being disabled: no user may own a provider.
  providersLimit: 0,
  // The plugin's provisioning assigns org-plugin roles by email domain
  // match and would skip our lifecycle and seat gates; membership comes
  // from `provisionUser` below instead.
  organizationProvisioning: { disabled: true },
  // Every login, not only the first: a user who links SSO to an existing
  // account is not a "registration", and a join refused by the seat cap
  // should go through once a seat frees up. A no-op for existing members.
  provisionUserOnEveryLogin: true,
  provisionUser: async ({ user, provider }) => {
    await provisionSsoMembership({
      userId: user.id,
      providerId: provider.providerId,
      organizationId: provider.organizationId,
    });
  },
} satisfies SSOOptions;

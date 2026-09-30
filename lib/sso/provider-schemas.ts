/**
 * Zod schemas for SSO provider registration. SSO is OIDC-only.
 *
 * The OIDC redirect path shown in the Add Provider dialog is verified against
 * `@better-auth/sso@1.6.5`, not assumed: `dist/index.mjs:2700` mounts
 * `/sso/callback/:providerId`, and `basePath` is unset in `lib/auth.ts`, so
 * BetterAuth's `/api/auth` default applies. `lib/sso/derive-urls.ts` is the
 * single place that string is built. Re-check it in
 * `node_modules/@better-auth/sso/dist/index.mjs` on every version bump.
 *
 * Extracted from the API route so the shape can be unit-tested.
 */

import { z } from "zod";
import { AUTH_PROVIDERS } from "@/lib/auth-providers";

export const oidcConfigSchema = z.object({
  issuer: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  discoveryEndpoint: z.string().url(),
  pkce: z.boolean().default(true),
  scopes: z.array(z.string()).optional(),
});

/**
 * Provider ids a tenant may not claim, because claiming one hands them
 * somebody else's sign-in button.
 *
 * ## The vulnerability this closes
 *
 * `providerId` is BetterAuth's URL slug for the whole SSO surface —
 * `/api/auth/sso/callback/{id}` — and it is a *globally* unique column, not per-org. The only validation it had was
 * `regex(/^[a-z0-9-]+$/i)`, which "google" passes. So any tenant whose domain
 * was claimed and verified could register `providerId: "google"`, and
 * BetterAuth's sign-in would resolve a bare `/api/auth/sso/callback/google`
 * or the org's own SSO button to that tenant's IdP. Whether that is a
 * cross-tenant account-takeover or just a self-inflicted outage depends on
 * which provider row wins the lookup, and which one wins is not something a
 * tenant should be able to decide for other tenants.
 *
 * ## Why 1.6.5 does not save us
 *
 * The instinct is to lean on BetterAuth's own `registerSSOProvider`, which
 * rejects a colliding `providerId` with a 422 (`dist/index.mjs:2141-2150`).
 * That check is only a *uniqueness* check. There is no reserved-name or
 * social-provider-collision check anywhere in the 1.6.5 plugin — grep
 * `credential`, `reserved` and `socialProvider` across
 * `node_modules/@better-auth/sso/dist/index.mjs` and they do not appear. The
 * reserved-id rule is ours to enforce, which is also fortunate given C1: the
 * create route cannot call `registerSSOProvider` at all
 * (`lib/sso/oidc-discovery.ts` documents why).
 *
 * ## The set
 *
 *   - `AUTH_PROVIDERS` (`lib/auth-providers.ts`) — the social/OAuth buttons
 *     this app renders. Beyond the URL hijack, an `Account.providerId` row
 *     and an `SsoProvider.providerId` row sharing an id is a genuinely
 *     ambiguous state for account linking.
 *   - `accountLinking.trustedProviders` (`lib/auth.ts:191`) — the same three
 *     ids today, listed separately so a future divergence is visible here
 *     rather than silently load-bearing.
 *   - `credential` — BetterAuth's own id for email+password accounts. The
 *     `enforceSSO` check in `lib/sso/enforce-session.ts` reasons about
 *     `Account.providerId`; a provider claiming `credential` would make
 *     "linked an account with this provider" trivially true.
 *   - The `sso`-prefixed plugin id itself, so a tenant cannot squat the
 *     namespace the plugin reserves for future built-ins.
 *
 * Matching is case-insensitive because `providerId` is lowercased nowhere in
 * the write path but BetterAuth's own provider lookup is reached through URLs
 * that a client may present in any case; refusing `Google` alongside `google`
 * keeps the slug space unambiguous.
 */
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "credential",
  "sso",
  // `AUTH_PROVIDERS[].id` is a `as const` union of already-lowercase ids, so
  // it covers `accountLinking.trustedProviders` (lib/auth.ts:191) as well as
  // the rendered social buttons. `scripts/verify-sso-invariants.sh` Check 4
  // pins the enforcement check to those same rows, so the two cannot drift
  // apart without that grep failing.
  ...AUTH_PROVIDERS.map((provider) => provider.id),
]);

const RESERVED_PROVIDER_ID_MESSAGE =
  "That providerId is reserved. It would shadow a sign-in method that already exists " +
  "(Google, GitHub, Facebook, or email+password), so another organisation's users " +
  `could be redirected to your identity provider. Reserved ids: ${[
    ...RESERVED_PROVIDER_IDS,
  ]
    // `localeCompare` with an explicitly pinned locale, per Sonar
    // `js/unicorn/no-array-sort` (which it grades as a BUG, so it gates the
    // merge). The second argument is the load-bearing part: `localeCompare(b)`
    // with no locale reads the host default, which makes the output a function
    // of how a machine is configured. I could not actually make that variance
    // reproduce — Node's ICU returned identical order under C, tr_TR, sv_SE and
    // de_DE — so the pinning is about removing the dependency on host config
    // rather than fixing an observed bug. What it *does* fix is the reading
    // order: bare `.sort()` is UTF-16 code-unit order, so a customer reading
    // the list sees `Y, Zebra, apple, credential` — capital letters first, and
    // `apple` after `Zebra`. Pinned to "en" this reads as a list of words.
    .sort((a, b) => a.localeCompare(b, "en"))
    .join(", ")}. Pick a name that identifies your organisation, e.g. "acme-okta".`;

export function isReservedProviderId(providerId: string): boolean {
  return RESERVED_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

export const createProviderSchema = z
  .object({
    providerId: z
      .string()
      .trim()
      .min(2)
      .max(50)
      .regex(/^[a-z0-9-]+$/i, "providerId must be alphanumeric"),
    domain: z.string().trim().min(3).max(255),
    issuer: z.string().trim().min(1).max(500),
    providerType: z.literal("oidc"),
    oidcConfig: oidcConfigSchema,
  })
  .superRefine((value, ctx) => {
    if (isReservedProviderId(value.providerId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerId"],
        message: RESERVED_PROVIDER_ID_MESSAGE,
      });
    }
  });

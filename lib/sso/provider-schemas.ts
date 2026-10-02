/**
 * Zod schemas for SSO provider registration. SSO is OIDC-only.
 *
 * The OIDC redirect path shown in the provider table is verified against
 * `@better-auth/sso@1.7.6`, not assumed: `dist/index.mjs:4153` mounts
 * `/sso/callback/:providerId`, and `basePath` is unset in `lib/auth.ts`, so
 * BetterAuth's `/api/auth` default applies. `lib/sso/derive-urls.ts` is the
 * single place that string is built. Re-check it in
 * `node_modules/@better-auth/sso/dist/index.mjs` on every version bump.
 *
 * Extracted from the API route so the shape can be unit-tested.
 */

import { randomBytes } from "node:crypto";
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
 * `/api/auth/sso/callback/{id}` — and it is a *globally* unique column, not
 * per-org. When tenants chose it, any tenant with a verified domain could
 * register `providerId: "google"` and have BetterAuth resolve that slug to
 * their IdP. Whether that is a cross-tenant takeover or a self-inflicted
 * outage depends on which row wins the lookup, which no tenant should decide.
 *
 * ## Why it is still checked
 *
 * The create route now generates the id itself (`generateProviderId`), so a
 * tenant cannot pick one at all. The set stays as a second line: the
 * generated prefix must never produce a member of it, and the DB CHECK
 * `sso_provider_id_not_reserved` (`prisma/sql/check-constraints.sql`)
 * refuses the same ids from any other writer. 1.7's `registerSSOProvider`
 * does reject reserved ids, but that endpoint is disabled in `lib/auth.ts`.
 *
 * ## The set
 *
 *   - `AUTH_PROVIDERS` (`lib/auth-providers.ts`) — the social/OAuth buttons
 *     this app renders. Beyond the URL hijack, an `Account.providerId` row
 *     and an `SsoProvider.providerId` row sharing an id is a genuinely
 *     ambiguous state for account linking.
 *   - `facebook` — no longer offered, but `Account` rows with that
 *     providerId can still exist, so the id stays taken.
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
  "facebook",
  // `AUTH_PROVIDERS[].id` is a `as const` union of already-lowercase ids.
  ...AUTH_PROVIDERS.map((provider) => provider.id),
]);

export function isReservedProviderId(providerId: string): boolean {
  return RESERVED_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}

/**
 * A fresh, unguessable provider slug. The `oidc-` prefix keeps it out of
 * every reserved id and every social provider id BetterAuth could add, and
 * hex keeps it inside the `[a-z0-9-]` shape the callback URL expects.
 */
export function generateProviderId(): string {
  return `oidc-${randomBytes(8).toString("hex")}`;
}

export const createProviderSchema = z.object({
  domain: z.string().trim().min(3).max(255),
  issuer: z.string().trim().min(1).max(500),
  providerType: z.literal("oidc"),
  oidcConfig: oidcConfigSchema,
});

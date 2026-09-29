/**
 * Zod schemas for SSO provider registration.
 *
 * `callbackUrl` is deliberately absent from `samlConfigSchema`: BetterAuth
 * auto-derives the ACS URL as `{baseURL}/api/auth/sso/saml2/sp/acs/{providerId}`,
 * and accepting a user-typed override silently breaks SAML when the value
 * drifts from BetterAuth's derived URL. The read-only URL shown in the Add
 * Provider dialog is always in sync because both it and BetterAuth derive
 * from the same `providerId`. The *stored* config still carries the key —
 * BetterAuth's body schema types it as required — with a falsy value so every
 * read falls through to the derivation; see `lib/sso/stored-config.ts`.
 *
 * The ACS path above is verified against `@better-auth/sso@1.6.5`, not
 * assumed. `dist/index.mjs:2784` mounts
 * `createAuthEndpoint("/sso/saml2/sp/acs/:providerId")` and `:2797` builds
 * `currentCallbackPath` as `${ctx.context.baseURL}/sso/saml2/sp/acs/${providerId}`;
 * `basePath` is unset in `lib/auth.ts`, so BetterAuth's `/api/auth` default
 * applies and the mounted path is `/api/auth/sso/saml2/sp/acs/{providerId}`.
 * `lib/sso/derive-urls.ts` is the single place that string is built. Re-check
 * it in `node_modules/@better-auth/sso/dist/index.mjs` on every version bump —
 * the OIDC callback (`/sso/callback/:providerId`, `:2700`) and the metadata
 * endpoint (`/sso/saml2/sp/metadata`, `:1823`, which takes `providerId` as a
 * *query* param) are asserted the same way.
 *
 * Extracted from the API route so the shape can be unit-tested and so any
 * future edits to `samlConfigSchema` must touch this single file — which
 * the invariants check in `scripts/verify-sso-invariants.sh` greps for the
 * forbidden `callbackUrl` key.
 */

import { X509Certificate } from "node:crypto";
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
 * Validate a SAML signing certificate as a parseable PEM-encoded X.509.
 *
 * Why we validate here, not later:
 *   BetterAuth's underlying SAML adapter (`@node-saml/node-saml`) parses
 *   the cert lazily inside `validatePostResponse` when an assertion
 *   arrives. If the cert is garbage, the call chain crashes with
 *     TypeError: Cannot read properties of undefined (reading 'metadata')
 *   and returns a 500 with an empty body to the user clicking the SSO
 *   button. The UI has no way to recover — there's no error message
 *   to surface. By validating at the schema layer (registration time),
 *   we fail closed with a friendly PEM-format error that the admin
 *   actually sees in the Add Provider dialog.
 *
 * What Node's X509Certificate accepts:
 *   - PEM-encoded with `-----BEGIN CERTIFICATE-----` / `-----END CERTIFICATE-----`
 *     markers and base64 body.
 *   - DER-encoded (binary) — passed as a Buffer.
 *   - Throws `ERR_OSSL_*` or `ERR_INVALID_ARG_TYPE` on anything else.
 *   Wrapping in try/catch normalizes both error families to a boolean.
 *
 * See audit Phase A.2 + `docs/enterprise/20-iam-and-security/01-sso-and-authentication.md#cert-rotation`.
 */
/**
 * Exported because the same parse-or-fail check needs to run at two
 * additional sites beyond schema registration:
 *
 *   1. The pre-auth `/api/auth/sso/domain-check` endpoint, to short-circuit
 *      with `SSO_PROVIDER_MISCONFIGURED` BEFORE the user is bounced to
 *      BetterAuth's SAML flow (which would crash the request and return
 *      an empty-body 500 — see audit Phase A.2).
 *
 *   2. The daily `sso-cert-expiry-alert` cron, to detect legacy provider
 *      rows whose certs were registered before this validator existed.
 */
export function validateSamlCert(value: string): boolean {
  try {
    // The constructor parses the cert; we don't need the instance.
    new X509Certificate(value);
    return true;
  } catch {
    return false;
  }
}

export const samlConfigSchema = z.object({
  issuer: z.string().min(1),
  entryPoint: z.string().url(),
  cert: z.string().refine(validateSamlCert, {
    message:
      "Invalid X.509 certificate. Paste the PEM block from your IdP — it should start with -----BEGIN CERTIFICATE----- and end with -----END CERTIFICATE-----. If you copied a base64 fingerprint by mistake, your IdP's admin console has a separate 'Certificate (PEM)' download.",
  }),
});

/**
 * Provider ids a tenant may not claim, because claiming one hands them
 * somebody else's sign-in button.
 *
 * ## The vulnerability this closes
 *
 * `providerId` is BetterAuth's URL slug for the whole SSO surface —
 * `/api/auth/sso/callback/{id}`, `/api/auth/sso/saml2/sp/acs/{id}` — and it
 * is a *globally* unique column, not per-org. The only validation it had was
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
  // the rendered social buttons. `scripts/verify-sso-invariants.sh` Check 5
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
    // Bare `.sort()` on purpose — Sonar asks for `localeCompare` here
    // (js/unicorn/no-array-sort), and applying it would be a regression.
    // `localeCompare` with no locale argument reads the *host* default, so the
    // list a customer sees on a dev machine can differ from the one Netlify
    // renders, and uppercase-lowercase ordering flips (`"Y"` before `"apple"`
    // under code-unit order, after it under a collation). Bare `.sort()` is
    // UTF-16 code-unit order: locale-independent, and since every reserved id
    // here is already lowercase ASCII, it is also the correct alphabetical
    // order. The rule wants prettier collation; the trade is determinism.
    .sort()
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
    providerType: z.enum(["saml", "oidc"]),
    samlConfig: samlConfigSchema.optional(),
    oidcConfig: oidcConfigSchema.optional(),
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


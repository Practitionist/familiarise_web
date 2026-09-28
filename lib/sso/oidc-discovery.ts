/**
 * Registration-time OIDC discovery for tenant IdPs.
 *
 * ## The defect this closes
 *
 * The POST /providers route used to write `oidcConfig` as whatever the admin
 * typed — `{issuer, clientId, clientSecret, discoveryEndpoint, pkce,
 * scopes}`. None of the endpoints BetterAuth needs at login were present, so
 * on the first sign-in `@better-auth/sso@1.6.5` fell into
 * `ensureRuntimeDiscovery` (`dist/index.mjs:2410`, `:2561`), which fetches
 * the discovery document *at login time*. Registration therefore never
 * validated the IdP at all: a typo in `discoveryEndpoint` surfaced to the
 * customer as a failed sign-in, minutes or days after the admin believed
 * setup was done. Running discovery here means a bad IdP is rejected at
 * registration, while the admin is still looking at the form.
 *
 * ## Why not just let `auth.api.registerSSOProvider` do it
 *
 * Because it cannot, for two independent reasons. Both are properties of the
 * plugin at the pinned 1.6.5, and both are documented at their call sites in
 * the route that uses this module:
 *
 *   1. **The `userId` cascade.** `registerSSOProvider` hardcodes
 *      `userId: ctx.context.session.user.id` (`dist/index.mjs:2243`) and the
 *      body schema has no field to override it. `SsoProvider.userId` is an FK
 *      with `onDelete: Cascade`, so binding an org-scoped provider to the
 *      admin who registered it means deleting that admin deletes the org's
 *      SSO. `scripts/verify-sso-invariants.sh` Check 4 exists specifically to
 *      forbid this.
 *
 *   2. **Discovery is gated on the app's own `trustedOrigins`.**
 *      `discoverOIDCConfig` calls its `isTrustedOrigin` predicate on the
 *      discovery URL and on every endpoint it normalizes
 *      (`dist/index.mjs:1090-1092`, `:1176-1184`). BetterAuth resolves that
 *      predicate to `this.trustedOrigins.some(...)`
 *      (`better-auth/dist/context/create-context.mjs:139-141`), i.e. our
 *      `BETTER_AUTH_TRUSTED_ORIGINS` — a list of *our own* origins, empty by
 *      default (`lib/auth.ts:54-56`). A tenant's IdP is never in it, so
 *      discovery fails with `discovery_untrusted_origin` for every real
 *      enterprise IdP. Setting `skipDiscovery: true` sidesteps the check but
 *      hands the discovery document's three endpoints back to the admin as
 *      manual fields, which is the defect above all over again.
 *
 * So this module calls BetterAuth's **own exported** discovery pipeline with a
 * tenant-appropriate trust predicate. Using the library's `discoverOIDCConfig`
 * rather than a hand-rolled fetch is the point: its issuer-match check, its
 * required-field check, its relative-URL resolution and its
 * `token_endpoint_auth_methods_supported` preference are all reused verbatim,
 * so a 1.7 upgrade cannot leave us running a divergent copy.
 *
 * ## The trust predicate, and why a shape check is not the SSRF guard
 *
 * `discoverOIDCConfig` takes a *synchronous* `isTrustedOrigin`, so it cannot
 * do a DNS lookup. We pass a shape check (parseable, http/https) and carry
 * the actual security decision on `assertPublicUrl`, which does resolve DNS
 * and rejects every private/loopback/link-local/CGNAT answer:
 *
 *   - Before the call: `assertPublicUrl(discoveryEndpoint)`. This is the only
 *     URL `discoverOIDCConfig` fetches, so guarding it is what stops an org
 *     admin from pointing us at `169.254.169.254` or an internal service and
 *     reading the response back out of an error message. It reuses
 *     `lib/enterprise/outbound-webhooks/ssrf-guard.ts` — the same guard, and
 *     the same fail-closed semantics, that customer-supplied webhook URLs
 *     already go through (#1132).
 *   - After the call: `assertPublicUrl` on each discovered endpoint. Those
 *     are the URLs BetterAuth will later dial during the code-for-token
 *     exchange and the JWKS fetch, so they are checked before being persisted.
 *
 * The shape predicate therefore never authorises a fetch that has not already
 * been checked; it exists only to satisfy `discoverOIDCConfig`'s contract and
 * to reject a nonsense endpoint early with a better error.
 */

import {
  discoverOIDCConfig,
  DiscoveryError,
  type HydratedOIDCConfig,
  type OIDCConfig,
} from "@better-auth/sso";
import {
  assertPublicUrl,
  SsrfBlockedError,
} from "@/lib/enterprise/outbound-webhooks/ssrf-guard";

/**
 * Why discovery failed, as a closed set. Each maps to a distinct operator
 * action, and the route turns them into distinct HTTP responses.
 */
export type OidcDiscoveryFailure =
  /** Discovery endpoint is not a publicly routable https URL (SSRF guard). */
  | "discovery_endpoint_blocked"
  /** A discovered endpoint failed the same guard. */
  | "discovered_endpoint_blocked"
  /** The IdP did not answer, or answered with an unusable status. */
  | "discovery_unreachable"
  /** Discovery document is not valid JSON. */
  | "discovery_invalid_json"
  /** Discovery document is missing issuer/authorization/token/jwks. */
  | "discovery_incomplete"
  /** Document's `issuer` does not match the configured issuer. */
  | "issuer_mismatch"
  /** Anything else the pipeline rejected. */
  | "discovery_failed";

export class OidcDiscoveryError extends Error {
  readonly failure: OidcDiscoveryFailure;

  constructor(failure: OidcDiscoveryFailure, message: string) {
    super(message);
    this.name = "OidcDiscoveryError";
    this.failure = failure;
  }
}

/**
 * Synchronous predicate handed to `discoverOIDCConfig` in place of
 * BetterAuth's `trustedOrigins` check. See the module header: the real guard
 * is `assertPublicUrl`, run before and after the call.
 */
function isHttpUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function fromSsrf(
  err: SsrfBlockedError,
  failure: OidcDiscoveryFailure,
): OidcDiscoveryError {
  return new OidcDiscoveryError(
    failure,
    `The identity provider is not reachable from our servers (${err.message}). ` +
      "Use a publicly routable https:// issuer URL.",
  );
}

/** Operator-facing next step per failure, so no raw library message leaks. */
const ADMIN_HINT: Record<OidcDiscoveryFailure, string> = {
  discovery_endpoint_blocked:
    "The discovery URL must be a publicly routable https:// address on the internet.",
  discovered_endpoint_blocked:
    "The identity provider's discovery document points at an endpoint we cannot reach (a private or internal address). This is an IdP configuration problem.",
  discovery_unreachable:
    "The identity provider did not answer. Check the issuer and discovery URL, and that it is reachable from the public internet.",
  discovery_invalid_json:
    "The discovery endpoint did not return JSON, so it is probably not an OIDC discovery document.",
  discovery_incomplete:
    "The discovery document is missing issuer, authorization_endpoint, token_endpoint or jwks_uri. This issuer does not look like a full OIDC provider.",
  issuer_mismatch:
    "The discovery document's issuer does not match the issuer entered here. Copy both values from the same IdP page.",
  discovery_failed:
    "OIDC discovery failed for this issuer.",
};

/**
 * Map a BetterAuth `DiscoveryError.code` onto our failure set. The codes are
 * the literals the plugin throws (`dist/index.mjs:1003-1013`); the full
 * upstream list is enumerated in `mapDiscoveryErrorToAPIError` in the same
 * file.
 */
function fromDiscoveryError(err: DiscoveryError): OidcDiscoveryError {
  const failure: OidcDiscoveryFailure =
    err.code === "discovery_timeout" || err.code === "discovery_unexpected_error"
      ? "discovery_unreachable"
      : err.code === "discovery_invalid_json"
        ? "discovery_invalid_json"
        : err.code === "discovery_incomplete"
          ? "discovery_incomplete"
          : err.code === "issuer_mismatch"
            ? "issuer_mismatch"
            : "discovery_failed";

  return new OidcDiscoveryError(failure, ADMIN_HINT[failure]);
}

/**
 * The hydrated OIDC config to persist.
 *
 * `tokenEndpointAuthentication` comes from BetterAuth's own
 * `selectTokenEndpointAuthMethod` (already applied inside
 * `discoverOIDCConfig` from the document's
 * `token_endpoint_auth_methods_supported`), so the persisted value tracks
 * what the IdP actually accepts rather than a guess.
 */
export type DiscoveredOidcConfig = Pick<
  HydratedOIDCConfig,
  | "authorizationEndpoint"
  | "tokenEndpoint"
  | "jwksEndpoint"
  | "userInfoEndpoint"
  | "tokenEndpointAuthentication"
>;

/**
 * Run OIDC discovery and return the endpoints to persist.
 *
 * Throws {@link OidcDiscoveryError}; the caller maps that onto a 422 the
 * operator can act on. Never returns a partial config — a provider is
 * registered with all three required endpoints or not at all, so
 * BetterAuth's `needsRuntimeDiscovery` (`dist/index.mjs:1264-1267`) is false
 * at login and no discovery fetch happens on the sign-in path.
 */
export async function discoverOidcConfigForTenant(
  issuer: string,
  discoveryEndpoint: string,
): Promise<DiscoveredOidcConfig> {
  try {
    await assertPublicUrl(discoveryEndpoint);
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      throw fromSsrf(err, "discovery_endpoint_blocked");
    }
    throw err;
  }

  let hydrated: HydratedOIDCConfig;
  try {
    hydrated = await discoverOIDCConfig({
      issuer,
      existingConfig: { discoveryEndpoint },
      isTrustedOrigin: isHttpUrl,
    });
  } catch (err) {
    if (err instanceof DiscoveryError) throw fromDiscoveryError(err);
    // betterFetch turns DNS/TLS/socket failures into a DiscoveryError, but a
    // bug in our predicate would surface as a TypeError. Neither should
    // escape as an unhandled 500 on a registration form.
    throw new OidcDiscoveryError("discovery_failed", ADMIN_HINT.discovery_failed);
  }

  // Every one of these is dialled later on the sign-in path, so none of them
  // is persisted without passing the guard first.
  const toGuard: Array<[string, string | undefined]> = [
    ["authorization_endpoint", hydrated.authorizationEndpoint],
    ["token_endpoint", hydrated.tokenEndpoint],
    ["jwks_uri", hydrated.jwksEndpoint],
    ["userinfo_endpoint", hydrated.userInfoEndpoint],
  ];
  for (const [, url] of toGuard) {
    if (!url) continue;
    try {
      await assertPublicUrl(url);
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        throw fromSsrf(err, "discovered_endpoint_blocked");
      }
      throw err;
    }
  }

  // `validateDiscoveryDocument` inside `discoverOIDCConfig` already guarantees
  // these three, so this is type narrowing rather than a new rule. The check
  // stays because a config missing them is exactly the "OIDC provider is not
  // configured" state that would strand an admin who had just clicked Save.
  if (
    !hydrated.authorizationEndpoint ||
    !hydrated.tokenEndpoint ||
    !hydrated.jwksEndpoint
  ) {
    throw new OidcDiscoveryError(
      "discovery_incomplete",
      ADMIN_HINT.discovery_incomplete,
    );
  }

  return {
    authorizationEndpoint: hydrated.authorizationEndpoint,
    tokenEndpoint: hydrated.tokenEndpoint,
    jwksEndpoint: hydrated.jwksEndpoint,
    userInfoEndpoint: hydrated.userInfoEndpoint,
    tokenEndpointAuthentication: hydrated.tokenEndpointAuthentication,
  };
}

/**
 * The `oidcConfig` shape to write into the column.
 *
 * Field-for-field what `registerSSOProvider`'s `buildOIDCConfig` writes on
 * the discovery path (`dist/index.mjs:2187-2201`), so a provider created here
 * is indistinguishable from one created through BetterAuth's own API — which
 * is what lets a future 1.7 upgrade swap this module for a
 * `registerSSOProvider` call without any stored row needing to change.
 */
export function buildStoredOidcConfig(input: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  discoveryEndpoint: string;
  pkce: boolean;
  scopes?: string[];
  discovered: DiscoveredOidcConfig;
}): OIDCConfig {
  return {
    issuer: input.issuer,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    discoveryEndpoint: input.discoveryEndpoint,
    authorizationEndpoint: input.discovered.authorizationEndpoint,
    tokenEndpoint: input.discovered.tokenEndpoint,
    jwksEndpoint: input.discovered.jwksEndpoint,
    userInfoEndpoint: input.discovered.userInfoEndpoint,
    tokenEndpointAuthentication: input.discovered.tokenEndpointAuthentication,
    pkce: input.pkce,
    scopes: input.scopes,
    overrideUserInfo: false,
  };
}

/**
 * Registration-time OIDC discovery for tenant IdPs, through the plugin's own
 * exported `discoverOIDCConfig` with a tenant trust predicate: the plugin's
 * `/sso/register` would stamp `userId` and trust only our own origins. The SSRF
 * guard `assertPublicUrl` runs on the discovery URL and on every discovered
 * endpoint, so login never fetches discovery and never dials a private host.
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
import { markExpected } from "@/lib/observability/expected";
import { SSO_SCOPES } from "@/lib/sso/provider-schemas";

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

  /** A typed refusal about the tenant's IdP, answered as a 422; marked expected. */
  constructor(failure: OidcDiscoveryFailure, message: string) {
    super(message);
    this.name = "OidcDiscoveryError";
    this.failure = failure;
    markExpected(this);
  }
}

/** Shape-only predicate for `discoverOIDCConfig`; `assertPublicUrl` is the real guard. */
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
  discovery_failed: "OIDC discovery failed for this issuer.",
};

/** Upstream `DiscoveryError.code` → our failure set; unmapped codes are `discovery_failed`. */
const FAILURE_BY_DISCOVERY_CODE: Partial<
  Record<DiscoveryError["code"], OidcDiscoveryFailure>
> = {
  // Two upstream codes, one operator-facing sentence: the IdP did not answer,
  // and which of the two ways it failed to is not something they can act on.
  discovery_timeout: "discovery_unreachable",
  discovery_unexpected_error: "discovery_unreachable",
  discovery_invalid_json: "discovery_invalid_json",
  discovery_incomplete: "discovery_incomplete",
  issuer_mismatch: "issuer_mismatch",
};

function fromDiscoveryError(err: DiscoveryError): OidcDiscoveryError {
  const failure: OidcDiscoveryFailure =
    FAILURE_BY_DISCOVERY_CODE[err.code] ?? "discovery_failed";

  return new OidcDiscoveryError(failure, ADMIN_HINT[failure]);
}

/** The hydrated endpoints to persist, including the auth method the IdP accepts. */
export type DiscoveredOidcConfig = Pick<
  HydratedOIDCConfig,
  | "authorizationEndpoint"
  | "tokenEndpoint"
  | "jwksEndpoint"
  | "userInfoEndpoint"
  | "tokenEndpointAuthentication"
>;

/**
 * Runs discovery and returns all required endpoints or throws
 * {@link OidcDiscoveryError}, so sign-in never needs runtime discovery.
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
    throw new OidcDiscoveryError(
      "discovery_failed",
      ADMIN_HINT.discovery_failed,
    );
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

  // Already guaranteed by the plugin's document validation; narrows the type.
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
 * The `oidcConfig` written to the column, in the plugin's own stored shape.
 * PKCE is always on and the scopes are fixed to `openid email profile`.
 */
export function buildStoredOidcConfig(input: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  discoveryEndpoint: string;
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
    pkce: true,
    scopes: [...SSO_SCOPES],
    overrideUserInfo: false,
  };
}

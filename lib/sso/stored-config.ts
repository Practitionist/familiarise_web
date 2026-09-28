/**
 * The `oidcConfig` / `samlConfig` shape BetterAuth expects to read back out of
 * the `SsoProvider` columns.
 *
 * ## Why this file exists
 *
 * The create route used to `JSON.stringify` the admin's form input straight
 * into the column. For SAML that shape — `{issuer, entryPoint, cert}` — is
 * **not** a shape BetterAuth 1.6.5 can use, and the failure is a hard crash
 * rather than a validation error. Both the sign-in path and the SP-metadata
 * path read the config like this:
 *
 *   - `dist/index.mjs:2447` (sign-in): `let metadata = parsedSamlConfig.spMetadata.metadata;`
 *   - `dist/index.mjs:1851` (metadata): `const sp = parsedSamlConfig.spMetadata.metadata ? ... }`
 *
 * Both dereference `.metadata` off `spMetadata` with no optional chaining, so
 * a config without `spMetadata` throws
 * `TypeError: Cannot read properties of undefined (reading 'metadata')` and the
 * request dies as a 500 with an empty body. That is precisely the symptom
 * audit Phase A.2 describes, and it means **every SAML provider this app has
 * ever registered is currently unable to sign anyone in** — the admin's
 * certificate was never the problem.
 *
 * `registerSSOProvider` always writes a `spMetadata` object, so routing
 * through BetterAuth's API would have fixed this for free. It cannot be used
 * for org-scoped providers (see `lib/sso/oidc-discovery.ts` for the two
 * blockers), so the canonical shape is built here instead. Passing
 * `spMetadata: {}` — every field of which is optional — takes the
 * `saml.SPMetadata(...)` branch, which is the branch we want: the ACS
 * location and entity ID are then derived by BetterAuth from the provider
 * slug rather than declared by us.
 *
 * ## Why `callbackUrl` is written as `""`
 *
 * `samlConfigSchema` in `lib/sso/provider-schemas.ts` deliberately refuses to
 * accept a `callbackUrl` from the client, and `verify-sso-invariants.sh`
 * Check 3 enforces that: a user-typed value drifts from the derived ACS URL
 * and silently breaks assertion delivery. The stored shape still has to carry
 * the key, because BetterAuth's own body schema types it as required
 * (`index-DyoL-0jp.d.mts:971`) and its read path falls back to it.
 *
 * `""` is the only value that satisfies the requirement without reintroducing
 * the risk:
 *
 *   - The ACS location is read as `parsedSamlConfig.callbackUrl ||
 *     \`${baseURL}/sso/saml2/sp/acs/${providerId}\`` at both
 *     `dist/index.mjs:1851` and `:2451`. An empty string is falsy, so the
 *     derived ACS is always used. There is no value here that can drift from
 *     it, because there is no value.
 *   - `callbackUrl` is also the **post-login redirect**, read at
 *     `dist/index.mjs:1740` and `:1624` as
 *     `relayState?.callbackURL || parsedSamlConfig.callbackUrl || baseURL`.
 *     On the SP-initiated path `relayState` is always present —
 *     `generateRelayState` throws `BAD_REQUEST "callbackURL is required"`
 *     before an AuthnRequest is ever built (`:1372-1373`) — so this is a
 *     fallback that only fires on an IdP-initiated login with no `RelayState`.
 * Writing the ACS URL here would bounce that user straight back into a
 * POST-only endpoint; `""` degrades to the app root instead.
 *
 * ## Why this file also owns the READ side
 *
 * `SsoProvider.oidcConfig` / `samlConfig` are `String?` columns. The
 * `$extends({ result })` map in `lib/prisma-sso-secret-extension.ts` decrypts
 * them on the way out and **normalises both storage formats to a parsed
 * object**, so every caller in this repo now receives
 * `Record<string, unknown> | null` and no longer has to ask which format the
 * row happens to be in. That is strictly better than the `JSON.parse` it
 * replaced — the old shape handed out a string, and every reader had to
 * re-implement the envelope-vs-plaintext decision to use it.
 *
 * `Record<string, unknown>` is the honest type, but it is not *usable*:
 * `config.cert` is `unknown` and cannot be passed to `validateSamlCert`. The
 * two `readStored*Config` functions below are the narrowing step. They are
 * deliberately per-field and deliberate about what they drop:
 *
 *   - A field whose stored type does not match is dropped (`undefined`), not
 *     coerced. A legacy row with `cert: 42` must fail the certificate check
 *     loudly, not reach `new X509Certificate(42)`.
 *   - A field the shape does not declare is dropped too, so the returned
 *     object is a subset of what BetterAuth documents. This is what keeps
 *     these functions honest: every field they claim is enumerated and
 *     type-checked here, so a `Partial<OIDCConfig>` cannot quietly be
 *     obtained by asserting a `Record` into one.
 *
 * Note what this is NOT: a schema validation. `readStoredSamlConfig` does not
 * decide whether a config is *usable* — that is the job of the individual
 * checks (cert parses, `spMetadata` present, ACS derived). Its only contract
 * is "each field is the declared type or absent", so a caller can ask about
 * one field without having to re-derive the format of the whole row.
 */

import type { OIDCConfig, SAMLConfig } from "@better-auth/sso";

/**
 * A stored config column as the Prisma layer hands it over: a parsed object
 * for both the `sso:v1:` envelope and the legacy plaintext-JSON format.
 */
export type StoredConfig = Record<string, unknown> | null;

/** A nested object we only know the outer shape of. */
type UnknownRecord = Record<string, unknown>;

/**
 * Field readers. Each returns `undefined` — never a coerced value, never the
 * raw `unknown` — when the stored type does not match, so a caller cannot
 * accidentally pass a number where a URL is expected.
 */
function str(source: UnknownRecord, field: string): string | undefined {
  const value = source[field];
  return typeof value === "string" ? value : undefined;
}

function bool(source: UnknownRecord, field: string): boolean | undefined {
  const value = source[field];
  return typeof value === "boolean" ? value : undefined;
}

function record(source: UnknownRecord, field: string): UnknownRecord | undefined {
  const value = source[field];
  // Arrays are excluded deliberately. An `spMetadata` that is an array would
  // satisfy a bare `typeof x === "object"` check while being unusable by
  // BetterAuth, so it must not survive the narrowing.
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function strArray(source: UnknownRecord, field: string): string[] | undefined {
  const value = source[field];
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : undefined;
}

/**
 * Narrow a stored OIDC config to the fields BetterAuth declares.
 *
 * Returns `null` for a null column so callers can keep using the result as
 * "is there an OIDC config at all" without a separate flag. Discovery
 * endpoints are included because `needsRuntimeDiscovery` — the check that
 * decides whether sign-in will hit the network — reads exactly those.
 */
export function readStoredOidcConfig(
  stored: StoredConfig,
): Partial<OIDCConfig> | null {
  if (!stored) return null;
  const scopes = strArray(stored, "scopes");
  return {
    issuer: str(stored, "issuer"),
    clientId: str(stored, "clientId"),
    clientSecret: str(stored, "clientSecret"),
    discoveryEndpoint: str(stored, "discoveryEndpoint"),
    authorizationEndpoint: str(stored, "authorizationEndpoint"),
    tokenEndpoint: str(stored, "tokenEndpoint"),
    jwksEndpoint: str(stored, "jwksEndpoint"),
    userInfoEndpoint: str(stored, "userInfoEndpoint"),
    pkce: bool(stored, "pkce"),
    ...(scopes ? { scopes } : {}),
  };
}

/**
 * Narrow a stored SAML config to the fields BetterAuth declares.
 *
 * `spMetadata` is `Record<string, unknown> | undefined` rather than
 * BetterAuth's declared shape: its members are all optional, nothing in this
 * repo reads them, and re-declaring a third-party interface's sub-object is
 * how the two drift apart silently. What matters to every caller here is the
 * *presence* of a non-array object, which is exactly what `record` guarantees.
 */
export function readStoredSamlConfig(
  stored: StoredConfig,
): Partial<SAMLConfig> | null {
  if (!stored) return null;
  const spMetadata = record(stored, "spMetadata");
  return {
    issuer: str(stored, "issuer"),
    entryPoint: str(stored, "entryPoint"),
    cert: str(stored, "cert"),
    callbackUrl: str(stored, "callbackUrl"),
    ...(spMetadata ? { spMetadata } : {}),
  };
}

/**
 * Build the stored SAML config.
 *
 * `spMetadata: {}` is the load-bearing part — see the module header.
 */
export function buildStoredSamlConfig(input: {
  issuer: string;
  entryPoint: string;
  cert: string;
}): SAMLConfig {
  return {
    issuer: input.issuer,
    entryPoint: input.entryPoint,
    cert: input.cert,
    // See module header: falsy on purpose, so every read of the ACS location
    // falls through to BetterAuth's own derivation from the provider slug.
    callbackUrl: "",
    spMetadata: {},
  };
}

export type { OIDCConfig, SAMLConfig };

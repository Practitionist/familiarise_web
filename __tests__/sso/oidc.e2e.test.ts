/**
 * @jest-environment node
 */

/**
 * Does the OIDC config this app *persists* come back out of the column intact,
 * and can a tenant not squat somebody else's sign-in button?
 *
 * ## Relationship to `saml.e2e.test.ts`
 *
 * SAML gets the full round trip because `samlify` is CommonJS and can be driven
 * directly. OIDC cannot: `discoverOIDCConfig`, the `sso()` plugin, the whole
 * `betterAuth()` instance and `oauth2-mock-server` are all ESM-only and
 * untransformable under this repo's Jest config (`transformIgnorePatterns:
 * ['/node_modules/']` via `next/jest`, and `jest-runtime` throws
 * `ERR_REQUIRE_ESM` rather than deferring to Node 22's native `require(esm)`).
 * Making a full `signIn.sso → IdP → callback → session` trip possible needs a
 * Jest/Next config change that is out of scope for this branch — see the
 * handover notes. What *is* reachable, and what actually broke last time, is
 * tested here.
 *
 * ## The two things this proves
 *
 * 1. **The persisted shape survives the read path.** `lib/auth.ts` hands
 *    BetterAuth `readStoredOidcConfig(...)`, not the raw column, and that
 *    function drops any field whose stored type does not match. Dropping
 *    `authorizationEndpoint` is not a cosmetic loss: `needsRuntimeDiscovery`
 *    goes true, and the plugin then fetches the discovery document *at login
 *    time* — the exact failure `lib/sso/oidc-discovery.ts` exists to prevent,
 *    where a bad IdP surfaces to the customer minutes after the admin believed
 *    setup was done. So this asserts every discovered endpoint survives
 *    `JSON.stringify` → `JSON.parse` → narrowing, and pins the plugin's own
 *    "no authorization URL" refusal so the reason that matters is visible.
 *
 * 2. **A tenant cannot claim a reserved `providerId`.** `providerId` is a
 *    *globally* unique slug for the whole SSO surface
 *    (`/api/auth/sso/callback/{id}`, `/api/auth/sso/saml2/sp/acs/{id}`). Before
 *    the reserved-name check, any org whose domain was claimed could register
 *    `google`, and whose row won the lookup was not a tenant's decision to make.
 *    1.6.5 does **not** save us here — `registerSSOProvider`'s 422 is a
 *    uniqueness check only, and `credential` / `reserved` / `socialProvider` do
 *    not appear anywhere in the plugin. The rule is ours
 *    (`lib/sso/provider-schemas.ts`), so it is ours to test.
 *
 * ## The mock below is a tripwire, not a stub
 *
 * `lib/sso/oidc-discovery.ts` value-imports `@better-auth/sso`, so the module
 * graph cannot even load without a mock (the same reason
 * `__tests__/auth/sign-in-attempt-hooks.test.ts` mocks `better-auth/api`).
 * `buildStoredOidcConfig` is a **pure function** and never calls the plugin, so
 * the mock's `discoverOIDCConfig` is rigged to throw if it is ever reached —
 * turning a silent tautology into a loud failure. `discoverOidcConfigForTenant`
 * is deliberately *not* exercised: running it would mean mocking the discovery
 * pipeline too, at which point the assertions would be about the mock. The
 * SSRF guard it calls is separately tested, and the pipeline is BetterAuth's.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createProviderSchema,
  RESERVED_PROVIDER_IDS,
  validateSamlCert,
} from "@/lib/sso/provider-schemas";
import { AUTH_PROVIDERS } from "@/lib/auth-providers";
import { readStoredOidcConfig } from "@/lib/sso/stored-config";
import {
  mintSelfSignedIdpCredentials,
  startOidcDiscoveryServer,
  type MockOidcDiscovery,
} from "../fixtures/mock-idp";

jest.mock("@better-auth/sso", () => ({
  __esModule: true,
  // Never reached by a pure builder. If it is, the test must fail rather than
  // pass against a stub that happens to agree with the assertion.
  discoverOIDCConfig: jest.fn(async () => {
    throw new Error(
      "discoverOIDCConfig was called — this suite only asserts the pure persist/read path",
    );
  }),
  DiscoveryError: class DiscoveryError extends Error {},
}));

// Imported after the mock so the module graph resolves without loading the
// ESM-only package for real.
import {
  buildStoredOidcConfig,
  type DiscoveredOidcConfig,
} from "@/lib/sso/oidc-discovery";

const PROVIDER_ID = "acme-okta";
const DOMAIN = "acme.test";
const CLIENT_ID = "acme-portal";
const CLIENT_SECRET = "s3cret-from-the-idp-console";
const SCOPES = ["openid", "email", "profile", "offline_access"];

/**
 * No local copy of the discovered shape.
 *
 * This suite originally re-declared it as `{…; tokenEndpointAuthentication:
 * string}`, which is *wider* than what `@better-auth/sso` declares
 * (`"client_secret_basic" | "client_secret_post" | undefined`,
 * `index-DyoL-0jp.d.mts:1596`). TypeScript caught it, and it should have been
 * caught: a hand-copied type can only ever assert that the copy is internally
 * consistent, never that the copy still matches the plugin. `tsc` failing here
 * is the argument for importing the production type.
 */

let idp: MockOidcDiscovery;
/** The document actually served over the wire, not a hardcoded literal. */
let document: Record<string, unknown>;

beforeAll(async () => {
  idp = await startOidcDiscoveryServer((issuer) => ({
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    userinfo_endpoint: `${issuer}/oauth2/userinfo`,
  }));

  const res = await fetch(idp.discoveryEndpoint);
  if (!res.ok) throw new Error(`discovery document responded ${res.status}`);
  document = (await res.json()) as Record<string, unknown>;
});

afterAll(async () => {
  // Explicit close: a leaked listener here is the one way this suite could
  // hang CI instead of failing it.
  await idp.close();
});

/**
 * Map the served document onto `DiscoveredOidcConfig` mechanically.
 *
 * Deliberately dumb: it is a rename plus a first-supported-methods read. Which
 * `token_endpoint_auth_methods_supported` entry BetterAuth *prefers* is
 * `selectTokenEndpointAuthMethod`'s job inside the plugin and is not what this
 * suite is about — what is being asserted is that whatever discovery produced
 * reaches the column unaltered and comes back out of it unaltered.
 */
function discoveredFrom(
  document: Record<string, unknown>,
): DiscoveredOidcConfig {
  const methods = document.token_endpoint_auth_methods_supported as string[];

  // Narrowed, not cast. The IdP advertises whatever it likes; BetterAuth only
  // knows two methods, so an IdP advertising something else must fail *here*,
  // where the document is in hand — rather than being written to the column and
  // discovered at sign-in. A cast would hide precisely the case worth testing.
  const authMethod = methods.find(
    (m): m is DiscoveredOidcConfig["tokenEndpointAuthentication"] =>
      m === "client_secret_basic" || m === "client_secret_post",
  );
  if (!authMethod) {
    throw new Error(
      `discovery document advertises no auth method BetterAuth supports: ${JSON.stringify(methods)}`,
    );
  }

  return {
    authorizationEndpoint: document.authorization_endpoint as string,
    tokenEndpoint: document.token_endpoint as string,
    jwksEndpoint: document.jwks_uri as string,
    userInfoEndpoint: document.userinfo_endpoint as string,
    tokenEndpointAuthentication: authMethod,
  };
}

function providerBody(overrides: Record<string, unknown> = {}) {
  return {
    providerId: PROVIDER_ID,
    domain: DOMAIN,
    issuer: idp.issuer,
    providerType: "oidc" as const,
    ...overrides,
  };
}

describe("OIDC discovery → stored column → read back", () => {
  // BREAKS IF DELETED: the field the whole `oidc-discovery.ts` module was
  // written to populate. Before it, the column held only what the admin typed
  // and the first sign-in hit the network and failed; after it, a bad IdP is
  // rejected while the admin is still looking at the form. If `buildStoredOidcConfig`
  // stops persisting the authorization endpoint, that guarantee silently
  // evaporates and the failure returns to the customer.
  it("persists every discovered endpoint, so sign-in never has to fetch discovery", () => {
    const stored = buildStoredOidcConfig({
      issuer: idp.issuer,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      discoveryEndpoint: idp.discoveryEndpoint,
      pkce: true,
      scopes: SCOPES,
      discovered: discoveredFrom(document),
    });

    expect(stored.issuer).toBe(idp.issuer);
    expect(stored.discoveryEndpoint).toBe(idp.discoveryEndpoint);
    expect(stored.clientId).toBe(CLIENT_ID);
    expect(stored.pkce).toBe(true);
    expect(stored.scopes).toEqual(SCOPES);

    // The four endpoints, straight from the document the IdP actually served.
    expect(stored.authorizationEndpoint).toBe(`${idp.issuer}/oauth2/authorize`);
    expect(stored.tokenEndpoint).toBe(`${idp.issuer}/oauth2/token`);
    expect(stored.jwksEndpoint).toBe(`${idp.issuer}/.well-known/jwks.json`);
    expect(stored.userInfoEndpoint).toBe(`${idp.issuer}/oauth2/userinfo`);
    expect(stored.tokenEndpointAuthentication).toBe("client_secret_basic");

    // `registerSSOProvider` writes `overrideUserInfo: false`; matching it is
    // what makes a row created here indistinguishable from one created through
    // BetterAuth's own API, which is the stated precondition for swapping this
    // module for a `registerSSOProvider` call on a future upgrade.
    expect(stored.overrideUserInfo).toBe(false);
  });

  // BREAKS IF DELETED: the round trip through the column. `SsoProvider.oidcConfig`
  // is a `String?` column, and `lib/auth.ts` does not read the raw JSON — it
  // reads `readStoredOidcConfig(...)`, which drops any field whose stored type
  // does not match. A dropped `authorizationEndpoint` is invisible here and
  // catastrophic in production: `needsRuntimeDiscovery` flips true and the
  // plugin re-fetches discovery on the login path, which is the precise defect
  // `oidc-discovery.ts` was written to eliminate.
  it("loses nothing through JSON serialisation and the narrowing read", () => {
    const stored = buildStoredOidcConfig({
      issuer: idp.issuer,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      discoveryEndpoint: idp.discoveryEndpoint,
      pkce: true,
      scopes: SCOPES,
      discovered: discoveredFrom(document),
    });

    // Column → Prisma extension → `lib/auth.ts`.
    const columnValue = JSON.stringify(stored);
    const readBack = readStoredOidcConfig(
      JSON.parse(columnValue) as Record<string, unknown> | null,
    );

    expect(readBack).not.toBeNull();
    expect(readBack?.authorizationEndpoint).toBe(
      `${idp.issuer}/oauth2/authorize`,
    );
    expect(readBack?.tokenEndpoint).toBe(`${idp.issuer}/oauth2/token`);
    expect(readBack?.jwksEndpoint).toBe(`${idp.issuer}/.well-known/jwks.json`);
    expect(readBack?.userInfoEndpoint).toBe(`${idp.issuer}/oauth2/userinfo`);
    expect(readBack?.issuer).toBe(idp.issuer);
    expect(readBack?.clientId).toBe(CLIENT_ID);
    expect(readBack?.clientSecret).toBe(CLIENT_SECRET);
    expect(readBack?.discoveryEndpoint).toBe(idp.discoveryEndpoint);
    expect(readBack?.pkce).toBe(true);
    expect(readBack?.scopes).toEqual(SCOPES);

    // The three the plugin cannot sign in without. Stated as a set so a future
    // addition to the narrowing function is visible as a diff here.
    expect([
      readBack?.authorizationEndpoint,
      readBack?.tokenEndpoint,
      readBack?.jwksEndpoint,
    ]).toEqual([
      `${idp.issuer}/oauth2/authorize`,
      `${idp.issuer}/oauth2/token`,
      `${idp.issuer}/.well-known/jwks.json`,
    ]);
  });

  // BREAKS IF DELETED: the plugin's own refusal, quoted from the shipped
  // bundle. It is what makes the endpoint above load-bearing rather than
  // cosmetic, and it is the string an operator would see if a provider were
  // ever registered without it. Pinned so a 1.7 upgrade that changes the
  // message or the condition surfaces here.
  //
  // Pinned to `@better-auth/sso` 1.6.5 (`dist/index.mjs:2415`).
  it("pins the plugin refusal that a missing authorization endpoint triggers", () => {
    const source = readFileSync(
      join(__dirname, "../../node_modules/@better-auth/sso/dist/index.mjs"),
      "utf8",
    );

    expect(source).toContain(
      "Invalid OIDC configuration. Authorization URL not found.",
    );
    // Runtime discovery is the fallback this whole module exists to avoid.
    expect(source).toContain("ensureRuntimeDiscovery");
  });
});

describe("reserved providerId", () => {
  // BREAKS IF DELETED: the URL-hijack guard. `credential` is BetterAuth's own
  // id for email+password accounts, and it is the most dangerous of the set:
  // `enforceSSO` reasons about `Account.providerId`, so a provider claiming
  // `credential` makes "this person linked an account with the org's provider"
  // trivially true for a password user — which disables the #673 veto entirely.
  it.each(["credential", "sso"])("refuses the reserved id %s", (providerId) => {
    const result = createProviderSchema.safeParse(providerBody({ providerId }));
    expect(result.success).toBe(false);
    const issue = result.success ? undefined : result.error.issues[0];
    expect(issue?.path).toEqual(["providerId"]);
    expect(issue?.message).toContain("reserved");
  });

  // BREAKS IF DELETED: the social-provider collisions. `AUTH_PROVIDERS` is the
  // list of buttons this app renders, and it is also what
  // `accountLinking.trustedProviders` is built from, so one constant closes
  // both. A tenant registering `google` would otherwise own
  // `/api/auth/sso/callback/google`.
  it.each(AUTH_PROVIDERS.map((p) => p.id))(
    "refuses the social-provider id %s",
    (providerId) => {
      const result = createProviderSchema.safeParse(
        providerBody({ providerId }),
      );
      expect(result.success).toBe(false);
      const issue = result.success ? undefined : result.error.issues[0];
      expect(issue?.path).toEqual(["providerId"]);
      expect(issue?.message).toContain("reserved");
    },
  );

  // BREAKS IF DELETED: matching is case-insensitive and trims, because
  // `providerId` is lowercased nowhere in the write path while the lookup is
  // reached through URLs a client may present in any case. Refusing `Google`
  // alongside `google` is what keeps the slug space unambiguous; without the
  // trim, `" google "` would pass a naive `Set.has` and defeat the whole check.
  it("refuses reserved ids regardless of case and surrounding whitespace", () => {
    for (const providerId of ["Google", "CREDENTIAL", "  facebook  "]) {
      const result = createProviderSchema.safeParse(
        providerBody({ providerId }),
      );
      expect(result.success).toBe(false);
    }
  });

  // BREAKS IF DELETED: a rejection that also blocked ordinary slugs would be
  // "fixed" by widening the reserved set until real tenants were locked out —
  // which is how a security control turns into an outage. This is the negative
  // control that makes the set above trustworthy.
  it("still accepts an ordinary org-scoped slug", () => {
    const result = createProviderSchema.safeParse(
      providerBody({ providerId: "acme-okta" }),
    );
    expect(result.success).toBe(true);
  });

  // BREAKS IF DELETED: `RESERVED_PROVIDER_IDS` is consumed by the Add Provider
  // dialog and by the message, and `scripts/verify-sso-invariants.sh` Check 5
  // greps the enforcement against these same rows. If `AUTH_PROVIDERS` grows a
  // provider and this set is not derived from it, the UI would offer a name the
  // schema accepts. Pinning the derivation keeps the two from drifting.
  it("derives the set from AUTH_PROVIDERS rather than restating it", () => {
    for (const provider of AUTH_PROVIDERS) {
      expect(RESERVED_PROVIDER_IDS.has(provider.id)).toBe(true);
    }
    expect(RESERVED_PROVIDER_IDS.has(PROVIDER_ID)).toBe(false);
  });
});

describe("certificate validation still gates the SAML half", () => {
  // BREAKS IF DELETED: `@node-saml`/`samlify` parses the certificate lazily
  // when an assertion arrives, so a garbage cert is not caught at registration —
  // it surfaces as the same empty-body 500 the P0 produced, with no message the
  // Add Provider dialog can show. Validating at the schema layer fails closed
  // with a sentence the admin can act on. The mock IdP's freshly minted
  // certificate must therefore parse, or the SAML suite's `cert` would be
  // something the app would have rejected at registration.
  it("accepts a real X.509 PEM and rejects junk", () => {
    const { cert } = mintSelfSignedIdpCredentials();

    expect(cert).toContain("-----BEGIN CERTIFICATE-----");
    expect(validateSamlCert(cert)).toBe(true);
    expect(validateSamlCert("not a certificate")).toBe(false);
    // A base64 fingerprint is the mistake the copy in `samlConfigSchema`
    // explicitly calls out; it is not a certificate.
    expect(validateSamlCert("MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A")).toBe(false);
  });
});

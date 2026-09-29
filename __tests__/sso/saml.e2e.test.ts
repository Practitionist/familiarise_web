/**
 * @jest-environment node
 */

/**
 * The P0 regression test: does the config this app *stores* actually let
 * `@better-auth/sso` 1.6.5 sign somebody in?
 *
 * ## What this is for
 *
 * `lib/sso/stored-config.ts` documents the defect this file locks down. The
 * create route used to `JSON.stringify` the admin's form input — `{issuer,
 * entryPoint, cert}` — straight into the column. That shape is not one
 * BetterAuth can use, and the failure is a hard crash rather than a validation
 * error, because the plugin dereferences `.metadata` off `spMetadata` with no
 * optional chaining:
 *
 *   - `dist/index.mjs:2446` (sign-in): `let metadata = parsedSamlConfig.spMetadata.metadata;`
 *   - `dist/index.mjs:1851` (SP metadata): `parsedSamlConfig.spMetadata.metadata ? ... : ...`
 *
 * The inconsistency is worth reading once, because it is two lines apart: at
 * `:2444` the same function writes `!parsedSamlConfig.spMetadata?.privateKey`
 * — correctly guarded — and at `:2446` it reaches for `.metadata` unguarded.
 * `SAMLConfig` declares `spMetadata` as a required object whose *members* are
 * all optional, so `spMetadata.metadata` type-checks perfectly and then throws
 * on any row written before the field existed. That gap between the declared
 * type and the stored value is the whole defect.
 *
 * A config without `spMetadata` therefore throws
 * `TypeError: Cannot read properties of undefined (reading 'metadata')`, the
 * request dies as a 500 with an empty body, and **every SAML sign-in in this app
 * is dead**. The admin's certificate was never the problem.
 *
 * ## Why it survived review
 *
 * Because nothing ever executed that line. The pre-existing SSO suites cover
 * session enforcement, certificate parsing and URL derivation, and
 * `backfill-saml-shape.test.ts` covers the *static* shape of the stored config
 * — it proves the backfill emits byte-identical output to
 * `buildStoredSamlConfig` and that an array-shaped `spMetadata` is rejected.
 * All of that passes perfectly on a config that cannot authenticate anyone.
 * **Shape is not fitness.** This file is the part that boots a real SP and a
 * real IdP and makes them exchange a signed assertion.
 *
 * ## Why this does not import `@better-auth/sso`
 *
 * Because it cannot, and that is a property of the repo's Jest setup rather
 * than of this test. `better-auth`, `@better-auth/sso` and `oauth2-mock-server`
 * are all ESM-only (`"type": "module"`, `.mjs`, no CommonJS build);
 * `jest.config.ts` runs through `next/jest`, which sets
 * `transformIgnorePatterns: ['/node_modules/']`, and `jest-runtime` throws
 * `ERR_REQUIRE_ESM` instead of delegating to Node 22's native `require(esm)`.
 * The repo already knows this — see the comment above the `jest.mock` of
 * `better-auth/api` in `__tests__/auth/sign-in-attempt-hooks.test.ts`:
 * "ESM-only, untransformed here".
 *
 * So this suite drives the *library the plugin itself uses*. `@better-auth/sso`
 * does `import * as saml from "samlify"` (`dist/index.mjs:4`) and builds its
 * entities from `saml.SPMetadata` / `saml.ServiceProvider` /
 * `saml.IdentityProvider`, so running `samlify` directly exercises the same
 * signing, verification and metadata code the plugin runs. The plugin-specific
 * lines around it are transcribed below with their `dist/index.mjs` line
 * numbers, and the last test pins those transcriptions to the shipped source so
 * a version bump that moves them fails here instead of in production.
 *
 * Real RSA signing, real X.509 verification, real protocol. No port, no socket,
 * nothing to leak.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as saml from "samlify";

import {
  buildStoredSamlConfig,
  readStoredSamlConfig,
} from "@/lib/sso/stored-config";
import { deriveAcsUrl } from "@/lib/sso/derive-urls";
import {
  mintSelfSignedIdpCredentials,
  type MockIdpCredentials,
} from "../fixtures/mock-idp";

const PROVIDER_ID = "acme-okta";
const ISSUER = "https://idp.acme.test/saml";
const ENTRY_POINT = "https://idp.acme.test/sso/redirect";
const APP_ORIGIN = "https://app.example.test";
/** `ctx.context.baseURL` in the plugin — BetterAuth's baseURL *includes* basePath. */
const AUTH_BASE_URL = `${APP_ORIGIN}/api/auth`;
const DERIVED_ACS = `${AUTH_BASE_URL}/sso/saml2/sp/acs/${PROVIDER_ID}`;
const RELAY_STATE = "relay-state-abc123";
const USER = {
  email: "dana.okafor@acme.test",
  givenName: "Dana",
  surname: "Okafor",
};

const HTTP_POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const HTTP_REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";

let idpCreds: MockIdpCredentials;

beforeAll(() => {
  // One keypair for the whole suite. The P0 was never about throughput, and
  // minting RSA keys per-test is the slowest thing in the file.
  idpCreds = mintSelfSignedIdpCredentials();
});

type Sp = ReturnType<typeof saml.ServiceProvider>;
type Idp = ReturnType<typeof saml.IdentityProvider>;

/** The SP the plugin builds at `dist/index.mjs:2446-2462` (and in `createSP`, `:1439`). */
function buildServiceProvider(
  stored: ReturnType<typeof readStoredSamlConfig>,
): {
  acsUrl: string;
  sp: Sp;
} {
  // The plugin's own read of the column, narrowed to the two members it uses.
  //
  // `SAMLConfig` declares `spMetadata` as **non-optional** (all of its members
  // optional, the object itself not), which is exactly why
  // `parsedSamlConfig.spMetadata.metadata` type-checks in the plugin and then
  // throws on a row that has no `spMetadata`. That gap between the declared
  // type and the stored value *is* the P0 — so the cast below is typed as
  // present, and the dereference on the next line is deliberately unguarded.
  const spData = (stored?.spMetadata ?? undefined) as unknown as {
    metadata?: string;
    entityID?: string;
  };

  // dist/index.mjs:2446 — unguarded. Kept unguarded on purpose: softening it
  // here would hide the very defect this suite exists to catch.
  const metadata = spData.metadata;

  // dist/index.mjs:2451 (and again in `createSP`, `:1442`) — the ACS fallback
  // that `callbackUrl: ""` exists to
  // fall through.
  const acsUrl = stored?.callbackUrl || DERIVED_ACS;

  const resolvedMetadata =
    metadata ||
    saml
      .SPMetadata({
        entityID: spData.entityID || stored?.issuer,
        assertionConsumerService: [{ Binding: HTTP_POST, Location: acsUrl }],
        wantMessageSigned: false,
        authnRequestsSigned: false,
      })
      .getMetadata() ||
    "";

  return {
    acsUrl,
    sp: saml.ServiceProvider({
      metadata: resolvedMetadata,
      allowCreate: true,
      relayState: RELAY_STATE,
    }),
  };
}

/** The IdP the plugin builds at `dist/index.mjs:2466-2473` (and `createIdP`, `:1469`). */
function makeIdp(creds: MockIdpCredentials): Idp {
  return saml.IdentityProvider({
    entityID: ISSUER,
    singleSignOnService: [{ Binding: HTTP_REDIRECT, Location: ENTRY_POINT }],
    signingCert: creds.cert,
    privateKey: creds.privateKey,
    wantAuthnRequestsSigned: false,
    isAssertionEncrypted: false,
  });
}

/**
 * The IdP half of the round trip: read the AuthnRequest the SP produced, then
 * sign a response with `creds`.
 *
 * `creds` is a parameter rather than a captured constant specifically so the
 * negative test can sign with a key the SP does not trust.
 */
async function idpIssuesResponse(sp: Sp, creds: MockIdpCredentials) {
  const idp = makeIdp(creds);

  const loginRequest = sp.createLoginRequest(idp, "redirect");
  // The browser would land on the IdP with this URL and the IdP would read the
  // request out of the query string. `URLSearchParams` has already
  // percent-decoded it, which is the state `redirectFlow`'s own
  // `decodeURIComponent` expects (`samlify/build/src/flow.js:97`).
  const samlRequest = new URL(loginRequest.context).searchParams.get(
    "SAMLRequest",
  );
  if (!samlRequest) throw new Error("AuthnRequest URL carried no SAMLRequest");

  const requestInfo = await idp.parseLoginRequest(sp, "redirect", {
    query: { SAMLRequest: samlRequest },
  });

  // A real IdP operation: mints an assertion ID, fills
  // Destination/Audience/Recipient from the SP metadata, applies Conditions
  // validity, and signs the message with the IdP key.
  const response = (await idp.createLoginResponse(
    sp,
    requestInfo,
    "post",
    {
      email: USER.email,
      attributes: {
        email: USER.email,
        nameID: USER.email,
        givenName: USER.givenName,
        surname: USER.surname,
        displayName: `${USER.givenName} ${USER.surname}`,
      },
    },
    undefined,
    undefined,
    RELAY_STATE,
  )) as { id: string; context: string };

  return { idp, loginRequest, response };
}

describe("stored SAML config → a real SP/IdP round trip", () => {
  // BREAKS IF DELETED: this is the P0. Revert `buildStoredSamlConfig` to the
  // pre-fix `{issuer, entryPoint, cert}` shape and the second assertion below
  // throws exactly the `TypeError` that 500'd every SAML sign-in — while the
  // first still passes, which is precisely how the original defect shipped
  // past a passing suite. Running the *plugin's own read path* rather than a
  // restatement of it is what gives this teeth.
  it("survives the unguarded spMetadata dereference — and the legacy shape does not", () => {
    const fixed = readStoredSamlConfig(
      buildStoredSamlConfig({
        issuer: ISSUER,
        entryPoint: ENTRY_POINT,
        cert: idpCreds.cert,
      }),
    );
    expect(() => buildServiceProvider(fixed)).not.toThrow();

    // The shape the create route used to persist, verbatim.
    const legacy = {
      issuer: ISSUER,
      entryPoint: ENTRY_POINT,
      cert: idpCreds.cert,
    };
    expect(() =>
      buildServiceProvider(
        legacy as unknown as NonNullable<
          ReturnType<typeof readStoredSamlConfig>
        >,
      ),
    ).toThrow(TypeError);
  });

  // BREAKS IF DELETED: `callbackUrl: ""` looks like a bug and invites a
  // "helpful" fix that writes a real URL. A non-empty value wins the
  // `parsedSamlConfig.callbackUrl || derived` fallback, so the ACS would drift
  // from what `deriveAcsUrl` shows the org admin in the Add Provider dialog and
  // assertions would be delivered to an endpoint the plugin is not listening
  // on. The two functions must agree or SAML silently stops working.
  it("derives the same ACS URL the Add Provider dialog shows the admin", () => {
    const stored = readStoredSamlConfig(
      buildStoredSamlConfig({
        issuer: ISSUER,
        entryPoint: ENTRY_POINT,
        cert: idpCreds.cert,
      }),
    );
    const { acsUrl, sp } = buildServiceProvider(stored);

    // Falsy on purpose, so every read of the ACS falls through to the
    // derivation. See the module header in lib/sso/stored-config.ts.
    expect(stored?.callbackUrl).toBe("");
    expect(acsUrl).toBe(deriveAcsUrl(PROVIDER_ID, "saml", APP_ORIGIN));
    expect(acsUrl).toBe(DERIVED_ACS);

    // And the SP actually publishes that ACS, so the assertion has somewhere
    // real to arrive.
    expect(sp.entityMeta.getAssertionConsumerService(HTTP_POST)).toBe(
      DERIVED_ACS,
    );
  });

  // BREAKS IF DELETED: the sign-in path end to end — the SP builds an
  // AuthnRequest, the IdP signs a response with its real key, the SP verifies
  // the signature against the cert we stored, and the identity comes out the
  // other side. This is the only assertion here that fails when `cert`,
  // `entryPoint` or `spMetadata` are wrong in a way no shape assertion can see.
  it("completes a SP-initiated round trip and verifies the signed assertion", async () => {
    const stored = readStoredSamlConfig(
      buildStoredSamlConfig({
        issuer: ISSUER,
        entryPoint: ENTRY_POINT,
        cert: idpCreds.cert,
      }),
    );
    const { sp } = buildServiceProvider(stored);

    const { idp, loginRequest, response } = await idpIssuesResponse(
      sp,
      idpCreds,
    );

    // `parseLoginResponse` runs with `checkSignature: true`
    // (`samlify/build/src/entity-sp.js`), so reaching the assertions at all
    // means the X.509 signature verified against the stored `cert`.
    const parsed = await sp.parseLoginResponse(idp, "post", {
      body: { SAMLResponse: response.context },
    });

    // The identity the plugin reads at `dist/index.mjs:1726`:
    // `attributes[mapping.email || "email"] || extract.nameID`, lowercased.
    // `id` likewise falls back to `extract.nameID`.
    expect(parsed.extract.attributes.email).toBe(USER.email);
    expect(parsed.extract.nameID).toBe(USER.email);

    // The assertion does carry the correlation the plugin means to check — at
    // `extract.response.inResponseTo`, which is where samlify actually puts it
    // (`loginResponseFields` nests the `Response` element's attributes under a
    // `response` key and camelCases them, `extractor.js:311-324`).
    //
    // The path matters: the plugin reads `extract.inResponseTo`
    // (`dist/index.mjs:1650`), which samlify never produces. The next test
    // pins that.
    expect(parsed.extract.response.inResponseTo).toBe(loginRequest.id);

    // Audience is a top-level extract key, not nested under `conditions`.
    //
    // It resolves to the issuer rather than a distinct SP entity ID, and that
    // is a direct consequence of `spMetadata: {}`: the plugin resolves
    // `spMetadata?.entityID || parsedSamlConfig.issuer`
    // (`dist/index.mjs:2448`), so with no `entityID` of our own the SP adopts
    // the tenant's IdP issuer as its own entity identifier. Asserted rather
    // than glossed over, because "the SP and the IdP share an entityID" is
    // unusual in SAML and is the kind of thing an IdP administrator notices.
    expect(parsed.extract.audience).toBe(ISSUER);

    // Destination is filled from the SP metadata the *stored* config produced,
    // so a drifting ACS shows up here.
    expect(parsed.extract.response.destination).toBe(DERIVED_ACS);

    // Conditions validity is genuinely checked on this path —
    // `validateSAMLTimestamp(extract.conditions, …)` reads a key that does
    // exist (`dist/index.mjs:1645`).
    expect(parsed.extract.conditions.notBefore).toBeTruthy();
    expect(parsed.extract.conditions.notOnOrAfter).toBeTruthy();
  });

  // BREAKS IF DELETED: two security controls in the ACS path that the shipped
  // plugin believes it is enforcing and is not, because it reads two fields
  // samlify never produces on the POST binding.
  //
  // 1. **InResponseTo validation is a no-op.** `processSAMLResponse` does
  //    `const inResponseTo = extract.inResponseTo` (`dist/index.mjs:1650`) and
  //    puts the whole AuthnRequest-correlation block behind `if (inResponseTo)`.
  //    samlify nests that attribute at `extract.response.inResponseTo`, so
  //    `extract.inResponseTo` is `undefined` for every response. The `else if
  //    (!allowIdpInitiated)` arm does not rescue it either, because
  //    `allowIdpInitiated` defaults to `true` (`!== false`). Net effect: an
  //    assertion is accepted whether or not it answers an AuthnRequest this SP
  //    ever issued. The plugin's separate assertion-ID replay check
  //    (`USED_ASSERTION_KEY_PREFIX`, `:1690+`) still runs, so this is request
  //    correlation that is lost, not replay protection.
  //
  // 2. **The signature-algorithm allow-list is a no-op.**
  //    `validateSAMLAlgorithms` reads `response.sigAlg` (`:1644`), and
  //    samlify's `postFlow` returns `{ samlContent, extract }` with **no
  //    `sigAlg`** (`flow.js:245-247`) — only `redirectFlow` sets it. The ACS is
  //    HTTP-POST-only, so POST is the only path. `validateSignatureAlgorithm`
  //    then returns immediately on `!algorithm`, and a SHA-1-signed response
  //    would be accepted despite the `SAML_DEPRECATED_SIGNATURE_ALGORITHM`
  //    control that exists to refuse it.
  //
  // Neither is a regression in this repo — both are upstream at the pinned
  // 1.6.5 — but both are live today, and both are invisible to every other
  // suite in the repo. This pins them: when the plugin is upgraded, or a
  // workaround lands in `lib/auth.ts`, this test is the thing that has to be
  // revisited and its removal noticed.
  it("pins two plugin reads that are dead on the POST binding", async () => {
    const stored = readStoredSamlConfig(
      buildStoredSamlConfig({
        issuer: ISSUER,
        entryPoint: ENTRY_POINT,
        cert: idpCreds.cert,
      }),
    );
    const { sp } = buildServiceProvider(stored);
    const { idp, response } = await idpIssuesResponse(sp, idpCreds);

    const parsed = await sp.parseLoginResponse(idp, "post", {
      body: { SAMLResponse: response.context },
    });

    // (1) The plugin's read. `undefined`, always — so `if (inResponseTo)` is
    // never entered and no AuthnRequest correlation happens.
    expect(
      (parsed.extract as Record<string, unknown>).inResponseTo,
    ).toBeUndefined();
    // …while the value genuinely is in the response, one level down.
    expect(parsed.extract.response.inResponseTo).toBeTruthy();

    // (2) The algorithm allow-list's input. `undefined` on POST, so
    // `validateSignatureAlgorithm` short-circuits.
    expect((parsed as { sigAlg?: string }).sigAlg).toBeUndefined();

    // …even though the response is signed, and with the algorithm the shipped
    // allow-list *would* have accepted had it been consulted. Recorded as a
    // fact about the response, not as a claim that it is enforced.
    const xml = Buffer.from(response.context, "base64").toString("utf8");
    expect(xml).toContain(`Algorithm="${RSA_SHA256}"`);

    // Pin the upstream reads themselves, so an upgrade that fixes either one
    // shows up as a failure here rather than as a silently-changed security
    // posture nobody re-reviews.
    const source = readFileSync(
      join(__dirname, "../../node_modules/@better-auth/sso/dist/index.mjs"),
      "utf8",
    );
    expect(source).toContain("const inResponseTo = extract.inResponseTo;");
    expect(source).toContain("validateSAMLAlgorithms(parsedResponse");
  });

  // BREAKS IF DELETED: the round-trip test above would keep passing if
  // `parseLoginResponse` stopped verifying signatures. samlify rejects with
  // `FAILED_TO_VERIFY_SIGNATURE` when the message signature does not check out
  // against the IdP metadata, so a response signed by a key the stored `cert`
  // does not match must be refused. Without this, "it verified" in the test
  // above is an unbacked claim.
  it("refuses an assertion signed by a key the stored cert does not match", async () => {
    const stored = readStoredSamlConfig(
      buildStoredSamlConfig({
        issuer: ISSUER,
        entryPoint: ENTRY_POINT,
        cert: idpCreds.cert,
      }),
    );
    const { sp } = buildServiceProvider(stored);

    const attacker = mintSelfSignedIdpCredentials();
    // Signed by the attacker's key …
    const { response } = await idpIssuesResponse(sp, attacker);
    // … but verified against the cert we actually stored.
    const honestIdp = makeIdp(idpCreds);

    await expect(
      sp.parseLoginResponse(honestIdp, "post", {
        body: { SAMLResponse: response.context },
      }),
    ).rejects.toBeDefined();
  });

  // BREAKS IF DELETED: the transcriptions above are pinned to the shipped
  // plugin so they cannot silently rot. `lib/sso/derive-urls.ts` and
  // `lib/sso/stored-config.ts` both say "re-check this on every version bump";
  // this is the mechanical form of that instruction. If a 1.7 release adds
  // optional chaining or moves the ACS fallback, the count and substring
  // assertions fail here and force a re-read — instead of this file quietly
  // testing a contract the plugin no longer has.
  //
  // Pinned to `@better-auth/sso` 1.6.5. A failure here after a dependency bump
  // is the bump working as intended: re-read `dist/index.mjs` and update.
  it("pins the two unguarded spMetadata dereferences it is transcribed from", () => {
    const source = readFileSync(
      join(__dirname, "../../node_modules/@better-auth/sso/dist/index.mjs"),
      "utf8",
    );

    // Two unguarded *sites* — dist/index.mjs:1851 (SP metadata) and :2446
    // (sign-in) — which is three textual matches, because :1851 reads the
    // expression twice (`cond ? ServiceProvider({metadata: …}) : SPMetadata(…)`).
    // The floor is 2 so the assertion tracks the sites rather than the count.
    const dereferences =
      source.match(/parsedSamlConfig\.spMetadata\.metadata/g) ?? [];
    expect(dereferences.length).toBeGreaterThanOrEqual(2);
    // The entire defect is the *absence* of a `?.` here.
    expect(source).not.toContain("parsedSamlConfig.spMetadata?.metadata");

    // The ACS fallback the empty-string `callbackUrl` relies on.
    expect(source).toContain("/sso/saml2/sp/acs/${provider.providerId}");
  });
});

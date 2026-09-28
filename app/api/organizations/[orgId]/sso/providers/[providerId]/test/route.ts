/**
 * POST /api/organizations/[orgId]/sso/providers/[providerId]/test
 *
 * "Test connection" for a saved SSO provider: validates the stored config
 * without contacting the identity provider.
 *
 * ## Why it must not contact the IdP
 *
 * The obvious version of this button fetches the discovery endpoint or
 * requests a token, which is genuinely useful — and is also a way to lock a
 * customer out of their own settings page, because a corporate IdP is
 * frequently reachable only from inside the corporate network. An admin
 * clicking "Test" from a hotel would get a red cross, conclude the setup is
 * broken, and start changing working configuration. The check here is
 * therefore *only* about whether the config we stored is internally complete
 * and readable — never about whether the IdP answers.
 *
 * That is still worth a button, because the failure this catches is the one
 * the admin cannot see: a config that is well-formed JSON but missing a field
 * BetterAuth dereferences. Those produce a 500 with an empty body at login
 * (audit Phase A.2) and no signal at all at registration time.
 *
 * `needsRuntimeDiscovery` is imported from the plugin rather than
 * reimplemented, so "will this provider hit the network at login?" is
 * answered by the same function BetterAuth answers it with
 * (`dist/index.mjs:1264-1267`) and cannot drift.
 *
 * Gated on `identity.manage` (OWNER) for the same reason the detail route
 * gates its config on that permission: this response describes the client
 * secret and the signing cert.
 *
 * POST with no side effects: nothing is written, no audit row is emitted, and
 * re-running it is free. POST rather than GET because a future version that
 * *does* dial the IdP must not be reachable by a prefetch or a crawler.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { needsRuntimeDiscovery } from "@better-auth/sso";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { validateSamlCert } from "@/lib/sso/provider-schemas";
import { deriveAcsUrl } from "@/lib/sso/derive-urls";
import { SecretPayloadError } from "@/lib/sso/secret-crypto";
import {
  readStoredOidcConfig,
  readStoredSamlConfig,
} from "@/lib/sso/stored-config";

type CheckStatus = "pass" | "fail" | "warn";

interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
}

function check(id: string, ok: boolean, pass: string, fail: string): Check {
  return { id, status: ok ? "pass" : "fail", detail: ok ? pass : fail };
}

/** Outcome-dependent check: pass and fail text supplied by the caller. */
function checkEither(
  id: string,
  ok: boolean,
  texts: { pass: string; fail: string },
): Check {
  return { id, status: ok ? "pass" : "fail", detail: ok ? texts.pass : texts.fail };
}

function warn(id: string, detail: string): Check {
  return { id, status: "warn", detail };
}

/**
 * The provider row as the Prisma layer returns it: the two config columns
 * already decrypted and parsed by `lib/prisma-sso-secret-extension.ts`.
 */
function findProvider(providerId: string, orgId: string) {
  return prisma.ssoProvider.findFirst({
    where: { providerId, organizationId: orgId },
    select: {
      providerId: true,
      issuer: true,
      domain: true,
      oidcConfig: true,
      samlConfig: true,
    },
  });
}

export async function POST(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; providerId: string }>;
  },
) {
  const { orgId, providerId } = await params;
  // `identity.manage` (OWNER), not `identity.read`: the checks below read the
  // client secret and the signing cert out of the stored config.
  const access = await requireOrgAccess(orgId, { permission: "identity.manage" });
  if (access.error) return access.error;

  // The stored config is decrypted and parsed by the `$extends({ result })`
  // map in `lib/prisma-sso-secret-extension.ts`, so `oidcConfig` /
  // `samlConfig` arrive as objects, for both the `sso:v1:` envelope and the
  // legacy plaintext-JSON format. `readStoredOidcConfig` /
  // `readStoredSamlConfig` narrow them field by field; the per-field checks
  // below then answer "is this specific value usable".
  //
  // The catch wraps the QUERY, not the narrowing, because that is where a
  // failure now happens: a key that is not mounted, a key that was rotated
  // without re-running `scripts/encrypt-sso-secrets.ts`, or a truncated
  // column all throw `SecretPayloadError` out of `findFirst`. A
  // `key_unavailable` failure is a deployment fault and is reported as such
  // rather than as a broken provider, because the operator cannot fix it by
  // re-entering the IdP.
  let provider: Awaited<ReturnType<typeof findProvider>>;
  try {
    provider = await findProvider(providerId, orgId);
  } catch (err) {
    if (!(err instanceof SecretPayloadError)) throw err;
    Sentry.captureException(err, {
      tags: { subsystem: "enterprise", op: "sso-provider-test" },
      extra: { failure: err.failure },
    });
    const keyMissing = err.failure === "key_unavailable";
    return NextResponse.json(
      {
        providerId,
        // `null`, not "oidc"/"saml": the row never came back, so which
        // config holds the credential is genuinely unknown. The success path
        // already types this field as nullable, so the client handles it.
        providerType: null,
        checks: [
          check(
            "config_readable",
            false,
            "The stored configuration could be read.",
            keyMissing
              ? "The server's SSO encryption key is missing or malformed, so this provider's configuration cannot be read. Contact support — re-entering the IdP details will not help."
              : "The stored configuration could not be read, so this provider cannot sign anyone in. Re-enter the IdP details to rewrite it.",
          ),
        ],
        ok: false,
      },
      { status: 200 },
    );
  }

  if (!provider) {
    return NextResponse.json(
      { error: "SSO provider not found" },
      { status: 404 },
    );
  }

  const checks: Check[] = [];
  const isSaml = Boolean(provider.samlConfig);
  const isOidc = Boolean(provider.oidcConfig);

  // Why this check does not report the storage format.
  //
  // It used to say "the stored configuration is encrypted and was decrypted
  // successfully" when `isEncrypted(storedColumn)` was true, and "is
  // readable" otherwise. That test was possible only while the route held the
  // raw column, and it stopped being possible when the decrypt moved into the
  // Prisma result extension: normalising both formats to a parsed object is
  // the whole point of that extension, and a by-product is that no caller can
  // ask which format a row is in any more.
  //
  // The alternative was to re-expose the format as a computed boolean
  // (`oidcConfigEncrypted` / `samlConfigEncrypted`) purely so this string
  // could keep saying it. That was not worth it. The flag would be a display
  // concern crossing into the database layer — a second field, and a second
  // thing to keep in step with the envelope version — and it would have had
  // exactly one consumer: this sentence. An operator who clicks "Test
  // connection" wants to know whether they can use this IdP, not which of two
  // correct storage formats the row happens to use. So the message now states
  // what is actually observable here, which is that the config was read. If a
  // deployment ever needs to assert the format, that assertion belongs in
  // `scripts/encrypt-sso-secrets.ts`, which reads the column raw for exactly
  // that reason.

  if (!isSaml && !isOidc) {
    checks.push(
      warn(
        "config_present",
        "This provider has neither a SAML nor an OIDC configuration, so it cannot sign anyone in. Re-enter the IdP details.",
      ),
    );
  }

  if (isSaml && isOidc) {
    checks.push(
      warn(
        "config_present",
        "Both SAML and OIDC configs are stored on this provider. BetterAuth picks the OIDC one; remove the stale config.",
      ),
    );
  }

  const oidc = readStoredOidcConfig(provider.oidcConfig);
  const saml = readStoredSamlConfig(provider.samlConfig);

  // Reached only when the query above did not throw, so the config was
  // readable. Deliberately says nothing about HOW it is stored — see the
  // note below the `checks` array.
  checks.push(
    check(
      "config_readable",
      true,
      "The stored configuration was read successfully.",
      "The stored configuration could not be read.",
    ),
  );

  if (oidc) {
    checks.push(
      check(
        "client_id",
        Boolean(oidc.clientId),
        "An OIDC client ID is present.",
        "No OIDC client ID is stored.",
      ),
    );
    checks.push(
      check(
        "client_secret",
        Boolean(oidc.clientSecret),
        "An OIDC client secret is present.",
        "No OIDC client secret is stored. Token exchange will fail.",
      ),
    );
    // The check that matters most, and the one an admin cannot perform by
    // eye. `needsRuntimeDiscovery` is BetterAuth's own predicate, so a "pass"
    // here means the sign-in path will not attempt a network fetch.
    const needsDiscovery = needsRuntimeDiscovery(oidc);
    checks.push(
      checkEither("endpoints", !needsDiscovery, {
        pass: "Authorization, token and JWKS endpoints are all stored, so sign-in will not need to run OIDC discovery.",
        fail: "This provider is missing its authorization, token or JWKS endpoints, so BetterAuth will try to fetch them from the IdP on every sign-in. That usually means the provider was saved before OIDC discovery was run, and it fails outright for an IdP our servers cannot reach.",
      }),
    );
    checks.push(
      check(
        "issuer_matches_row",
        oidc.issuer === provider.issuer,
        "The stored config's issuer matches the provider row.",
        `The stored config's issuer ("${oidc.issuer}") does not match the provider row ("${provider.issuer}"). Discovery validates them against each other and will refuse to sign anyone in.`,
      ),
    );
  }

  if (saml) {
    checks.push(
      check(
        "cert_parses",
        // `!== undefined` rather than `Boolean(saml.cert) && …`: it is the only
        // form TypeScript narrows, and the two cannot disagree about the
        // outcome — an empty cert string passes `!== undefined` and then fails
        // `validateSamlCert`, which is exactly what `Boolean("")` short-circuits
        // to. The narrowing is the point: `readStoredSamlConfig` guarantees
        // `cert` is a string when present, so there is nothing else to guard.
        saml.cert !== undefined && validateSamlCert(saml.cert),
        "The signing certificate parses as a valid PEM-encoded X.509.",
        "The signing certificate is not a parseable PEM-encoded X.509. Copy the 'Certificate (PEM)' block from your IdP, not a fingerprint.",
      ),
    );
    checks.push(
      check(
        "entry_point",
        isHttpUrl(saml.entryPoint),
        "The IdP entry point is an http(s) URL.",
        "The IdP entry point is not a valid http(s) URL.",
      ),
    );
    // The check for the defect that takes SAML down silently. BetterAuth 1.6.5
    // dereferences `parsedSamlConfig.spMetadata.metadata` with no optional
    // chaining at `dist/index.mjs:2447` (sign-in) and `:1851` (SP metadata), so
    // a config without `spMetadata` throws
    // `TypeError: Cannot read properties of undefined (reading 'metadata')` and
    // the user gets a blank page. Rows written before
    // `lib/sso/stored-config.ts` are exactly in that state.
    //
    // The `typeof … === "object"` half of this test used to be here. It is gone
    // because `readStoredSamlConfig` now guarantees an object (and excludes
    // arrays, which the old test would have passed — `typeof [] === "object"`
    // is true, and BetterAuth cannot use an array here). So the test got
    // stricter while getting shorter, which is the only direction worth moving
    // a check.
    checks.push(
      check(
        "sp_metadata",
        Boolean(saml.spMetadata),
        "SP metadata is present, so BetterAuth will not crash building the AuthnRequest.",
        "SP metadata is missing. BetterAuth 1.6.5 will throw a TypeError at sign-in and the user will see a blank page. Delete and re-create this provider to rewrite the config.",
      ),
    );
    // A truthy `callbackUrl` overrides the derived ACS location at
    // `dist/index.mjs:1851` and `:2451`, so a hand-edited one that drifted from
    // the derived value breaks assertion delivery with no other symptom.
    checks.push(
      checkEither("acs_url_derived", !saml.callbackUrl, {
        pass: `The ACS URL is derived from the provider slug (${deriveAcsUrl(provider.providerId, "saml")}), not overridden.`,
        fail: "This config carries an explicit callbackUrl, which overrides the derived ACS URL. Re-create the provider so the ACS URL is derived again.",
      }),
    );
  }

  const ok = checks.every((entry) => entry.status !== "fail");
  return NextResponse.json({
    providerId: provider.providerId,
    issuer: provider.issuer,
    domain: provider.domain,
    providerType: isOidc ? "oidc" : isSaml ? "saml" : null,
    ok,
    checks,
    // Stated so the UI does not imply more than the route promises: this
    // endpoint never dialled the identity provider.
    contactedIdp: false,
  });
}

function isHttpUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const { protocol } = new URL(raw);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

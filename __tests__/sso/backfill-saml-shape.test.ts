/**
 * @jest-environment node
 */

/**
 * Covers the pure decision layer of `scripts/backfill-sso-saml-shape.ts` —
 * the part that decides what should happen to a row — and deliberately not
 * the IO around it.
 *
 * ## Why the decision layer is worth testing on its own
 *
 * The interesting failure of this script is not a crash, it is a *quiet
 * rewrite of the wrong value*. `SsoProvider.samlConfig` holds the only copy of
 * a customer's IdP configuration; if the backfill writes a config that
 * parses, satisfies the invariants, and silently loses `issuer` / `entryPoint`
 * / `cert` / `privateKey`, nothing in the repo notices until a real sign-in
 * fails. So the tests here pin three properties rather than "does it run":
 *
 *   1. **Byte-identical output.** The canonical value the script would store
 *      must be exactly `JSON.stringify(buildStoredSamlConfig(input))`. This is
 *      why the script *calls* `buildStoredSamlConfig` instead of hand-writing
 *      the object; the assertion below is what makes that choice testable.
 *   2. **Idempotency.** Feeding the script's own output back in must produce
 *      `already-correct` with `canonical: null` — i.e. nothing to write. That
 *      is the property that makes `--apply` safe to re-run.
 *   3. **Refusal to guess.** A row it cannot read, or cannot rebuild, must
 *      come back with `canonical: null` and never a rewritten value.
 *
 * IO (Prisma, the transaction, the console) is exercised by running the
 * script; the tests below use the injected `decrypt` so the envelope branch
 * is reachable without mounting `AUTH_CONFIG_ENCRYPTION_KEY`.
 */

import {
  assertUsableSamlShape,
  checkSamlInvariants,
  planSamlBackfill,
  type SamlBackfillPlan,
  type SamlDecrypt,
} from "@/scripts/backfill-sso-saml-shape";
import { buildStoredSamlConfig } from "@/lib/sso/stored-config";
import { SecretPayloadError } from "@/lib/sso/secret-crypto";
import { validateSamlCert } from "@/lib/sso/provider-schemas";

/**
 * Parse-only self-signed RSA-2048 fixture, generated once with
 *   openssl req -x509 -newkey rsa:2048 -nodes -days 36500 -subj /CN=...
 * and copied from `__tests__/sso/provider-schemas.test.ts`. It is never used
 * to verify a SAML signature, so its identity and expiry are irrelevant; what
 * matters is that `validateSamlCert` accepts it and the garbage-cert cases
 * below reject.
 */
const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDIzCCAgugAwIBAgIUdIXLLS2I0pg1nRxPsX7Sk2wL7GAwDQYJKoZIhvcNAQEL
BQAwIDEeMBwGA1UEAwwVZmFtaWxpYXJpc2UtdGVzdC1jZXJ0MCAXDTI2MDUxNjA1
MzM0M1oYDzIxMjYwNDIyMDUzMzQzWjAgMR4wHAYDVQQDDBVmYW1pbGlhcmlzZS10
ZXN0LWNlcnQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCNzbqR3o7y
ffbVj9X4Ea1TiFnGpXFfu599YDhFmproj05DqnjgAfJH5IfKL4yVE5fnFBy5Sa83
mc1FZUl9BGtfQGt/5FUK5vQ6wI+yQhCUVT4iN0hldgjiw/VY7XjSdGImBpDOJk+8
g1qVcfuOB3kRbEBo46smx+ESGjnwEDEYCa11VN0COPYJXrHSDIRwn5IHjskOVdoF
dZ+mu9pM/9MSckXZ+lCEVgC4RvHqZrXkWoY4tTluk4I8G9LkSEbOGo3Q3a+GEKCZ
cXgoUKSLMfCKMt5CTbCvqAvSiDudJja0ACVoDYL6Vf+PnOewBChP0ReZvZinRS1u
ovEi17At4hr7AgMBAAGjUzBRMB0GA1UdDgQWBBQArnYD6KV36Si8Srb+TJ8dwsYy
BjAfBgNVHSMEGDAWgBQArnYD6KV36Si8Srb+TJ8dwsYyBjAPBgNVHRMBAf8EBTAD
AQH/MA0GCSqGSIb3DQEBCwUAA4IBAQB7yQ8/P1OcC57xNqJsqtpCr/PHcvIsuvAX
+UEcTpJDXgG6M4O7IhF8CGtnFgKhbucAuTj/lWPS8kwCtjnG5wIibgComRlAyiNU
AFGl1+wLkHWMQRwjeQ0LD/Lafd4Mqr3/uLXAdjtri3cco3ZLpq8+b4QxrhZ2sb0t
0CfV+qZful0jbRd/VnaMws2jW7lUA0wYhirka+sFFqWII1P6SjvxGzPs68Ro7JE5
iuxSGXsz1dHPrWW2FgOlOq8tBcBhGaRHsdd2oBFB6RcCVmKyVth4x/I9OWIuyMXY
zI7Ra8q1TUULKRu7kbkXo8Apyv3nkX+E36UONay6CF7fL3IIjZh5
-----END CERTIFICATE-----`;

const GARBAGE_CERT =
  "-----BEGIN CERTIFICATE-----\nMIIC...not-valid-base64\n-----END CERTIFICATE-----";

const INPUT = {
  issuer: "https://idp.acme.com",
  entryPoint: "https://idp.acme.com/sso/saml",
  cert: TEST_CERT_PEM,
};

/** The exact object the old create route `JSON.stringify`d into the column. */
const LEGACY = { issuer: INPUT.issuer, entryPoint: INPUT.entryPoint, cert: INPUT.cert };

/** What `buildStoredSamlConfig` produces — i.e. what the create route writes now. */
const CANONICAL = buildStoredSamlConfig(INPUT);

/** Plan a row through the plaintext path with the production decrypt. */
function planPlain(payload: Record<string, unknown> | null): SamlBackfillPlan {
  return planSamlBackfill(payload === null ? null : JSON.stringify(payload));
}

/** A fake envelope. `isEncrypted` is a `sso:v1:` prefix test, so the shape
 *  of the remainder is irrelevant when the decrypt is injected. */
const FAKE_ENVELOPE = "sso:v1:aXY.aGFn.Y2lwaGVy";

const asEnvelope =
  (payload: Record<string, unknown>): SamlDecrypt =>
  () =>
    payload;

describe("checkSamlInvariants", () => {
  it("passes a canonical config with no violations", () => {
    expect(validateSamlCert(TEST_CERT_PEM)).toBe(true);
    expect(checkSamlInvariants({ ...CANONICAL })).toEqual([]);
  });

  it("reports the legacy shape as exactly the two additive violations", () => {
    expect(checkSamlInvariants({ ...LEGACY })).toEqual([
      "sp-metadata-missing",
      "callback-url-absent",
    ]);
  });

  it("treats a non-empty callbackUrl as a violation, not a pass", () => {
    // The whole point of `callbackUrl: ""` is that there is no value here to
    // drift from the ACS URL BetterAuth derives. A real URL reintroduces it.
    expect(checkSamlInvariants({ ...CANONICAL, callbackUrl: "https://x.test/acs" })).toEqual([
      "callback-url-not-empty",
    ]);
  });

  it("rejects an spMetadata that is an array", () => {
    // `typeof [] === "object"`, so a bare check would pass this. BetterAuth
    // cannot use it, so neither can we.
    expect(checkSamlInvariants({ ...CANONICAL, spMetadata: [] })).toEqual([
      "sp-metadata-not-an-object",
    ]);
  });

  it("rejects null / scalar / non-string spMetadata as not-an-object", () => {
    for (const spMetadata of [null, "{}", 7, true]) {
      expect(checkSamlInvariants({ ...CANONICAL, spMetadata })).toEqual([
        "sp-metadata-not-an-object",
      ]);
    }
  });

  it("reports a cert that does not parse as X.509", () => {
    expect(validateSamlCert(GARBAGE_CERT)).toBe(false);
    expect(checkSamlInvariants({ ...CANONICAL, cert: GARBAGE_CERT })).toEqual([
      "cert-not-x509",
    ]);
  });

  it("emits violations in a fixed order so --verify output is stable", () => {
    const broken = { spMetadata: "nope", callbackUrl: "https://x.test", cert: 42 };
    expect(checkSamlInvariants(broken)).toEqual([
      "sp-metadata-not-an-object",
      "callback-url-not-empty",
      "issuer-absent",
      "entry-point-absent",
      "cert-absent",
    ]);
  });
});

describe("assertUsableSamlShape", () => {
  it("accepts a canonical config", () => {
    expect(() => assertUsableSamlShape({ ...CANONICAL })).not.toThrow();
  });

  it("throws on a shape that is itself unusable", () => {
    // Guards the invariant that `buildStoredSamlConfig` is the only thing
    // allowed to produce a value this script writes: if it ever regressed, the
    // run must abort before touching the table rather than store a config
    // that cannot sign anyone in.
    expect(() =>
      assertUsableSamlShape({ issuer: "i", entryPoint: "e", cert: TEST_CERT_PEM }),
    ).toThrow(/Refusing to write a SAML config/);
  });

  it("does NOT throw on an unparseable cert", () => {
    // A bad PEM is the customer's data, not a fault in the builder. Blocking
    // the run on it would turn one repairable row into a table-wide abort; the
    // row is instead rewritten and reported as `rewritten-invalid-cert`.
    expect(() =>
      assertUsableSamlShape({ ...CANONICAL, cert: GARBAGE_CERT }),
    ).not.toThrow();
  });
});

describe("planSamlBackfill — no-op branches", () => {
  it("skips a null column (an OIDC-only provider) without calling decrypt", () => {
    const decrypt = jest.fn();
    const plan = planSamlBackfill(null, decrypt);
    expect(plan.action).toBe("skipped-no-saml");
    expect(plan.canonical).toBeNull();
    expect(plan.reason).toBeNull();
    expect(plan.beforeShape).toBe("none");
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("treats an empty-string column the same as null", () => {
    const plan = planSamlBackfill("", jest.fn());
    expect(plan.action).toBe("skipped-no-saml");
    expect(plan.canonical).toBeNull();
  });

  it("is a no-op on a plaintext row that is already canonical", () => {
    const plan = planPlain({ ...CANONICAL });
    expect(plan.action).toBe("already-correct");
    // `canonical: null` is the machine-readable half of "no-op": a caller that
    // forgets to check `action` still cannot write anything.
    expect(plan.canonical).toBeNull();
    expect(plan.violations).toEqual([]);
    expect(plan.storage).toBe("plaintext");
    expect(plan.beforeShape).toBe("canonical");
  });

  it("is a no-op on an envelope row that is already canonical", () => {
    const plan = planSamlBackfill(FAKE_ENVELOPE, asEnvelope({ ...CANONICAL }));
    expect(plan.action).toBe("already-correct");
    expect(plan.canonical).toBeNull();
    expect(plan.storage).toBe("envelope");
  });
});

describe("planSamlBackfill — rewrite branches", () => {
  it("rewrites the legacy plaintext shape", () => {
    const plan = planPlain({ ...LEGACY });
    expect(plan.action).toBe("rewritten");
    expect(plan.storage).toBe("plaintext");
    expect(plan.violations).toEqual([
      "sp-metadata-missing",
      "callback-url-absent",
    ]);
    expect(plan.beforeShape).toBe("legacy{cert,entryPoint,issuer}");
    expect(plan.afterShape).toBe("canonical");
    expect(plan.reason).toBeNull();
  });

  it("produces BYTE-IDENTICAL output to buildStoredSamlConfig", () => {
    // The load-bearing assertion of this whole file. If this drifts, a second
    // deployment that writes the canonical shape and this backfill that writes
    // "the same" shape are no longer the same value, and nothing detects it.
    const plan = planPlain({ ...LEGACY });
    expect(JSON.stringify(plan.canonical)).toBe(JSON.stringify(CANONICAL));
  });

  it("carries issuer / entryPoint / cert through unchanged", () => {
    const plan = planPlain({ ...LEGACY });
    expect(plan.canonical).toMatchObject({
      issuer: INPUT.issuer,
      entryPoint: INPUT.entryPoint,
      cert: INPUT.cert,
    });
  });

  it("adds the two load-bearing fields with their documented values", () => {
    const plan = planPlain({ ...LEGACY });
    expect(plan.canonical?.spMetadata).toEqual({});
    expect(plan.canonical?.callbackUrl).toBe("");
  });

  it("is idempotent: feeding its own output back in is already-correct", () => {
    const first = planPlain({ ...LEGACY });
    const second = planSamlBackfill(JSON.stringify(first.canonical));
    expect(second.action).toBe("already-correct");
    expect(second.canonical).toBeNull();
    // Two runs of --apply: the first rewrites, the second writes nothing.
    expect([first.action, second.action]).toEqual(["rewritten", "already-correct"]);
  });

  it("rewrites an envelope row and keeps it an envelope", () => {
    // `storage` is what the IO layer uses to decide between
    // `encryptSecretPayload` and `JSON.stringify`. Getting it wrong would put
    // a plaintext IdP secret back in an encrypted row.
    const plan = planSamlBackfill(FAKE_ENVELOPE, asEnvelope({ ...LEGACY }));
    expect(plan.action).toBe("rewritten");
    expect(plan.storage).toBe("envelope");
    expect(JSON.stringify(plan.canonical)).toBe(JSON.stringify(CANONICAL));
  });

  it("resets a hand-set callbackUrl to the empty string", () => {
    const plan = planPlain({ ...CANONICAL, callbackUrl: "https://idp.acme.com/acs" });
    expect(plan.action).toBe("rewritten");
    expect(plan.violations).toEqual(["callback-url-not-empty"]);
    expect(plan.canonical?.callbackUrl).toBe("");
  });

  it("replaces an unusable spMetadata with {}", () => {
    const plan = planPlain({ ...CANONICAL, spMetadata: ["nope"] });
    expect(plan.action).toBe("rewritten");
    expect(plan.violations).toEqual(["sp-metadata-not-an-object"]);
    expect(plan.canonical?.spMetadata).toEqual({});
  });

  it("preserves BetterAuth fields this repo does not model", () => {
    // A SAML provider with an SP signing key. Dropping it would produce a row
    // that looks healthy and cannot sign its own AuthnRequest.
    const plan = planPlain({ ...LEGACY, privateKey: "-----BEGIN PRIVATE KEY-----x" });
    expect(plan.action).toBe("rewritten");
    const canonical = plan.canonical as unknown as Record<string, unknown>;
    expect(canonical.privateKey).toBe("-----BEGIN PRIVATE KEY-----x");
    // …and the canonical fields still win, so a stale `privateKey`-adjacent
    // override cannot survive the rewrite.
    expect(canonical.callbackUrl).toBe("");
  });

  it("reports a row whose cert does not parse as rewritten-invalid-cert", () => {
    const plan = planPlain({ ...LEGACY, cert: GARBAGE_CERT });
    expect(plan.action).toBe("rewritten-invalid-cert");
    expect(plan.violations).toContain("cert-not-x509");
    // Still rewritten: the shape fix is independent of the certificate, and
    // leaving the row alone keeps it broken in two ways instead of one. But it
    // is not counted as a successful rewrite, so the run exits non-zero.
    expect(plan.canonical).not.toBeNull();
  });

  it("reports an invalid cert on an already-correct-shaped row too", () => {
    const plan = planPlain({ ...CANONICAL, cert: GARBAGE_CERT });
    expect(plan.action).toBe("rewritten-invalid-cert");
    expect(plan.violations).toEqual(["cert-not-x509"]);
  });
});

describe("planSamlBackfill — refusal branches", () => {
  it("never rewrites a row it cannot decrypt", () => {
    const plan = planSamlBackfill(FAKE_ENVELOPE, () => {
      throw new SecretPayloadError("auth_failed", "GCM authentication failed");
    });
    expect(plan.action).toBe("skipped-unreadable");
    expect(plan.reason).toBe("auth_failed");
    expect(plan.canonical).toBeNull();
    expect(plan.storage).toBe("envelope");
    expect(plan.afterShape).toBe("unchanged");
  });

  it("surfaces key_unavailable distinctly from auth_failed", () => {
    // The two send an operator to completely different places: one fixes an
    // env var, the other means the row needs re-entering.
    const plan = planSamlBackfill(FAKE_ENVELOPE, () => {
      throw new SecretPayloadError("key_unavailable", "AUTH_CONFIG_ENCRYPTION_KEY");
    });
    expect(plan.action).toBe("skipped-unreadable");
    expect(plan.reason).toBe("key_unavailable");
  });

  it("rethrows a non-SecretPayloadError instead of blaming the row", () => {
    // A reader bug would otherwise be reported as a whole unreadable table.
    expect(() =>
      planSamlBackfill(FAKE_ENVELOPE, () => {
        throw new TypeError("bug in the decrypt implementation");
      }),
    ).toThrow(TypeError);
  });

  it("skips corrupt plaintext that is not JSON", () => {
    const plan = planSamlBackfill("{not json");
    expect(plan.action).toBe("skipped-unreadable");
    expect(plan.reason).toBe("payload_not_json");
    expect(plan.canonical).toBeNull();
  });

  it("skips a payload that is not a plain object", () => {
    const notObjects: unknown[] = [null, [1, 2], "a string", 7];
    for (const payload of notObjects) {
      const plan = planSamlBackfill(FAKE_ENVELOPE, () => payload as Record<string, unknown>);
      expect(plan.action).toBe("skipped-not-a-saml-config");
      expect(plan.reason).toBe("payload-not-an-object");
      expect(plan.canonical).toBeNull();
    }
  });

  it("skips a config whose required fields are not strings", () => {
    const plan = planPlain({ ...LEGACY, cert: 42 });
    expect(plan.action).toBe("skipped-not-a-saml-config");
    expect(plan.reason).toBe("required-field-not-a-string");
    expect(plan.canonical).toBeNull();
    expect(plan.beforeShape).toBe("unbuildable{cert}");
  });

  it("lists every missing required field, not just the first", () => {
    const plan = planPlain({ spMetadata: {}, callbackUrl: "" });
    expect(plan.beforeShape).toBe("unbuildable{issuer,entryPoint,cert}");
  });

  it("refuses to invent a cert for a row that has none", () => {
    // The alternative — writing `{issuer, entryPoint, cert: undefined, …}` —
    // produces a row that passes `typeof` checks downstream and cannot sign.
    const plan = planPlain({ issuer: INPUT.issuer, entryPoint: INPUT.entryPoint });
    expect(plan.action).toBe("skipped-not-a-saml-config");
    expect(plan.canonical).toBeNull();
  });
});

/**
 * Prisma result extension that transparently decrypts `SsoProvider.oidcConfig`
 * and `SsoProvider.samlConfig` on read.
 *
 * ## Why an extension and not an adapter hook
 *
 * `@better-auth/prisma-adapter` 1.6.5 exposes no transform hook — its config is
 * `{ provider, schema? }` and nothing else. BetterAuth's core adapter factory
 * has an internal `transformInput` (see `@better-auth/core/dist/db/adapter/
 * factory.mjs:99`) but it is not surfaced, and it is *input* only anyway; what
 * is needed here is a *read* transform.
 *
 * The plugin reads the column as:
 *
 *   `parsedSamlConfig = typeof c === "object" ? c : safeJsonParse(c)`  (index.mjs:2375)
 *
 * so an envelope string is not JSON and `safeJsonParse` yields `undefined`,
 * which the plugin reports as `BAD_REQUEST "OIDC provider is not configured"`.
 * There is no `SSOOptions` key for this — every one was enumerated, none
 * decrypts. The database is therefore the only seam, and the repo already has
 * a `$extends({ result })` pattern in `lib/prisma-extensions.ts` for the money
 * BigInt conversions. This is the same mechanism, applied to two string columns.
 *
 * ## Why that is the *right* seam
 *
 * Decrypting in the Prisma layer means every reader is covered — BetterAuth's
 * SSO plugin, the admin settings GET, the pre-auth `domain-check`, the cert
 * expiry cron — with no caller able to forget. The alternative, decrypting at
 * each call site, is exactly how a tenant's IdP secret ends up in a log line
 * one day later.
 *
 * ## Cost
 *
 * `decryptIfNeeded` returns plaintext unchanged, so a deployment with the
 * feature off pays one `isEncrypted` prefix test per read. `isEncrypted` is a
 * `startsWith("sso:v1:")` — a string compare, not a KDF. There is deliberately
 * **no** cryptographic work on the hot path unless the envelope is actually
 * present, and no key derivation at all unless decryption is attempted.
 *
 * ## Failure is typed, never a 500
 *
 * A missing or wrong key, a truncated envelope, or a failed AEAD tag all resolve
 * to a `decrypt` failure that the callers (notably the pre-auth
 * `domain-check`) translate into `SSO_PROVIDER_MISCONFIGURED`. Throwing from
 * here would surface as an empty-body 500 on a page a customer is looking at,
 * which is the exact failure mode `lib/sso/provider-schemas.ts` documents for
 * the un-validated-certificate bug this column shape also caused.
 */

import { decryptSecretPayload, SecretPayloadError } from "./sso/secret-crypto";

/** The two columns a `SsoProvider` row may carry. */
const ENCRYPTED_COLUMNS = ["oidcConfig", "samlConfig"] as const;
type EncryptedColumn = (typeof ENCRYPTED_COLUMNS)[number];

/**
 * `Prisma.ResultExtension` field shape. Written by hand rather than derived
 * because the generic `compute` on a `$extends({ result })` map has no way to
 * express "this field is a string, and a null stays null".
 *
 * The result is **normalised to a parsed object for both storage formats** —
 * an `sso:v1:` envelope is decrypted, a legacy plaintext JSON blob is parsed.
 * That is what makes the union collapse: every reader downstream sees
 * `Record<string, unknown> | null` and never has to ask which format the row
 * happens to be in. It also matches what BetterAuth's plugin does at
 * `index.mjs:2375` (`typeof c === "object" ? c : safeJsonParse(c)`) — the
 * object branch is the one it takes, so nothing downstream is surprised.
 */
function encryptedField<K extends EncryptedColumn>(field: K) {
  return {
    needs: { [field]: true } as { [P in K]: true },
    compute: (row: { [P in K]: string | null }): Record<string, unknown> | null => {
      const stored = row[field];
      // `null` is a provider with no config of that kind (an OIDC-only provider
      // has a null samlConfig). It must stay null — not become `undefined`,
      // which the plugin's `typeof c === "object"` check would let through as a
      // bare object and then fail on a property read.
      if (stored === null || stored === undefined) return stored ?? null;
      // A decryption failure is typed (`SecretPayloadError`) and is left to
      // throw. Returning `null` would be swallowed by the plugin's
      // `!parsedConfig` check and reported as the far less actionable "OIDC
      // provider is not configured"; returning the ciphertext would be worse.
      // Callers that must not 500 — the pre-auth `domain-check` in particular —
      // catch `SecretPayloadError` and answer `SSO_PROVIDER_MISCONFIGURED`; see
      // `lib/sso/secret-crypto.ts`.
      return decryptSecretPayload<Record<string, unknown>>(stored);
    },
  };
}

/**
 * The extension map. `SsoProvider` gets one computed field per encrypted
 * column; every other model is untouched.
 *
 * Deliberately un-annotated, matching `lib/prisma-extensions.ts`: Prisma 7 does
 * not export a `ResultExtension` type, and hand-rolling a stand-in would only
 * be a weaker version of the check that actually matters. The real constraint is
 * enforced where the extension is consumed — `lib/prisma.ts`'s
 * `$extends({ result: { …, ssoProvider: … } })` call is type-checked against
 * the generated client, so a field name or arity mistake is a compile error
 * there, on the actual model, rather than a silently-skipped `compute`.
 *
 * Adding a third encrypted column means adding it to `ENCRYPTED_COLUMNS` *and*
 * to the map below. Nothing enforces that, so a drift test must assert every
 * column named in `lib/sso/secret-crypto.ts` appears in both.
 */
export const ssoSecretDecryptExtension = {
  ssoProvider: {
    oidcConfig: encryptedField("oidcConfig"),
    samlConfig: encryptedField("samlConfig"),
  },
};

export type { EncryptedColumn, SecretPayloadError };

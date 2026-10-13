/**
 * Prisma result extension that decrypts `SsoProvider.oidcConfig` on read.
 *
 * BetterAuth's SSO plugin reads the column as
 * `typeof c === "object" ? c : safeJsonParse(c)` and exposes no decrypt hook,
 * and the Prisma adapter has no read transform, so the Prisma client is the
 * only seam that covers every reader (the plugin and our admin routes) at
 * once. The result is always a parsed object or null.
 *
 * Prisma computes result-extension fields lazily, on property access, not
 * when the query resolves. A `SecretPayloadError` therefore surfaces where
 * `row.oidcConfig` is first read, not at the `await`. Callers that must not
 * 500 read the field inside their own try (see `readOidcConfig`).
 *
 * A failure throws rather than returning null: null would reach the plugin as
 * the misleading "OIDC provider is not configured".
 *
 * `samlConfig` is not decrypted: SAML is disabled and nothing writes it.
 */

import {
  decryptSecretPayload,
  SecretPayloadError,
  type SecretPayloadFailure,
} from "./sso/secret-crypto";

export const ssoSecretDecryptExtension = {
  ssoProvider: {
    oidcConfig: {
      needs: { oidcConfig: true },
      compute: (row: {
        oidcConfig: string | null;
      }): Record<string, unknown> | null =>
        decryptSecretPayload<Record<string, unknown>>(row.oidcConfig),
    },
  },
};

/**
 * Read the lazily-decrypted `oidcConfig` of a row, turning a decrypt failure
 * into a value instead of a throw.
 */
export function readOidcConfig(row: {
  oidcConfig: Record<string, unknown> | null;
}):
  | { config: Record<string, unknown> | null; failure: null }
  | { config: null; failure: SecretPayloadFailure; error: SecretPayloadError } {
  try {
    return { config: row.oidcConfig, failure: null };
  } catch (err) {
    if (!(err instanceof SecretPayloadError)) throw err;
    return { config: null, failure: err.failure, error: err };
  }
}

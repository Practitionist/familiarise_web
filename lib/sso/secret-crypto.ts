/**
 * AES-256-GCM encryption for the customer's OIDC client secret, stored in
 * `SsoProvider.oidcConfig`.
 *
 * A database dump, a read replica or a screenshot of the row must not hand
 * over a customer's IdP credential, so the column only ever holds an
 * envelope:
 *
 *   sso:v1:<kid>:<iv_b64url>:<tag_b64url>:<ciphertext_b64url>
 *
 * `kid` is the first 8 hex chars of SHA-256(key). It names the key without
 * revealing it, so a row written under a key the deployment no longer has is
 * reported as `key_unavailable` (a deployment fault) instead of `auth_failed`
 * (a tampered or corrupt row).
 *
 * Keys are 64 hex chars (`openssl rand -hex 32`), the same contract as
 * `PAN_ENCRYPTION_KEY`, but a separate secret so neither key's rotation or
 * compromise touches the other's data.
 *
 * Rotation: set the new key as `AUTH_CONFIG_ENCRYPTION_KEY`, the old one as
 * `AUTH_CONFIG_ENCRYPTION_KEY_PREVIOUS`, run
 * `scripts/rotate-sso-secret-key.ts`, then drop the previous key.
 *
 * There is no plaintext fallback: every writer goes through
 * {@link encryptSecretPayload}, and the BetterAuth endpoints that would write
 * plain JSON (`/sso/register`, `/sso/update-provider`) are disabled.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENVELOPE_PREFIX = "sso:v1:";
const KEY_HEX = /^[0-9a-fA-F]{64}$/;

/** Why a stored value could not be read. Callers map it to a message. */
export type SecretPayloadFailure =
  /** No configured key matches the row's kid, or the current key is unset. */
  | "key_unavailable"
  /** Not an `sso:v1:` envelope, or one with missing or non-base64url parts. */
  | "envelope_malformed"
  /** The GCM tag did not verify: tampered or truncated ciphertext. */
  | "auth_failed"
  /** Decrypted bytes are not JSON. */
  | "payload_not_json";

export class SecretPayloadError extends Error {
  readonly failure: SecretPayloadFailure;

  constructor(failure: SecretPayloadFailure, detail: string) {
    super(`SSO secret payload unreadable (${failure}): ${detail}`);
    this.name = "SecretPayloadError";
    this.failure = failure;
  }
}

interface Key {
  kid: string;
  bytes: Buffer;
}

function parseKey(hex: string | undefined): Key | null {
  if (!hex || !KEY_HEX.test(hex)) return null;
  const bytes = Buffer.from(hex, "hex");
  const kid = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  return { kid, bytes };
}

function currentKey(): Key {
  const key = parseKey(process.env.AUTH_CONFIG_ENCRYPTION_KEY);
  if (!key) {
    throw new SecretPayloadError(
      "key_unavailable",
      "AUTH_CONFIG_ENCRYPTION_KEY must be a 64-character hex string (openssl rand -hex 32)",
    );
  }
  return key;
}

function keyFor(kid: string): Key {
  for (const key of [
    parseKey(process.env.AUTH_CONFIG_ENCRYPTION_KEY),
    parseKey(process.env.AUTH_CONFIG_ENCRYPTION_KEY_PREVIOUS),
  ]) {
    if (key?.kid === kid) return key;
  }
  throw new SecretPayloadError(
    "key_unavailable",
    `no configured key has kid ${kid}`,
  );
}

const encode = (buffer: Buffer) => buffer.toString("base64url");
const decode = (part: string) => Buffer.from(part, "base64url");

/** The kid of the current key, or null when it is unset or malformed. */
export function currentKeyId(): string | null {
  return parseKey(process.env.AUTH_CONFIG_ENCRYPTION_KEY)?.kid ?? null;
}

/** True when `AUTH_CONFIG_ENCRYPTION_KEY` is set and well-formed. */
export function isEncryptionKeyUsable(): boolean {
  return currentKeyId() !== null;
}

/** The kid a stored envelope was written under, or null if it isn't one. */
export function envelopeKeyId(stored: string): string | null {
  if (!stored.startsWith(ENVELOPE_PREFIX)) return null;
  return stored.slice(ENVELOPE_PREFIX.length).split(":")[0] || null;
}

/** Encrypt a config object under the current key. */
export function encryptSecretPayload(payload: unknown): string {
  const key = currentKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key.bytes, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return (
    ENVELOPE_PREFIX +
    [key.kid, encode(iv), encode(cipher.getAuthTag()), encode(ciphertext)].join(
      ":",
    )
  );
}

/**
 * Read a stored config back. `null`/empty is "no config"; anything else must
 * be a readable envelope or this throws {@link SecretPayloadError}.
 */
export function decryptSecretPayload<T = unknown>(
  stored: string | null | undefined,
): T | null {
  if (stored === null || stored === undefined || stored === "") return null;

  const parts = stored.startsWith(ENVELOPE_PREFIX)
    ? stored.slice(ENVELOPE_PREFIX.length).split(":")
    : [];
  if (parts.length !== 4) {
    throw new SecretPayloadError(
      "envelope_malformed",
      "stored config is not an sso:v1 envelope",
    );
  }
  const [kid, ivPart, tagPart, ciphertextPart] = parts;
  // base64url decoding is lenient; a round trip rejects non-base64url parts.
  for (const part of [ivPart, tagPart, ciphertextPart]) {
    if (!part || encode(decode(part)) !== part) {
      throw new SecretPayloadError(
        "envelope_malformed",
        "envelope part is not base64url",
      );
    }
  }
  const iv = decode(ivPart);
  const authTag = decode(tagPart);
  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new SecretPayloadError(
      "envelope_malformed",
      `expected a ${IV_LENGTH}-byte IV and ${AUTH_TAG_LENGTH}-byte tag`,
    );
  }

  const key = keyFor(kid);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(ALGORITHM, key.bytes, iv);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([
      decipher.update(decode(ciphertextPart)),
      decipher.final(),
    ]);
  } catch (err) {
    throw new SecretPayloadError(
      "auth_failed",
      err instanceof Error ? err.message : "GCM authentication failed",
    );
  }

  try {
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    throw new SecretPayloadError(
      "payload_not_json",
      "decrypted envelope did not contain JSON",
    );
  }
}

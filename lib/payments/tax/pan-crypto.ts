/**
 * PAN Encryption Utility — AES-256-GCM
 *
 * Format: [12 bytes IV][ciphertext][16 bytes auth tag]
 * Key: PAN_ENCRYPTION_KEY env var (64 hex chars = 32 bytes)
 *
 * Generate key: openssl rand -hex 32
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const hex = process.env.PAN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "PAN_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes). " +
        "Generate with: openssl rand -hex 32",
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypt a PAN string.
 * Returns { encrypted: Buffer (IV + ciphertext + auth tag), last4: string }
 */
export function encryptPAN(pan: string): {
  encrypted: Uint8Array<ArrayBuffer>;
  last4: string;
} {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(pan, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, encrypted, authTag]);
  const result = new Uint8Array(combined.length);
  result.set(combined);

  return {
    encrypted: result,
    last4: pan.slice(-4),
  };
}

/**
 * Decrypt a PAN buffer back to plaintext string.
 * Only needed for Form 26Q admin filing.
 */
export function decryptPAN(combined: Buffer): string {
  const key = getKey();

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(
    IV_LENGTH,
    combined.length - AUTH_TAG_LENGTH,
  );

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

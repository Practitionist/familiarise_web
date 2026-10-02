import {
  decryptSecretPayload,
  encryptSecretPayload,
  envelopeKeyId,
  SecretPayloadError,
} from "../../lib/sso/secret-crypto";
import { readOidcConfig } from "../../lib/prisma-sso-secret-extension";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const config = { clientId: "c", clientSecret: "s3cret" };

function failureOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof SecretPayloadError) return err.failure;
    throw err;
  }
  return undefined;
}

describe("SSO secret envelope", () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env, AUTH_CONFIG_ENCRYPTION_KEY: KEY_A };
    delete process.env.AUTH_CONFIG_ENCRYPTION_KEY_PREVIOUS;
  });
  afterAll(() => {
    process.env = env;
  });

  it("round-trips and never stores the secret in clear", () => {
    const stored = encryptSecretPayload(config);
    expect(stored).toMatch(/^sso:v1:[0-9a-f]{8}:/);
    expect(stored).not.toContain("s3cret");
    expect(decryptSecretPayload(stored)).toEqual(config);
  });

  it("reads rows written under the previous key during a rotation", () => {
    const stored = encryptSecretPayload(config);
    process.env.AUTH_CONFIG_ENCRYPTION_KEY = KEY_B;
    expect(failureOf(() => decryptSecretPayload(stored))).toBe(
      "key_unavailable",
    );
    process.env.AUTH_CONFIG_ENCRYPTION_KEY_PREVIOUS = KEY_A;
    expect(decryptSecretPayload(stored)).toEqual(config);
    expect(envelopeKeyId(encryptSecretPayload(config))).not.toBe(
      envelopeKeyId(stored),
    );
  });

  it("refuses plaintext JSON", () => {
    expect(failureOf(() => decryptSecretPayload(JSON.stringify(config)))).toBe(
      "envelope_malformed",
    );
  });

  it("detects tampering", () => {
    const stored = encryptSecretPayload(config);
    const parts = stored.split(":");
    const ct = Buffer.from(parts[5], "base64url");
    ct[0] ^= 1;
    parts[5] = ct.toString("base64url");
    expect(failureOf(() => decryptSecretPayload(parts.join(":")))).toBe(
      "auth_failed",
    );
  });

  it("refuses to encrypt without a key", () => {
    delete process.env.AUTH_CONFIG_ENCRYPTION_KEY;
    expect(failureOf(() => encryptSecretPayload(config))).toBe(
      "key_unavailable",
    );
  });

  it("readOidcConfig turns a lazy decrypt failure into a value", () => {
    const row = {
      get oidcConfig(): Record<string, unknown> | null {
        return decryptSecretPayload("garbage");
      },
    };
    expect(readOidcConfig(row)).toMatchObject({
      config: null,
      failure: "envelope_malformed",
    });
  });
});

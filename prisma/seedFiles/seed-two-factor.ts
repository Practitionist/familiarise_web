import { createHmac } from "node:crypto";
import { symmetricEncrypt } from "better-auth/crypto";

const BACKUP_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const BACKUP_CODE_COUNT = 10;
const TOTP_STEP_MS = 30_000;
const TOTP_DIGITS = 6;

export function requireAuthSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET is required to pre-enrol seed operators.",
    );
  }
  return secret;
}

export function deriveSeedOperatorTotpSecret(email: string): string {
  const authSecret = requireAuthSecret();
  return createHmac("sha256", authSecret)
    .update(`seed-operator-2fa:totp:${email.trim().toLowerCase()}`)
    .digest("hex");
}

export function deriveSeedOperatorBackupCodes(email: string): string[] {
  const authSecret = requireAuthSecret();
  const normalizedEmail = email.trim().toLowerCase();
  const codes: string[] = [];

  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const digest = createHmac("sha256", authSecret)
      .update(`seed-operator-2fa:backup:${normalizedEmail}:${i}`)
      .digest();
    let partA = "";
    let partB = "";
    for (let j = 0; j < 5; j++) {
      partA += BACKUP_ALPHABET[digest[j] % BACKUP_ALPHABET.length];
      partB += BACKUP_ALPHABET[digest[j + 5] % BACKUP_ALPHABET.length];
    }
    codes.push(`${partA}-${partB}`);
  }

  return codes;
}

export function computeSeedOperatorTotp(email: string, now?: Date): string {
  const secret = deriveSeedOperatorTotpSecret(email);
  const timestampMs = now ? now.getTime() : Date.now();
  const counter = Math.floor(timestampMs / TOTP_STEP_MS);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);

  const digest = createHmac("sha1", Buffer.from(secret, "utf8"))
    .update(counterBuf)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const truncated =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(truncated % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export async function buildSeedOperatorTwoFactorRow(
  userId: string,
  email: string,
): Promise<{
  userId: string;
  secret: string;
  backupCodes: string;
  verified: true;
}> {
  const authSecret = requireAuthSecret();
  const rawSecret = deriveSeedOperatorTotpSecret(email);
  const rawBackupCodes = deriveSeedOperatorBackupCodes(email);

  const [secret, backupCodes] = await Promise.all([
    symmetricEncrypt({ key: authSecret, data: rawSecret }),
    symmetricEncrypt({
      key: authSecret,
      data: JSON.stringify(rawBackupCodes),
    }),
  ]);

  return {
    userId,
    secret,
    backupCodes,
    verified: true,
  };
}

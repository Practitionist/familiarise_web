import { createHmac } from "node:crypto";
import { symmetricEncrypt } from "better-auth/crypto";
import type { Prisma } from "@prisma/client";
import {
  QA_OPERATOR_DOMAIN,
  isQaOperatorEmail,
} from "../../lib/auth/qa-accounts";

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
  // A CLI message captured instead of the value (e.g. `netlify env:get` in an unlinked worktree) has spaces.
  if (/\s/.test(secret)) {
    throw new Error(
      "BETTER_AUTH_SECRET contains whitespace, so it is not a secret; read it from a linked checkout or the main .env.",
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

const SEED_OPERATOR_LOCAL_PART = /^qa-(admin|staff)-\d+$/;

/** A seeded QA operator that enrols TOTP: on the reserved domain and not 2FA-exempt. */
export function isSeedTotpOperatorEmail(
  email: string | null | undefined,
): boolean {
  const [localPart, domain, ...rest] = (
    email?.trim().toLowerCase() ?? ""
  ).split("@");
  return (
    rest.length === 0 &&
    domain === QA_OPERATOR_DOMAIN &&
    SEED_OPERATOR_LOCAL_PART.test(localPart) &&
    !isQaOperatorEmail(email)
  );
}

/**
 * The user update that writes the seed-derived TOTP row over whatever the
 * operator holds (fresh, or minted by a hand enrolment) and clears the lock.
 */
export async function seedOperatorEnrolmentUpdate(user: {
  id: string;
  email: string;
}) {
  const { secret, backupCodes } = await buildSeedOperatorTwoFactorRow(
    user.id,
    user.email,
  );
  const row = {
    secret,
    backupCodes,
    verified: true,
    failedVerificationCount: 0,
    lockedUntil: null,
  };
  return {
    where: { id: user.id },
    data: {
      twoFactorEnabled: true,
      twoFactor: { upsert: { create: row, update: row } },
    },
  } satisfies Prisma.UserUpdateArgs;
}

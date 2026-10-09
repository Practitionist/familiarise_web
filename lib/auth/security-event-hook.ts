import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { symmetricDecrypt } from "better-auth/crypto";
import { z } from "zod";
import {
  sendSecurityEventEmail,
  type SecurityEvent,
} from "@/lib/auth/security-email";
import { reportSentryError } from "@/lib/observability/report";

export type AuthHookContext = Parameters<
  Parameters<typeof createAuthMiddleware>[0]
>[0];

const PASSKEY_REGISTERED = "/passkey/verify-registration";
const BACKUP_CODES_GENERATED = "/two-factor/generate-backup-codes";
const BACKUP_CODE_VERIFY = "/two-factor/verify-backup-code";
const TOTP_VERIFY = "/two-factor/verify-totp";
const WATCHED = new Set([
  PASSKEY_REGISTERED,
  BACKUP_CODES_GENERATED,
  BACKUP_CODE_VERIFY,
  TOTP_VERIFY,
]);

// The two-factor plugin's pending sign-in cookie; it names the `2fa` verification row.
const TWO_FACTOR_COOKIE = "two_factor";
// Wrong-code failures the plugin counts toward the account lockout.
const COUNTED_FAILURES = new Set(["INVALID_CODE", "INVALID_BACKUP_CODE"]);

const twoFactorRowSchema = z.object({
  backupCodes: z.string(),
  lockedUntil: z.date().nullish(),
});
const passkeySchema = z.object({
  userId: z.string(),
  name: z.string().nullish(),
});
const returnedUserSchema = z.object({ user: z.object({ id: z.string() }) });
const backupCodesSchema = z.array(z.string());

type Notice = { userId: string; event: SecurityEvent };

async function readTwoFactor(ctx: AuthHookContext, userId: string) {
  const row = await ctx.context.adapter.findOne<unknown>({
    model: "twoFactor",
    where: [{ field: "userId", value: userId }],
  });
  return row ? twoFactorRowSchema.parse(row) : null;
}

// Mirrors the plugin's `storeBackupCodes: "encrypted"` read.
async function remainingBackupCodes(
  ctx: AuthHookContext,
  userId: string,
): Promise<number> {
  const row = await readTwoFactor(ctx, userId);
  if (!row) throw new Error("two-factor row missing after backup code use");
  const json = await symmetricDecrypt({
    key: ctx.context.secretConfig,
    data: row.backupCodes,
  });
  return backupCodesSchema.parse(JSON.parse(json)).length;
}

function sessionUserId(ctx: AuthHookContext): string | null {
  return (
    ctx.context.newSession?.user.id ?? ctx.context.session?.user.id ?? null
  );
}

// A counted sign-in failure that leaves the account locked is the one that
// set the lock: requests made while locked are refused before counting.
async function lockoutNotice(ctx: AuthHookContext): Promise<Notice | null> {
  const returned = ctx.context.returned;
  if (!isAPIError(returned) || ctx.context.session) return null;
  const code: unknown = returned.body?.code;
  if (typeof code !== "string" || !COUNTED_FAILURES.has(code)) return null;
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE);
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!identifier) return null;
  const challenge =
    await ctx.context.internalAdapter.findVerificationValue(identifier);
  if (!challenge) return null;
  const row = await readTwoFactor(ctx, challenge.value);
  if (!row?.lockedUntil || row.lockedUntil.getTime() <= Date.now()) {
    return null;
  }
  return {
    userId: challenge.value,
    event: { kind: "two-factor-locked", lockedUntil: row.lockedUntil },
  };
}

async function resolveNotice(
  ctx: AuthHookContext,
  path: string,
): Promise<Notice | null> {
  const returned = ctx.context.returned;
  if (isAPIError(returned) || returned instanceof Error) {
    return path === TOTP_VERIFY || path === BACKUP_CODE_VERIFY
      ? lockoutNotice(ctx)
      : null;
  }
  switch (path) {
    case PASSKEY_REGISTERED: {
      const passkey = passkeySchema.parse(returned);
      return {
        userId: passkey.userId,
        event: { kind: "passkey-added", passkeyName: passkey.name ?? null },
      };
    }
    case BACKUP_CODES_GENERATED: {
      const userId = sessionUserId(ctx);
      return userId
        ? { userId, event: { kind: "backup-codes-regenerated" } }
        : null;
    }
    case BACKUP_CODE_VERIFY: {
      const userId =
        sessionUserId(ctx) ?? returnedUserSchema.parse(returned).user.id;
      const remaining = await remainingBackupCodes(ctx, userId);
      return { userId, event: { kind: "backup-code-used", remaining } };
    }
    default:
      return null;
  }
}

/**
 * `hooks.after`: emails the user about passkey registration, backup-code
 * regeneration and use, and a two-factor lockout. Never throws.
 */
export async function notifySecurityEvents(
  ctx: AuthHookContext,
): Promise<void> {
  const path = ctx.path;
  if (!path || !WATCHED.has(path)) return;
  try {
    const notice = await resolveNotice(ctx, path);
    if (!notice) return;
    const user = await ctx.context.internalAdapter.findUserById(notice.userId);
    if (!user) return;
    await sendSecurityEventEmail(
      { id: user.id, email: user.email, name: user.name },
      notice.event,
    );
  } catch (error) {
    reportSentryError(error, {
      subsystem: "auth",
      op: "security-event-hook",
      level: "warning",
      tags: { path },
    });
  }
}

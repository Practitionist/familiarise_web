import { randomInt } from "node:crypto";
import { APIError, getSessionFromCtx } from "better-auth/api";
import type { GenericEndpointContext } from "better-auth";
import { z } from "zod";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";
import { authUserFields } from "@/lib/auth/step-up";

const withRole = z.object({ role: z.string().nullish() });

function roleOf(user: unknown): string | null | undefined {
  const parsed = withRole.safeParse(user);
  return parsed.success ? parsed.data.role : undefined;
}

/**
 * `hooks.before` on /two-factor/enable. Consumer 2FA has no UI, recovery or
 * admin reset, and social/SSO sign-in never challenges it, so only operators
 * may enable it.
 */
export async function assertOperatorMayEnableTwoFactor(
  ctx: GenericEndpointContext,
): Promise<void> {
  if (ctx.path !== "/two-factor/enable") return;
  const current = await getSessionFromCtx(ctx);
  if (!isOperatorRole(roleOf(current?.user))) {
    throw new APIError("FORBIDDEN", {
      message: "Two-factor authentication is only available for staff.",
      code: "TWO_FACTOR_OPERATORS_ONLY",
    });
  }
}

/**
 * `hooks.before`: a trusted device would let a stolen password skip the
 * authenticator for 30 days, and operators may never remove their 2FA (recovery
 * is a backup code or an admin reset).
 */
export async function assertTwoFactorRequestPolicy(
  ctx: GenericEndpointContext,
): Promise<void> {
  if (
    (ctx.path === "/two-factor/verify-totp" ||
      ctx.path === "/two-factor/verify-backup-code") &&
    ctx.body?.trustDevice
  ) {
    throw new APIError("BAD_REQUEST", {
      message: "Trusted devices are not available.",
      code: "TRUST_DEVICE_DISABLED",
    });
  }
  // With a live session the plugin skips its lockout counters, so over HTTP a
  // session may only verify a code to finish enrolment. Step-up goes through
  // /api/user/reauthenticate, which counts failures (a server call, no request).
  if (
    ctx.request &&
    (ctx.path === "/two-factor/verify-totp" ||
      ctx.path === "/two-factor/verify-backup-code")
  ) {
    const holder = await getSessionFromCtx(ctx);
    const enrolled = authUserFields.safeParse(holder?.user);
    if (
      holder &&
      (ctx.path === "/two-factor/verify-backup-code" ||
        (enrolled.success && enrolled.data.twoFactorEnabled === true))
    ) {
      throw new APIError("FORBIDDEN", {
        message: "This session has already passed two-factor authentication.",
        code: "TWO_FACTOR_ALREADY_VERIFIED",
      });
    }
  }
  if (ctx.path !== "/two-factor/disable") return;
  const current = await getSessionFromCtx(ctx);
  if (isOperatorRole(roleOf(current?.user))) {
    throw new APIError("FORBIDDEN", {
      message: "Two-factor authentication is required for staff.",
      code: "TWO_FACTOR_REQUIRED",
    });
  }
}

/**
 * True when a user-row update on this path is TOTP enrolment: on
 * /two-factor/verify-totp the plugin updates the user only to flip
 * `twoFactorEnabled` on. Sessions opened before that with the password alone
 * must then end, or they would inherit the second factor.
 */
export function isTwoFactorEnrolment(
  user: Record<string, unknown>,
  path: string | undefined,
): boolean {
  return path === "/two-factor/verify-totp" && user.twoFactorEnabled === true;
}

/** Lowercase, without the confusable 0/o, 1/l/i. */
const BACKUP_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Ten `xxxxx-xxxxx` backup codes drawn from {@link BACKUP_CODE_ALPHABET}. */
export function generateBackupCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const chars = Array.from(
      { length: 10 },
      () => BACKUP_CODE_ALPHABET[randomInt(BACKUP_CODE_ALPHABET.length)],
    ).join("");
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

import { APIError, getSessionFromCtx } from "better-auth/api";
import type { GenericEndpointContext } from "better-auth";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";

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
  if (!isOperatorRole((current?.user as { role?: string } | undefined)?.role)) {
    throw new APIError("FORBIDDEN", {
      message: "Two-factor authentication is only available for staff.",
      code: "TWO_FACTOR_OPERATORS_ONLY",
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

import { APIError, getSessionFromCtx } from "better-auth/api";
import type { GenericEndpointContext } from "better-auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { EXPECTED_USER_HEADER } from "@/lib/auth/identity-header";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";

/** A session counts as freshly authenticated for this long. */
export const STEP_UP_WINDOW_MS = 15 * 60 * 1000;

export const REAUTH_REQUIRED = "REAUTH_REQUIRED";

const REAUTH_MESSAGE = "Confirm it's you to continue.";

type SessionTimes = {
  createdAt: Date | string;
  reauthenticatedAt?: Date | string | null;
};

/** True when the session was opened or re-authenticated within the window. */
export function isFreshSession(
  session: SessionTimes,
  windowMs = STEP_UP_WINDOW_MS,
  now = Date.now(),
): boolean {
  const last = Math.max(
    new Date(session.createdAt).getTime(),
    session.reauthenticatedAt
      ? new Date(session.reauthenticatedAt).getTime()
      : 0,
  );
  return now - last < windowMs;
}

/** Route guard: null when fresh, else the typed 403 the client re-auth dialog keys on. */
export function requireFreshSession(
  auth: { session: SessionTimes },
  windowMs = STEP_UP_WINDOW_MS,
): NextResponse | null {
  if (isFreshSession(auth.session, windowMs)) return null;
  return NextResponse.json(
    { error: REAUTH_MESSAGE, code: REAUTH_REQUIRED },
    { status: 403 },
  );
}

/** The additional user fields the auth policies read off a BetterAuth session. */
export const authUserFields = z.object({
  role: z.string().nullish(),
  twoFactorEnabled: z.boolean().nullish(),
});

const STEP_UP_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
  "/change-password",
  "/change-email",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
]);

const ENROLLED_OPERATOR_PATHS: ReadonlySet<string> = new Set([
  "/change-password",
  "/change-email",
  "/update-user",
]);

/**
 * `hooks.before`: an unenrolled operator holds only the password, so it may not
 * change credentials or profile; credential and factor changes need a fresh session.
 */
export async function assertSensitiveAuthAction(
  ctx: GenericEndpointContext,
): Promise<void> {
  const path = ctx.path ?? "";
  if (!STEP_UP_AUTH_PATHS.has(path) && !ENROLLED_OPERATOR_PATHS.has(path)) {
    return;
  }
  const current = await getSessionFromCtx(ctx);
  if (!current) return;
  // A tab rendered for another account must not change this one's credentials.
  const expected = ctx.request?.headers.get(EXPECTED_USER_HEADER);
  if (expected && expected !== current.user.id) {
    throw new APIError("CONFLICT", {
      message: "You are signed in as a different account in this browser.",
      code: "IDENTITY_CHANGED",
    });
  }
  const user = authUserFields.parse(current.user);
  if (
    ENROLLED_OPERATOR_PATHS.has(path) &&
    isOperatorRole(user.role) &&
    user.twoFactorEnabled !== true
  ) {
    throw new APIError("FORBIDDEN", {
      message: "Set up two-factor authentication first.",
      code: "TWO_FACTOR_REQUIRED",
    });
  }
  if (STEP_UP_AUTH_PATHS.has(path) && !isFreshSession(current.session)) {
    throw new APIError("FORBIDDEN", {
      message: REAUTH_MESSAGE,
      code: REAUTH_REQUIRED,
    });
  }
}

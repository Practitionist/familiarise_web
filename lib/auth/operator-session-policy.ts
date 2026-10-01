/**
 * Which BetterAuth endpoints may mint a session for a platform operator
 * (STAFF or ADMIN). Operators sign in with a password and an authenticator
 * code, nothing else.
 *
 * The twoFactor plugin only challenges the credential sign-in: a Google,
 * GitHub or SSO callback creates a full session with no second factor. So the
 * rule is an allowlist checked in `databaseHooks.session.create.before`
 * (lib/auth.ts), and any path not named here, including a future plugin's,
 * is refused for an operator.
 *
 * - `/sign-in/email`: once 2FA is enrolled the plugin's after-hook deletes
 *   this session and answers `twoFactorRedirect` instead. Before enrolment the
 *   session is real, but the API and page guards confine it to
 *   /auth/two-factor/setup.
 * - `/two-factor/verify-totp`, `/two-factor/verify-backup-code`: the session
 *   that completes a challenge, and the re-issue when enrolment is confirmed.
 * - `/change-password`: re-issues the caller's existing session
 *   (`revokeOtherSessions`), which already passed both factors.
 */
const OPERATOR_SESSION_PATHS: ReadonlySet<string> = new Set([
  "/sign-in/email",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/change-password",
]);

export function isOperatorRole(role: string | null | undefined): boolean {
  return role === "ADMIN" || role === "STAFF";
}

/** True when an operator session must not be created on `path`. */
export function refusesOperatorSession(
  role: string | null | undefined,
  path: string | null | undefined,
): boolean {
  if (!isOperatorRole(role)) return false;
  // No endpoint context means an internal call we cannot attribute; refuse.
  return !path || !OPERATOR_SESSION_PATHS.has(path);
}

/**
 * An operator session lives at most 12 hours from sign-in, however active it
 * is. The consumer settings (30-day expiry, daily sliding refresh) would
 * otherwise keep a stolen operator cookie alive for as long as it is used.
 */
export const OPERATOR_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** `expiresAt`, pulled back to `createdAt` + 12h if it lands later. */
export function capOperatorExpiry(createdAt: Date, expiresAt: Date): Date {
  const cap = new Date(createdAt.getTime() + OPERATOR_SESSION_MAX_AGE_MS);
  return expiresAt > cap ? cap : expiresAt;
}

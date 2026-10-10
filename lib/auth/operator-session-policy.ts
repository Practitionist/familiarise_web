/**
 * Which BetterAuth endpoints may mint a session for a platform operator
 * (STAFF or ADMIN). Operators sign in with a password and an authenticator
 * code, or with a user-verified passkey.
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
 * - `/passkey/verify-authentication`: a user-verified passkey, which only an
 *   enrolled operator can hold (lib/auth/passkey-policy.ts).
 */
const OPERATOR_SESSION_PATHS: ReadonlySet<string> = new Set([
  "/sign-in/email",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/change-password",
  "/passkey/verify-authentication",
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
 * True when `providerId` must not be linked to an operator. A social or SSO
 * account would be a second way in that the session gate has to keep
 * refusing; `account.create.before` (lib/auth.ts) stops it being made.
 */
export function refusesOperatorAccount(
  role: string | null | undefined,
  providerId: string,
): boolean {
  return isOperatorRole(role) && providerId !== "credential";
}

import { isOperatorRole } from "@/lib/auth/operator-session-policy";

/**
 * Session lifetime policy, applied by the session create/update database
 * hooks in lib/auth.ts. Consumers keep BetterAuth's 30-day sliding session;
 * every other class has an absolute cap measured from the original
 * authentication, which the hooks carry in `Session.createdAt`.
 *
 * A capped row always expires within BetterAuth's refresh window, so every
 * read of it refreshes the row. That write is what makes `updatedAt` the
 * operator's last activity, and `refreshSessionLifetime` runs on it.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Enrolled operator: 12 hours from sign-in, however active. */
export const OPERATOR_SESSION_MAX_AGE_MS = 12 * HOUR_MS;
/** Operator who has not enrolled 2FA yet: long enough to enrol, no more. */
export const UNENROLLED_OPERATOR_SESSION_MAX_AGE_MS = 1 * HOUR_MS;
/** SSO sign-in for an org-enforced domain: IdP deprovisioning lands within a day. */
export const SSO_SESSION_MAX_AGE_MS = 24 * HOUR_MS;
/** An operator session unused for this long ends. */
export const OPERATOR_IDLE_TIMEOUT_MS = 2 * HOUR_MS;

/**
 * Paths that replace the caller's live session with a new row: password
 * change (`revokeOtherSessions`) and the re-issue when 2FA enrolment is
 * confirmed. The new row keeps the replaced row's authentication time.
 */
const ROTATION_PATHS: ReadonlySet<string> = new Set([
  "/change-password",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

export type LifetimeUser = {
  role?: string | null;
  twoFactorEnabled?: boolean | null;
};

/** The absolute cap for a new session, or null for the consumer default. */
export function sessionMaxAgeMs(
  user: LifetimeUser | null | undefined,
  { ssoEnforced }: { ssoEnforced: boolean },
): number | null {
  if (isOperatorRole(user?.role)) {
    return user?.twoFactorEnabled === true
      ? OPERATOR_SESSION_MAX_AGE_MS
      : UNENROLLED_OPERATOR_SESSION_MAX_AGE_MS;
  }
  return ssoEnforced ? SSO_SESSION_MAX_AGE_MS : null;
}

type PreviousSession = { userId: string; createdAt: Date | string };

/**
 * When the new session's user last authenticated. A rotation of the caller's
 * own session keeps the replaced row's `createdAt`; anything else is now.
 */
export function authenticationStart(
  path: string | null | undefined,
  userId: string,
  previous: PreviousSession | null | undefined,
  now: Date,
): Date {
  if (!path || !ROTATION_PATHS.has(path) || previous?.userId !== userId) {
    return now;
  }
  const start = new Date(previous.createdAt);
  return start < now ? start : now;
}

/**
 * The fields `session.create.before` writes for a capped session: the
 * authentication time as `createdAt` and an expiry inside the cap.
 */
export function cappedSessionFields(
  expiresAt: Date,
  authStart: Date,
  maxAgeMs: number,
): { createdAt: Date; expiresAt: Date } {
  const cap = new Date(authStart.getTime() + maxAgeMs);
  return { createdAt: authStart, expiresAt: expiresAt > cap ? cap : expiresAt };
}

export type RefreshDecision =
  { kind: "end" } | { kind: "keep"; expiresAt?: Date };

type CurrentSession = {
  createdAt: Date | string;
  updatedAt: Date | string;
  expiresAt: Date | string;
};

/**
 * `session.update.before` on a sliding refresh. `end` means the session is
 * over (cap passed or operator idle); `keep` carries a clamped expiry only
 * when the refresh would otherwise push it past the cap.
 *
 * A non-operator row that was created capped (lifetime within the SSO cap)
 * stays capped: the class is read from the row so the refresh needs no query.
 */
export function refreshSessionLifetime(
  user: LifetimeUser,
  current: CurrentSession,
  nextExpiresAt: Date,
  now: Date,
): RefreshDecision {
  const createdAt = new Date(current.createdAt).getTime();
  let maxAgeMs: number | null;
  if (isOperatorRole(user.role)) {
    const idleMs = now.getTime() - new Date(current.updatedAt).getTime();
    if (idleMs >= OPERATOR_IDLE_TIMEOUT_MS) return { kind: "end" };
    maxAgeMs = sessionMaxAgeMs(user, { ssoEnforced: false });
  } else {
    const lifetimeMs = new Date(current.expiresAt).getTime() - createdAt;
    maxAgeMs =
      lifetimeMs <= SSO_SESSION_MAX_AGE_MS ? SSO_SESSION_MAX_AGE_MS : null;
  }
  if (maxAgeMs === null) return { kind: "keep" };
  const cap = createdAt + maxAgeMs;
  if (now.getTime() >= cap) return { kind: "end" };
  return nextExpiresAt.getTime() > cap
    ? { kind: "keep", expiresAt: new Date(cap) }
    : { kind: "keep" };
}

import { type PrismaLike } from "@/lib/prisma";
import redis from "@/lib/redis";
import { captureThrottled } from "@/lib/observability/throttled-capture";

/**
 * The single choke point for ending auth sessions (#1856).
 *
 * Three callers, one function each — ban/suspend (`lib/moderation/
 * side-effects.ts`), staff support (`app/api/admin/users/...`), and the
 * user-facing device routes (`app/api/user/sessions/...`) all end
 * sessions here instead of inlining `session.deleteMany`. That keeps the
 * ownership predicate, the idempotency shape and the revocation signal
 * in one reviewed place.
 *
 * Why Prisma and not BetterAuth's admin plugin (`auth.api.
 * revokeUserSessions`), even though the plugin IS installed: the plugin
 * endpoint is caller-scoped — it runs `adminMiddleware` + a
 * `session:["revoke"]` permission check against the CALLING admin's
 * session. A system-initiated revoke (moderation tx, erasure, the cap)
 * has no caller session and runs inside a transaction the plugin cannot
 * join. Direct deletes are the correct primitive there; the plugin
 * endpoints stay for interactive admin-UI use. (This corrects the
 * "no server-side revoke available" reasoning in ADR 10 and
 * `02-jit-and-session-refresh.md` — the conclusion stood, the reason
 * did not.)
 */

export interface RevokeResult {
  /** Sessions rows actually removed. */
  revoked: number;
}

/**
 * End every session for a user. System-initiated (ban, erasure, staff
 * escalation): no caller session required, transaction-safe — pass the
 * ambient `tx` and the deletes join it atomically with the ban flags.
 */
export async function revokeAllUserSessions(
  db: PrismaLike,
  userId: string,
): Promise<RevokeResult> {
  const { count } = await db.session.deleteMany({ where: { userId } });
  return { revoked: count };
}

/**
 * End every session for a user except one. Powers "log out everywhere
 * else" and the post-password-change sweep: the current session survives
 * so the user is not signed out of the device they are holding.
 */
export async function revokeUserSessionsExcept(
  db: PrismaLike,
  userId: string,
  keepSessionId: string,
): Promise<RevokeResult> {
  const { count } = await db.session.deleteMany({
    where: { userId, id: { not: keepSessionId } },
  });
  return { revoked: count };
}

/**
 * End one session by its row id. The `userId` in the `where` clause IS
 * the ownership proof: a foreign id matches zero rows and revokes
 * nothing, so callers never need a separate read-then-check. Uses
 * `deleteMany` (not `delete`) so a concurrent second revoke of the
 * same row is a 0-count success, not a P2025 throw — revocation is
 * idempotent by construction.
 */
export async function revokeSessionById(
  db: PrismaLike,
  userId: string,
  sessionId: string,
): Promise<RevokeResult> {
  const { count } = await db.session.deleteMany({
    where: { id: sessionId, userId },
  });
  return { revoked: count };
}

/**
 * Cross-device revocation signal (#1856).
 *
 * BroadcastChannel reaches same-browser tabs only. For a phone left
 * open on a screen, the revoking server bumps a per-user counter in
 * Upstash (`sess:revsig:{userId}`, 24h TTL); visible tabs poll
 * `GET /api/user/sessions/revocation-signal` and run an authoritative
 * re-check when the counter moves. Best-effort throughout: a Redis
 * blip must never fail a revoke, so failures are throttled-reported
 * and swallowed. Polling itself ships DISABLED
 * (`SESSION_REVOCATION_POLL_MS=0`) — the focus-based authoritative
 * check covers revocation within one tab-switch, and the poll is
 * opt-in traffic until scale says otherwise.
 */
const REVOCATION_SIGNAL_TTL_SECONDS = 24 * 60 * 60;

export function revocationSignalKey(userId: string): string {
  return `sess:revsig:${userId}`;
}

export async function signalRevocation(userId: string): Promise<void> {
  try {
    const key = revocationSignalKey(userId);
    await redis.incr(key);
    // pexpire, not expire: the MockRedis half of the RedisClient union
    // only implements the ms variant.
    await redis.pexpire(key, REVOCATION_SIGNAL_TTL_SECONDS * 1000);
  } catch (error) {
    captureThrottled("session:signalRevocation", error, {
      subsystem: "auth",
      op: "signalRevocation",
      expected: true,
      level: "warning",
    });
  }
}

export async function readRevocationSignal(
  userId: string,
): Promise<number | null> {
  try {
    const value = await redis.get<number | string>(revocationSignalKey(userId));
    if (value === null || value === undefined) return 0;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  } catch {
    // Fail-open: an unreadable signal is not a revocation. The
    // focus-based authoritative check remains the source of truth.
    return null;
  }
}

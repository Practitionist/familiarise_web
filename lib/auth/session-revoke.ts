import { type PrismaLike } from "@/lib/prisma";

/**
 * The single choke point for ending auth sessions (#1856).
 *
 * Three callers, one function each — ban/suspend (`lib/moderation/
 * side-effects.ts`), staff support (`app/api/admin/users/...`), and the
 * user-facing device routes (`app/api/user/sessions/...`) all end
 * sessions here instead of inlining `session.deleteMany`. That keeps the
 * ownership predicate and the idempotency shape in one reviewed place.
 *
 * Why Prisma and not BetterAuth's admin plugin (`auth.api.
 * revokeUserSessions`), even though the plugin IS installed: the plugin
 * endpoint is caller-scoped — it runs `adminMiddleware` + a
 * `session:["revoke"]` permission check against the CALLING admin's
 * session. A system-initiated revoke (moderation tx, erasure)
 * has no caller session and runs inside a transaction the plugin cannot
 * join, so direct deletes are the correct primitive.
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
 * else": the current session survives so the user is not signed out of
 * the device they are holding. (Password change does its own sweep via
 * BetterAuth's `revokeOtherSessions`.)
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

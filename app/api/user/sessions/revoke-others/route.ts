import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, sessionMgmtUserLimiter } from "@/lib/rate-limit";
import { sessionRouteError } from "@/lib/auth/session-response";
import { revokeUserSessionsExcept } from "@/lib/auth/session-revoke";

/**
 * POST /api/user/sessions/revoke-others — end every session except the
 * caller's (#1856). Own route rather than `authClient.
 * revokeOtherSessions()` so every revoke goes through
 * `lib/auth/session-revoke.ts`. Powers the device list's "sign out other
 * devices".
 */
export async function POST() {
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;

    const userId = auth.session.user.id;

    const limited = await applyRateLimit(
      sessionMgmtUserLimiter,
      `session-mgmt-user:${userId}`,
    );
    if (limited) return limited;

    const { revoked } = await revokeUserSessionsExcept(
      prisma,
      userId,
      auth.session.session.id,
    );

    return NextResponse.json({ revoked }, { status: 200 });
  } catch (error) {
    return sessionRouteError(
      "We couldn't end your other sessions. Please try again.",
      error,
    );
  }
}

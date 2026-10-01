import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, sessionMgmtUserLimiter } from "@/lib/rate-limit";
import { sessionRouteError } from "@/lib/auth/session-response";
import { revokeSessionById } from "@/lib/auth/session-revoke";

interface RouteParams {
  params: Promise<{ sessionId: string }>;
}

/**
 * DELETE /api/user/sessions/[sessionId] — end one session (#1856).
 *
 * Idempotent by construction: a foreign, expired or already-revoked id
 * matches zero rows and answers 200 `{ revoked: 0 }` — never 404 (which
 * would leak row existence across users), never a throw on a
 * double-click race. Revoking your own current session is allowed and
 * reported as `currentSessionEnded` so the client signs out cleanly
 * instead of 401-ing on its next request.
 */
export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;

    const { sessionId } = await params;
    if (!sessionId || typeof sessionId !== "string") {
      return NextResponse.json({ error: "Invalid session" }, { status: 400 });
    }

    const userId = auth.session.user.id;
    const currentSessionId = auth.session.session.id;

    const limited = await applyRateLimit(
      sessionMgmtUserLimiter,
      `session-mgmt-user:${userId}`,
    );
    if (limited) return limited;

    const { revoked } = await revokeSessionById(prisma, userId, sessionId);
    const currentSessionEnded = sessionId === currentSessionId;

    return NextResponse.json({ revoked, currentSessionEnded }, { status: 200 });
  } catch (error) {
    return sessionRouteError(
      "We couldn't end that session. Please try again.",
      error,
    );
  }
}

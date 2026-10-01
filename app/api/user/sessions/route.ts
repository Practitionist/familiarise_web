import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, sessionMgmtUserLimiter } from "@/lib/rate-limit";
import { sessionRouteError } from "@/lib/auth/session-response";
import {
  SESSION_PUBLIC_SELECT,
  toPublicSession,
} from "@/lib/auth/session-select";

/**
 * GET /api/user/sessions — the caller's active sessions for the
 * "where you're signed in" list (#1856).
 *
 * Reads through SESSION_PUBLIC_SELECT, never through BetterAuth's
 * `listSessions` (which returns the raw session token per device in
 * 1.6.5 and 1.7.6). Only unexpired rows, newest first, bounded.
 */
const MAX_LISTED_SESSIONS = 25;

export async function GET() {
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;

    // Per-user bucket (the precise gate; the edge IP rule is coarse
    // friction for NAT-shared offices).
    const limited = await applyRateLimit(
      sessionMgmtUserLimiter,
      `session-mgmt-user:${auth.session.user.id}`,
    );
    if (limited) return limited;

    const rows = await prisma.session.findMany({
      where: {
        userId: auth.session.user.id,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_LISTED_SESSIONS,
      select: SESSION_PUBLIC_SELECT,
    });

    const currentSessionId = auth.session.session.id;
    return NextResponse.json(
      {
        sessions: rows.map((row) => toPublicSession(row, currentSessionId)),
      },
      { status: 200 },
    );
  } catch (error) {
    return sessionRouteError(
      "We couldn't load your sessions. Please try again.",
      error,
    );
  }
}

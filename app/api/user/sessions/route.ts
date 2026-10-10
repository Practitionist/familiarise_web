import { NextResponse, type NextRequest } from "next/server";
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
 * "where you're signed in" list, newest first, one page at a time.
 *
 * Reads through SESSION_PUBLIC_SELECT, never through BetterAuth's
 * `listSessions` (which returns the raw session token per device).
 * `?cursor=<session id>` continues after that row; `total` counts every
 * active session so the list can say how many remain.
 */
const PAGE_SIZE = 25;

export async function GET(req: NextRequest) {
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

    const cursor = req.nextUrl.searchParams.get("cursor") || undefined;
    const where = {
      userId: auth.session.user.id,
      expiresAt: { gt: new Date() },
    };
    const [rows, total] = await Promise.all([
      prisma.session.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: PAGE_SIZE + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: SESSION_PUBLIC_SELECT,
      }),
      prisma.session.count({ where }),
    ]);

    const page = rows.slice(0, PAGE_SIZE);
    const currentSessionId = auth.session.session.id;
    return NextResponse.json(
      {
        sessions: page.map((row) => toPublicSession(row, currentSessionId)),
        total,
        nextCursor: rows.length > PAGE_SIZE ? page[page.length - 1].id : null,
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

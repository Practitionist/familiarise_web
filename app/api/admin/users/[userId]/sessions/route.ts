import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { applyRateLimit, adminSessionAccessLimiter } from "@/lib/rate-limit";
import { sessionRouteError } from "@/lib/auth/session-response";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import {
  SESSION_PUBLIC_SELECT,
  toPublicSession,
} from "@/lib/auth/session-select";

interface RouteParams {
  params: Promise<{ userId: string }>;
}

/**
 * GET /api/admin/users/[userId]/sessions — support visibility into a
 * user's signed-in devices (#1856, ADR 35).
 *
 * `users.read` (OPERATORS): staff resolving "is someone else in my
 * account?" tickets can SEE the device list. Ending sessions is the
 * higher grant — see the `users.moderate` revoke door next to this
 * file. Same select allowlist as the user's own list: a session token
 * never leaves the server, for staff as for users.
 *
 * This READ is audited and rate limited; the POST already was. That
 * asymmetry was a review finding: `withOpsAction` cannot wrap a GET
 * (it parses `req.json()`), so the trail is a `SystemEvent` at WARN —
 * the same sink, and the same severity, that
 * `lib/stream/recording-operator-access.ts` uses when a privileged
 * read reaches into a session. The doctrine is
 * `docs/stream/13-recording-webhooks.md:880`: "a read that cannot be
 * audited is not served". Device IPs and login history are a stronger
 * prize than a recording URL, so an unaccountable read of them is a
 * larger hole. The repo already audits a mere read of a personal
 * dashboard the same way — `app/api/admin/users/[userId]/
 * view-dashboard/route.ts`, same `users.read` surface.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const auth = await requireBackofficeSurface("users.read");
    if (auth.error) return auth.error;

    // Per-operator budget, past the surface check so the caller is known.
    // 120/15m is generous for resolving one ticket and bounded for a
    // walk across the user directory.
    const limited = await applyRateLimit(
      adminSessionAccessLimiter,
      `admin-session-read:${auth.session.user.id}`,
    );
    if (limited) return limited;

    const { userId } = await params;
    if (!userId || typeof userId !== "string") {
      return NextResponse.json({ error: "Invalid user" }, { status: 400 });
    }

    const rows = await prisma.session.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: SESSION_PUBLIC_SELECT,
    });

    // Best-effort by its own contract (it try/catches internally, so a
    // failure here must not deny the operator the answer they asked
    // for), but written BEFORE the response is built so the trail
    // cannot lag the access it describes. `context` records the fact
    // and shape of the read — never an IP or a user agent.
    await recordSystemEvent({
      category: "AUTH_SESSION_STAFF_READ",
      severity: "WARN",
      message: "Back-office read of another user's auth sessions",
      context: {
        actorUserId: auth.session.user.id,
        actorRole: auth.session.user.role,
        targetUserId: userId,
        sessionCount: rows.length,
        surface: "users.read",
      },
    });

    // No `isCurrent` here: "current" is meaningless for an operator
    // looking at someone else's sessions.
    return NextResponse.json(
      { sessions: rows.map((row) => toPublicSession(row)) },
      { status: 200 },
    );
  } catch (error) {
    return sessionRouteError(
      "We couldn't load those sessions. Please try again.",
      error,
    );
  }
}

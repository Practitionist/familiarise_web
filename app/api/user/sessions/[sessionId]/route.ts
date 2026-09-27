import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { revokeSessionById, signalRevocation } from "@/lib/auth/session-revoke";

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

    const { revoked } = await revokeSessionById(prisma, userId, sessionId);
    const currentSessionEnded = sessionId === currentSessionId;
    if (revoked > 0) {
      // Best-effort cross-device ping; never gates the response.
      // Skipped when nothing was removed — no peer needs waking.
      // Skipped for the current session — the revoking tab IS the
      // revoked tab and signs itself out off the response flag.
      if (!currentSessionEnded) await signalRevocation(userId);
    }

    return NextResponse.json({ revoked, currentSessionEnded }, { status: 200 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    return NextResponse.json(
      { error: "We couldn't end that session. Please try again." },
      { status: 500 },
    );
  }
}

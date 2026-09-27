import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
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
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const auth = await requireBackofficeSurface("users.read");
    if (auth.error) return auth.error;

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

    // No `isCurrent` here: "current" is meaningless for an operator
    // looking at someone else's sessions.
    return NextResponse.json(
      { sessions: rows.map((row) => toPublicSession(row)) },
      { status: 200 },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    return NextResponse.json(
      { error: "We couldn't load those sessions. Please try again." },
      { status: 500 },
    );
  }
}

import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import {
  revokeUserSessionsExcept,
  signalRevocation,
} from "@/lib/auth/session-revoke";

/**
 * POST /api/user/sessions/revoke-others — end every session except the
 * caller's (#1856). Own route rather than `authClient.
 * revokeOtherSessions()` so the revoke, the audit-shaped response and
 * the cross-device signal share one choke point. Powers the device
 * list's "sign out other devices" and the post-password-change sweep.
 */
export async function POST() {
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;

    const userId = auth.session.user.id;
    const { revoked } = await revokeUserSessionsExcept(
      prisma,
      userId,
      auth.session.session.id,
    );
    if (revoked > 0) await signalRevocation(userId);

    return NextResponse.json({ revoked }, { status: 200 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    return NextResponse.json(
      { error: "We couldn't end your other sessions. Please try again." },
      { status: 500 },
    );
  }
}

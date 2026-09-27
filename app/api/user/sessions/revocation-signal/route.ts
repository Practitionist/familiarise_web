import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth-helpers";
import { readRevocationSignal } from "@/lib/auth/session-revoke";

/**
 * GET /api/user/sessions/revocation-signal — the cross-device poll
 * endpoint (#1856).
 *
 * Returns the per-user revocation counter (`sess:revsig:{userId}`,
 * bumped on every revoke). Visible tabs compare it against their
 * `sessionStorage` cursor; a move means "something was revoked" and
 * triggers an authoritative re-check. `signal: null` means the counter
 * was unreadable (Redis blip) — fail-open, NOT a revocation; the
 * focus-based authoritative check remains the source of truth.
 *
 * Ships DISABLED (`SESSION_REVOCATION_POLL_MS=0` default): the client
 * only polls when the env opts in.
 */
export async function GET() {
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;

    const signal = await readRevocationSignal(auth.session.user.id);
    return NextResponse.json({ signal }, { status: 200 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    return NextResponse.json({ signal: null }, { status: 200 });
  }
}

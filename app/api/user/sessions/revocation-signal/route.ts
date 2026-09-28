import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth-helpers";
import { applyRateLimit, revocationSignalUserLimiter } from "@/lib/rate-limit";
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
 *
 * Rate limited per user, and NOT at the edge on purpose. The
 * `middleware.ts` exemption is correct — a 30s poll is exactly 30
 * requests per 15-minute window, so an edge limiter would 429 the
 * device list for two tabs behind one NAT — but it meant this
 * endpoint's only limit lived in a `startsWith` negation in a
 * different file, invisible from here and gone the moment that
 * predicate is edited. The per-user budget below (30/15m, exactly one
 * documented poll) makes the guarantee structural instead of
 * incidental, and still refuses a 15s poll.
 *
 * Deliberately not capped by the edge `sessionMgmtLimiter`, and not
 * silently fail-open: `applyRateLimit` already fails open on a Redis
 * fault, which is the right behaviour for a freshness hint — losing the
 * limiter costs a stale tab, not a wrong sign-out.
 */
export async function GET() {
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;

    const limited = await applyRateLimit(
      revocationSignalUserLimiter,
      `revocation-signal:${auth.session.user.id}`,
    );
    if (limited) return limited;

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

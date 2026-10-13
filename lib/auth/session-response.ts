import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

/**
 * The one 500 shape for the session/device routes (#1856).
 *
 * Four routes shared an identical catch (capture + friendly message);
 * a fifth copy is how the next error-copy change gets applied in three
 * places and missed in two. Callers pass their route's sentence —
 * the envelope never varies, so clients can rely on it.
 */
export function sessionRouteError(
  message: string,
  error: unknown,
): NextResponse {
  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    { tags: { subsystem: "auth" } },
  );
  return NextResponse.json({ error: message }, { status: 500 });
}

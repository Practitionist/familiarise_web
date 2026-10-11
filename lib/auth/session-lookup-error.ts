import { NextResponse } from "next/server";
import { markExpected } from "@/lib/observability/expected";
import { Refusal } from "@/lib/errors/refusal";

/** Seconds a client waits before retrying a failed session lookup. */
export const SESSION_LOOKUP_RETRY_AFTER_SECONDS = 2;

const LOOKUP_FAILED_MESSAGE =
  "We couldn't confirm your session just now. Try again in a moment.";

/**
 * The session lookup could not complete (a database fault or cold-start
 * stall on a validly signed cookie). It is a 503 refusal: `apiError` answers
 * it with 503 + Retry-After, and page error boundaries retry, never sign out.
 * Marked expected at construction so it never pages as a fault.
 */
export class SessionLookupFailedError extends Refusal {
  constructor(readonly cause: unknown) {
    super({
      code: "SESSION_LOOKUP_FAILED",
      httpStatus: 503,
      userMessage: LOOKUP_FAILED_MESSAGE,
      devMessage: "Session lookup failed",
    });
    this.name = "SessionLookupFailedError";
    markExpected(this);
  }
}

/** The 503 every session-lookup failure answers with; clients retry, never sign out. */
export function sessionLookupFailedResponse(): NextResponse {
  return NextResponse.json(
    { error: LOOKUP_FAILED_MESSAGE, code: "SESSION_LOOKUP_FAILED" },
    {
      status: 503,
      headers: {
        "Retry-After": String(SESSION_LOOKUP_RETRY_AFTER_SECONDS),
        "Cache-Control": "no-store",
      },
    },
  );
}

/**
 * Next's control-flow throws (DYNAMIC_SERVER_USAGE while prerendering,
 * NEXT_REDIRECT, NEXT_NOT_FOUND, BAILOUT_TO_CLIENT_SIDE_RENDERING) carry a
 * string `digest` and must reach the framework; a database fault carries none.
 */
export function isNextControlFlowError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof error.digest === "string"
  );
}

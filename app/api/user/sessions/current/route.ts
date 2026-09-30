import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth-helpers";

/**
 * GET /api/user/sessions/current — "is my session still alive?"
 *
 * The client's revocation check (`providers/AuthSyncProvider.tsx`) must be
 * able to tell three answers apart, and BetterAuth's `/get-session` cannot:
 * the customSession plugin catches every lookup failure and answers
 * `200 null`, which is indistinguishable from "revoked". Treating that as a
 * revocation turned a database blip into a fleet-wide sign-out.
 *
 * `requireApiAuth` already separates them, so this route only relays it:
 *   200 → active
 *   401 → no session (revoked, expired, signed out elsewhere)
 *   403 → account suspended
 *   503 → lookup failed; the client must retry, never sign out
 */
export async function GET() {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  return NextResponse.json(
    { active: true },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}

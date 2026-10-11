import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth-helpers";

/**
 * GET /api/user/sessions/current — "is my session still alive, and whose?"
 *
 * The client's revocation check (`providers/AuthSyncProvider.tsx`) must be
 * able to tell three answers apart, and BetterAuth's `/get-session` cannot:
 * the customSession plugin catches every lookup failure and answers
 * `200 null`, which is indistinguishable from "revoked". Treating that as a
 * revocation turned a database blip into a fleet-wide sign-out.
 *
 * `requireApiSession` already separates them, so this route only relays it.
 * Not `requireApiAuth`: an operator who has not enrolled 2FA yet still holds a
 * live session, and a 428 here would read as "unknown" on every focus.
 *   200 → active, with the user id (AuthSyncProvider reloads on a switch)
 *   401 → no session (revoked, expired, signed out elsewhere)
 *   403 → account suspended
 *   503 → lookup failed; the client must retry, never sign out
 */
export async function GET() {
  const auth = await requireApiSession();
  if (auth.error) return auth.error;
  return NextResponse.json(
    { active: true, userId: auth.session.user.id },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  isPrivileged,
  forbiddenResponse,
  requireApiAuth,
} from "@/lib/auth-helpers";

/**
 * POST /api/user/staff — REMOVED as a credential-setting surface (#1927).
 *
 * ## What it used to do, and why it is gone
 *
 * It took `{ email, password, name, phone, address, department, position }`
 * from an admin and wrote a User with `role: STAFF`, `emailVerified: true`
 * and a credential `Account` whose password was hashed inline with
 * `bcrypt.hash(password, 12)`. Four things were wrong with that, and they are
 * worth writing down because each looks harmless alone:
 *
 *  1. **The admin chose the password, and transmitted it.** Not over TLS to a
 *     colleague, but typed by one human into a form and retyped by another
 *     into a password manager. It landed in whatever the admin typed it into
 *     first, and it was never required to be unique to the platform. This is
 *     the same class of primitive as the `emailVerified` bug fixed in
 *     `app/api/user/staff/[id]/route.ts` — a path to an account that bypasses
 *     the identity proof the rest of the app insists on.
 *  2. **It bypassed BetterAuth.** `requireEmailVerification: true` in
 *     `lib/auth.ts` is the control that stops someone pre-registering a
 *     victim's address and hijacking it later through a trusted-provider
 *     login. This route wrote `emailVerified: true` outright, and wrote a
 *     second, unwatched copy of the hash algorithm — the exact hazard
 *     `hashStaffPassword` in `lib/auth/staff-invitations.ts` now prevents.
 *  3. **It was unaudited.** No `OpsActionLog` row, so "who granted this person
 *     platform access" had no answer, and `lib/auth/backoffice-permissions.ts`
 *     states the reason `users.moderate` is admin-only.
 *  4. **It was a second write site.** With it live, the single-door
 *     guarantee the Team page depends on — every privileged role grant
 *     produces one OpsActionLog row — was false.
 *
 * ## Why a refusal and not a silent delegation
 *
 * The alternative was to keep the route and have it mint an invitation. That
 * would keep any not-yet-found caller (a Postman collection — this repo has
 * one, see `npm run scripts:update-postman`) working. It was rejected because
 * the response could not keep its shape: the old contract is "here is the User
 * you created, with its profile", and an invitation has no User, so every
 * caller would have to change anyway while being told nothing had changed. A
 * loud 410 with the replacement path is strictly better than a 201 whose body
 * is a different shape: the first finds every stale caller immediately and
 * points at the fix, the second finds them in production.
 *
 * GET below is unchanged and still works — the Team page is the better roster,
 * but this endpoint has callers in `lib/user.ts` and removing it is a separate
 * decision.
 */
export async function POST(_request: NextRequest) {
  return NextResponse.json(
    {
      message:
        "Staff accounts can no longer be created with an admin-chosen password. Invite them instead — they choose their own password and the action is audited.",
      code: "USE_STAFF_INVITATION",
      replacement: "POST /api/admin/staff-invitations",
    },
    { status: 410 },
  );
}

// GET /api/user/staff - Get all staff members (ADMIN/STAFF only)
export async function GET(_request: NextRequest) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    // Only ADMIN/STAFF can list staff members
    if (!isPrivileged(session.user.role)) {
      return forbiddenResponse(
        "Only administrators and staff can view staff members",
      );
    }

    const staffUsers = await prisma.user.findMany({
      where: {
        role: "STAFF",
      },
      include: {
        staffProfile: true, // Include related staff profile data
      },
    });

    return NextResponse.json(staffUsers);
  } catch (error) {
    console.error("Failed to fetch staff users:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    return NextResponse.json(
      { message: "Internal Server Error fetching staff" },
      { status: 500 },
    );
  }
}

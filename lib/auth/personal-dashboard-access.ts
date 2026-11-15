/**
 * Server-side ownership guard for the personal dashboard trees.
 *
 * The consultee and consultant layouts decide ownership in a client effect,
 * after the server has rendered, and `middleware.ts` only checks that a
 * session cookie is present. So every server page under
 * `/dashboard/consultee/[id]` or `/dashboard/consultant/[id]` that reads by the
 * URL id calls this first: the owner, or an ADMIN / STAFF inspecting someone
 * else's profile, passes; anyone else is redirected before any read runs.
 *
 * It is a page guard, not a route guard: it `redirect()`s rather than returning
 * a `NextResponse`, which is why it lives here and not in `lib/auth-helpers.ts`.
 */

import { redirect } from "next/navigation";

import { isOperatorRole } from "@/lib/auth/operator-session-policy";
import { getSession } from "@/lib/auth-server";

export type PersonalProfileKind = "consultee" | "consultant";

export interface PersonalProfileAccess {
  userId: string;
  /** True when an ADMIN or STAFF is inspecting a profile they do not own. */
  isInspecting: boolean;
}

/**
 * Assert the session user may view this personal dashboard profile.
 *
 * Call it FIRST in any server component under `/dashboard/consultee/[id]` or
 * `/dashboard/consultant/[id]` that reads data keyed on the URL id — before
 * the prefetch, so an unauthorized request never reaches the query.
 */
export async function requirePersonalProfileAccess(
  kind: PersonalProfileKind,
  profileId: string,
): Promise<PersonalProfileAccess> {
  const session = await getSession();
  if (!session?.user?.id) redirect("/auth/signin");

  // The session user is the live row (the session cookie cache is off), so
  // role, ban state and profile ids need no second read.
  if (session.user.banned === true) redirect("/auth/signin");

  const { role, consulteeProfileId, consultantProfileId } = session.user;
  const owned = kind === "consultee" ? consulteeProfileId : consultantProfileId;

  if (owned === profileId) {
    return { userId: session.user.id, isInspecting: false };
  }
  if (isOperatorRole(role)) {
    return { userId: session.user.id, isInspecting: true };
  }

  // Back to the capability router rather than guessing which dashboard they
  // belong on — a user may hold both profiles, or neither.
  redirect("/dashboard");
}

/** Whether the signed-in viewer owns this profile; never redirects, for page metadata. */
export async function viewerOwnsPersonalProfile(
  kind: PersonalProfileKind,
  profileId: string,
): Promise<boolean> {
  const session = await getSession();
  if (!session?.user?.id || session.user.banned === true) return false;
  const owned =
    kind === "consultee"
      ? session.user.consulteeProfileId
      : session.user.consultantProfileId;
  return Boolean(owned) && owned === profileId;
}

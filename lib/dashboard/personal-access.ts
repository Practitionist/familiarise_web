/**
 * #1527 QA P0 — when a personal dashboard layout may bounce its viewer.
 *
 * Both personal trees read the viewer from the shared `["user-details", id]`
 * cache (≤ 5 min stale). A switch from the Expert to the Client tree could
 * therefore judge ownership on a cached row and `router.replace` to
 * `/dashboard`, which lands a dual-role user back on the Expert home. A
 * denial now needs a read made after this layout mounted, and a layout the
 * URL has already left never navigates at all.
 */

export type PersonalAccessDecision =
  /** Owner / operator, or the viewer is still loading: render as usual. */
  | "render"
  /** The URL has left this tree: show the skeleton, never navigate. */
  | "hold"
  /** Denied on a cached row: refetch the viewer before deciding. */
  | "verify"
  /** Denied on a fresh row: send the viewer to their own dashboard. */
  | "redirect";

export interface PersonalAccessInput {
  hasUser: boolean;
  hasAccess: boolean;
  /** `isFetchedAfterMount` of the viewer query. */
  verified: boolean;
  pathname: string;
  basePath: string;
}

export function personalAccessDecision({
  hasUser,
  hasAccess,
  verified,
  pathname,
  basePath,
}: PersonalAccessInput): PersonalAccessDecision {
  if (!hasUser || hasAccess) return "render";
  const ownsPath = pathname === basePath || pathname.startsWith(`${basePath}/`);
  if (!ownsPath) return "hold";
  return verified ? "redirect" : "verify";
}

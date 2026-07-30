/**
 * Single source of truth for which public chrome (Navbar / Footer /
 * HeaderSpacer) renders on a given route.
 *
 * These three lists used to be copy-pasted into all three components and had
 * already drifted: `/explore/enterprise/organisations` was treated as a
 * dark-hero page by the Navbar but was missing from HeaderSpacer's exclusions,
 * so a transparent white-text nav rendered on top of a full-height white
 * spacer band instead of the page's dark hero.
 *
 * The fix that keeps it fixed is making the spacer *derived* rather than
 * independently listed — see `needsHeaderSpacer`.
 */

/** Routes that render their own shell and never show the public chrome. */
export const NO_CHROME_PREFIXES = [
  "/api/",
  "/auth/",
  "/form/",
  "/checkout/",
  "/dashboard",
  "/meetings/",
  // Middleware can rewrite any URL here; it has its own standalone shell.
  "/maintenance",
] as const;

/**
 * Routes whose page begins with a full-bleed dark hero that the nav overlays,
 * and which therefore supply their own top padding — so no spacer.
 *
 * SPACING ONLY. The navbar no longer reads this to choose its colour: it
 * observes a `[data-nav-sentinel]` element rendered at the top of the actual
 * hero, so its treatment can never disagree with what is painted. This list
 * survives because HeaderSpacer runs during SSR and must reserve layout before
 * any observer exists — deriving it on the client would land as a visible jump.
 *
 * A route listed here MUST render a full-bleed hero in its `loading.tsx` too,
 * or its skeleton starts underneath the fixed navbar.
 */
export const TRANSPARENT_HERO_ROUTES = [
  "/",
  "/explore/experts",
  "/explore/programs",
  "/explore/community",
  "/explore/enterprise/organisations",
  // The four persona pages open on the same full-bleed dark hero.
  "/use-cases/college-students",
  "/use-cases/early-career",
  "/use-cases/career-switchers",
  "/use-cases/mentorship",
] as const;

/**
 * Segment-aware prefix match. A bare `startsWith` would treat `/dashboardfoo`
 * or `/maintenance-notes` as matching `/dashboard` / `/maintenance` and strip
 * the chrome from an unrelated page.
 */
function matchesPrefix(pathname: string, prefix: string): boolean {
  const normalised = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return pathname === normalised || pathname.startsWith(`${normalised}/`);
}

export function isChromeHidden(pathname: string): boolean {
  return NO_CHROME_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

/**
 * Exact match, not prefix: `/explore/experts` has a dark hero but its detail
 * page `/explore/experts/[consultantId]` does not. Query strings never reach
 * here — callers pass `usePathname()`.
 */
export function hasDarkHero(pathname: string): boolean {
  // Tolerate a trailing slash; still an exact-route match otherwise, because
  // `/explore/experts` has a dark hero but `/explore/experts/[id]` does not.
  const normalised =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  return (TRANSPARENT_HERO_ROUTES as readonly string[]).includes(normalised);
}

/**
 * Derived, so it can't drift from the other two: a spacer is needed exactly
 * when the nav is rendered AND is not overlaying a hero.
 */
export function needsHeaderSpacer(pathname: string): boolean {
  return !isChromeHidden(pathname) && !hasDarkHero(pathname);
}

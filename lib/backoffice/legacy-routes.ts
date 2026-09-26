import {
  backofficeLandingHref,
  type BackofficeTree,
} from "@/lib/backoffice/capability";

/**
 * #1527 Q3 — where a retired back-office URL lives now. Pure and jest-pinned;
 * `[tree]/[...legacy]/page.tsx` answers a 308 with the result, or a 404 when
 * this returns null. Query strings are always carried over.
 */

type SearchParams = Record<string, string | string[] | undefined>;

// StaffProfile.id is `@default(uuid())`; same shape as the breadcrumbs'
// record-id check (components/dashboard/breadcrumbs.ts).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `path` with the incoming query, then `overrides` (which win). */
function withQuery(
  path: string,
  searchParams: SearchParams,
  overrides: Record<string, string> = {},
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key in overrides) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (v !== undefined) query.append(key, v);
    }
  }
  for (const [key, value] of Object.entries(overrides)) query.set(key, value);
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

export function legacyBackofficeHref(
  tree: BackofficeTree,
  segments: readonly string[],
  searchParams: SearchParams = {},
): string | null {
  const base = `/dashboard/${tree}`;
  const [head, ...rest] = segments;

  if (head === undefined) {
    return withQuery(backofficeLandingHref({ tree }), searchParams);
  }

  // The old staff tree was keyed by the viewer's own StaffProfile id.
  if (tree === "staff" && UUID_RE.test(head)) {
    if (rest.length === 0) {
      return withQuery(backofficeLandingHref({ tree }), searchParams);
    }
    return (
      legacyBackofficeHref(tree, rest, searchParams) ??
      withQuery(`${base}/${rest.join("/")}`, searchParams)
    );
  }

  if (rest.length === 0) {
    switch (head) {
      // Q9 — approval payments became an Appointments tab.
      case "approval-payments":
        return withQuery(`${base}/appointments`, searchParams, {
          tab: "awaiting-payment",
        });
      // The documents log became a Verification tab.
      case "documents":
        return withQuery(`${base}/verification`, searchParams, {
          tab: "documents",
        });
      // The feedback notification linked a plural that never had a page.
      case "feedbacks":
        return withQuery(`${base}/feedback`, searchParams);
      case "data-breaches":
        return withQuery(`${base}/compliance`, searchParams, {
          tab: "breaches",
        });
      default:
        return null;
    }
  }

  // The breach-deadline alert linked a per-breach page that never existed.
  if (head === "data-breaches" && rest.length === 1) {
    return withQuery(`${base}/compliance`, searchParams, {
      tab: "breaches",
      id: rest[0],
    });
  }

  return null;
}

/** STAFF opening `/dashboard/admin/…` get the same page in their own tree. */
export function staffTwinHref(
  pathWithQuery: string | null | undefined,
): string {
  const match = /^\/dashboard\/admin(?=\/|\?|$)(.*)$/.exec(pathWithQuery ?? "");
  if (!match) return backofficeLandingHref({ tree: "staff" });
  const rest = match[1];
  return rest && rest !== "/"
    ? `/dashboard/staff${rest}`
    : backofficeLandingHref({ tree: "staff" });
}

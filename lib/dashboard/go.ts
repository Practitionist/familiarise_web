/**
 * `/dashboard/go/<facet>/<path>` — a deep link that names a surface but not
 * the viewer's own profile id (#1527 §6). B2C notifications send one payload
 * to several people, so `auto` resolves by the viewer's side of the record.
 * Pure; the page does the one read (`appointments/<id>` participation).
 */

export type GoFacet = "expert" | "client" | "auto";

export interface GoViewer {
  role: string | null | undefined;
  consultantProfileId?: string | null;
  consulteeProfileId?: string | null;
  /** ACTIVE memberships (session). */
  organizationIds?: readonly string[];
}

/** The viewer's side of one appointment; null when unknown or not a party. */
export interface GoParticipation {
  asConsultant: boolean;
  asConsultee: boolean;
  /** The appointment's owning org, for org-only viewers. */
  organizationId: string | null;
}

export const GO_FALLBACK = "/dashboard";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Path segments that are safe to splice into a dashboard URL, or null. */
export function sanitizeGoPath(
  path: readonly string[] | undefined,
): string[] | null {
  const segments = path ?? [];
  return segments.every((s) => SAFE_SEGMENT.test(s)) ? [...segments] : null;
}

/** `appointments/<id>[/…]` → the id, else null. */
export function goAppointmentId(path: readonly string[]): string | null {
  return path[0] === "appointments" && path[1] ? path[1] : null;
}

function join(base: string, path: readonly string[]): string {
  return path.length > 0 ? `${base}/${path.join("/")}` : `${base}/home`;
}

function expertHref(viewer: GoViewer, path: readonly string[]): string | null {
  return viewer.consultantProfileId
    ? join(`/dashboard/consultant/${viewer.consultantProfileId}`, path)
    : null;
}

function clientHref(viewer: GoViewer, path: readonly string[]): string | null {
  return viewer.consulteeProfileId
    ? join(`/dashboard/consultee/${viewer.consulteeProfileId}`, path)
    : null;
}

// Surfaces that exist in only one personal tree: never send a viewer to the
// side that would 404.
const EXPERT_ONLY = new Set([
  "requests",
  "earnings",
  "availability",
  "planner",
  "collaborations",
  "offerings",
  "reviews",
  "analytics",
]);
const CLIENT_ONLY = new Set(["payments", "resources"]);

/** The role's own side first, then whichever personal tree exists. */
function roleFirst(viewer: GoViewer, path: readonly string[]): string | null {
  if (EXPERT_ONLY.has(path[0] ?? "")) return expertHref(viewer, path);
  if (CLIENT_ONLY.has(path[0] ?? "")) return clientHref(viewer, path);
  if (viewer.role === "CONSULTEE") {
    return clientHref(viewer, path) ?? expertHref(viewer, path);
  }
  return expertHref(viewer, path) ?? clientHref(viewer, path);
}

export function resolveGoHref(
  facet: string,
  rawPath: readonly string[] | undefined,
  viewer: GoViewer,
  participation: GoParticipation | null = null,
): string {
  const path = sanitizeGoPath(rawPath);
  if (!path) return GO_FALLBACK;

  if (facet === "expert") return expertHref(viewer, path) ?? GO_FALLBACK;
  if (facet === "client") return clientHref(viewer, path) ?? GO_FALLBACK;
  if (facet !== "auto") return GO_FALLBACK;

  const appointmentId = goAppointmentId(path);
  if (appointmentId && participation) {
    if (participation.asConsultant) {
      const href = expertHref(viewer, path);
      if (href) return href;
    }
    if (participation.asConsultee) {
      const href = clientHref(viewer, path);
      if (href) return href;
    }
    const orgId = participation.organizationId;
    if (orgId && (viewer.organizationIds ?? []).includes(orgId)) {
      return `/dashboard/organization/${orgId}/appointments/${appointmentId}`;
    }
  }
  return roleFirst(viewer, path) ?? GO_FALLBACK;
}

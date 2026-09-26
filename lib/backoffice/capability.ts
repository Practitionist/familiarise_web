import type { UserRole } from "@prisma/client";

import {
  hasBackofficePermission,
  type BackofficeSurface,
} from "@/lib/auth/backoffice-permissions";

/**
 * #1527 Q3 — one back-office route tree, `/dashboard/{admin,staff}/…`. The
 * tree segment picks the AUDIENCE (what that console shows); the session role
 * caps it. An admin opening the staff tree sees exactly what staff see, and
 * staff never get an admin audience. Pure: server pages, the client provider
 * and jest all read the same functions.
 */

export const BACKOFFICE_TREES = ["admin", "staff"] as const;
export type BackofficeTree = (typeof BACKOFFICE_TREES)[number];
export type BackofficeRole = Extract<UserRole, "ADMIN" | "STAFF">;

export interface BackofficeCapability {
  tree: BackofficeTree;
  /** `/dashboard/<tree>` — every in-console link is built from this. */
  basePath: string;
  role: BackofficeRole;
  audience: BackofficeRole;
}

export function isBackofficeTree(value: string): value is BackofficeTree {
  return (BACKOFFICE_TREES as readonly string[]).includes(value);
}

/** Null when the role may not open this tree (non-operators, STAFF on admin). */
export function resolveBackofficeCapability(
  role: string | null | undefined,
  tree: BackofficeTree,
): BackofficeCapability | null {
  if (role !== "ADMIN" && role !== "STAFF") return null;
  const audience: BackofficeRole = tree === "admin" ? "ADMIN" : "STAFF";
  if (audience === "ADMIN" && role !== "ADMIN") return null;
  return { tree, basePath: `/dashboard/${tree}`, role, audience };
}

/** Both the tree's audience and the viewer's own role must hold the surface. */
export function can(
  cap: Pick<BackofficeCapability, "role" | "audience">,
  surface: BackofficeSurface,
): boolean {
  return (
    hasBackofficePermission(cap.audience, surface) &&
    hasBackofficePermission(cap.role, surface)
  );
}

/** Q12 — admins land on "Needs attention", staff on their ticket queue. */
export function backofficeLandingHref(
  cap: Pick<BackofficeCapability, "tree">,
): string {
  return cap.tree === "admin"
    ? "/dashboard/admin/home"
    : "/dashboard/staff/tickets";
}

/**
 * `?orgScope=` query-param parser for the personal-vs-org list APIs
 * (#674 / B1-hybrid). Single source of truth — every list endpoint that
 * supports the scope toggle calls into this helper.
 *
 * Three values, three roles:
 *   - `personal` (default)     — the caller's own data only
 *   - `<orgId>`                — data scoped to that org; caller must be
 *                                an active member of the org
 *   - `all`                    — admin-only union across all orgs +
 *                                personal; rejected for non-ADMIN/STAFF
 *
 * The serialized form mirrors `lib/dashboard/org-context-filter.ts` so
 * the URL state stays compatible with the existing `OrgContextFilter`
 * client component (which uses `__personal__` / `__all__` / orgId).
 */

import type { Membership, MemberStatus } from "@prisma/client";

export type Scope =
  | { kind: "personal" }
  | { kind: "org"; orgId: string }
  | { kind: "all" };

export type ScopeResolution =
  | { ok: true; scope: Scope }
  | {
      ok: false;
      status: 400 | 403;
      code:
        | "INVALID_SCOPE"
        | "ORG_MEMBERSHIP_REQUIRED"
        | "ALL_REQUIRES_PRIVILEGED_ROLE";
      message: string;
    };

export interface ResolveScopeContext {
  /** The raw `?orgScope=` value from the URL (or `undefined`). */
  raw: string | null | undefined;
  /** Active org memberships for the calling user. */
  memberships: Pick<Membership, "organizationId" | "status">[];
  /** Top-level UserRole — used to gate `?orgScope=all`. */
  userRole: string | null | undefined;
}

const PRIVILEGED_USER_ROLES = new Set(["ADMIN", "STAFF"]);

function isActiveAtOrg(
  memberships: ResolveScopeContext["memberships"],
  orgId: string,
  activeStatuses: MemberStatus[] = ["ACTIVE"],
): boolean {
  return memberships.some(
    (m) => m.organizationId === orgId && activeStatuses.includes(m.status),
  );
}

/**
 * Parse + authorize a `?orgScope=` value. Returns either the resolved
 * scope or a structured error the route can map to a 400/403 response.
 *
 * Default (no param) is `personal` — backwards-compatible with every
 * pre-#674 list endpoint.
 */
export function resolveOrgScope(ctx: ResolveScopeContext): ScopeResolution {
  const raw = ctx.raw?.trim();
  if (!raw || raw === "personal") {
    return { ok: true, scope: { kind: "personal" } };
  }
  if (raw === "all") {
    if (!ctx.userRole || !PRIVILEGED_USER_ROLES.has(ctx.userRole)) {
      return {
        ok: false,
        status: 403,
        code: "ALL_REQUIRES_PRIVILEGED_ROLE",
        message:
          "?orgScope=all is reserved for ADMIN / STAFF users; pass `personal` or a specific orgId.",
      };
    }
    return { ok: true, scope: { kind: "all" } };
  }

  // Treat anything else as an orgId. Reject if the caller has no active
  // membership at that org (cross-tenant IDOR guard).
  const orgId = raw;
  if (!isActiveAtOrg(ctx.memberships, orgId)) {
    return {
      ok: false,
      status: 403,
      code: "ORG_MEMBERSHIP_REQUIRED",
      message: `You are not an active member of org ${orgId}.`,
    };
  }
  return { ok: true, scope: { kind: "org", orgId } };
}

/**
 * Project a `Scope` into a partial Prisma `where` clause keyed on the
 * model's `organizationId` column. Caller composes this with their
 * other filters.
 *
 * Personal scope → `{ organizationId: null }` (rows NOT tagged to any
 *   org). Plus the caller's userId filter is applied separately by the
 *   route — this helper only contributes the scope dimension.
 * Org scope → `{ organizationId: orgId }`.
 * All scope → `{}` (no org filter; caller is admin/staff).
 */
export function scopeToWhereOrgId(
  scope: Scope,
): { organizationId: string | null } | { organizationId: string } | {} {
  if (scope.kind === "personal") return { organizationId: null };
  if (scope.kind === "org") return { organizationId: scope.orgId };
  return {};
}

/**
 * Serialize a Scope back to the URL form. Inverse of `resolveOrgScope`.
 * Used by the `useOrgScope` hook to mutate the URL when the user
 * toggles the dropdown.
 */
export function serializeScope(scope: Scope): string {
  if (scope.kind === "personal") return "personal";
  if (scope.kind === "all") return "all";
  return scope.orgId;
}

/**
 * `?orgScope=` query-param parser for the personal-vs-org list APIs
 * (#674 / B1-hybrid). Single source of truth — every list endpoint that
 * supports the scope toggle calls into this helper.
 *
 * Three values, three roles:
 *   - `mine` (default)         — the caller's own data only
 *   - `<orgId>`                — data scoped to that org; caller must be
 *                                an active member of an org that still
 *                                exists (see ORG_SCOPE_READABLE_STATUSES)
 *   - `all`                    — admin-only union across all orgs +
 *                                personal; rejected for non-ADMIN/STAFF
 *
 * The #768 lockdown renamed the sentinels from `__personal__` /
 * `"personal"` to a single `"mine"` vocabulary. This file is now the only
 * definition of that vocabulary — the client-side mirror it used to share
 * with (`lib/dashboard/org-context-filter.ts`) was deleted once #1023
 * removed the last org-context switcher from the personal dashboards.
 */

import type { Membership, OrgStatus } from "@prisma/client";

import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { ADDRESSABLE_ORG_STATUSES } from "@/lib/enterprise/org-status";

export type Scope =
  | { kind: "personal" }
  | { kind: "org"; orgId: string }
  // #org-appts — org-scoped to ONE member's own participation (booked as a
  // learner OR delivered as an expert). Distinct from `org` (all-org, MANAGER+).
  // Server-constructed only (not `?orgScope=`-addressable).
  | { kind: "orgMember"; orgId: string; userId: string }
  | { kind: "all" };

export type ScopeResolution =
  | { ok: true; scope: Scope }
  | {
      ok: false;
      status: 400 | 403;
      code:
        | "INVALID_SCOPE"
        | "ORG_MEMBERSHIP_REQUIRED"
        | "ALL_REQUIRES_PRIVILEGED_ROLE"
        | "ORG_DEACTIVATED";
      message: string;
    };

/**
 * The `Organization.status` values a member may still read that org's rows
 * through `?orgScope=`.
 *
 * This is `ADDRESSABLE_ORG_STATUSES` (lib/enterprise/org-status.ts) verbatim —
 * the same tuple `requireOrgAccess` reads, so the two doors cannot drift:
 *
 *   - DEACTIVATED is the only exclusion. It is the terminal teardown status,
 *     documented as "treated as non-existent for billing + membership flows",
 *     and the org PATCH stamps it WITHOUT touching Membership rows — so an
 *     ACTIVE membership outlives the org and used to keep the personal
 *     `?orgScope=` door open forever after the org was gone.
 *   - SUSPENDED is deliberately INCLUDED. Its documented posture is
 *     "members lose access to org-scoped flows; existing bookings keep
 *     running", and ADDRESSABLE_ORG_STATUSES spells out why the read half
 *     stays: an OWNER must be able to open the org to find and fix the cause.
 *     A member who can still see the sessions they are booked into is what
 *     "existing bookings keep running" means.
 *   - PENDING_VERIFICATION is a pre-verification grace state, not a sanction;
 *     its members book and read normally.
 */
export const ORG_SCOPE_READABLE_STATUSES: OrgStatus[] = [
  ...ADDRESSABLE_ORG_STATUSES,
];

/** True when a member of an org in this status may still read its data. */
export function isOrgReadableForScope(
  status: OrgStatus | null | undefined,
): boolean {
  return !!status && ORG_SCOPE_READABLE_STATUSES.includes(status);
}

export interface ResolveScopeContext {
  /** The raw `?orgScope=` value from the URL (or `undefined`). */
  raw: string | null | undefined;
  /**
   * Active org memberships for the calling user. `role` is required: the
   * `org` scope carries NO user filter, so granting it is equivalent to
   * granting `operations.read` and must be gated on the member's role.
   */
  memberships: Pick<Membership, "organizationId" | "status" | "role">[];
  /**
   * `Organization.status` for the org named by `raw`, when the caller already
   * has it in hand.
   *
   * OPTIONAL, and omitting it is not the same as passing ACTIVE — this resolver
   * is synchronous, so a caller that has not already awaited the org row cannot
   * supply the status at all. The `undefined` case therefore means "the caller
   * never looked", NOT "the org is readable", and the gate below is skipped.
   *
   * As of this wave NO caller passes it. Every one of the sixteen
   * `resolveOrgScope` call sites pre-fetches memberships with
   * `select: { organizationId, status, role }` — no `organization.status`
   * reaches it — so the `ORG_DEACTIVATED` refusal here is inert in production
   * and every route still admits a DEACTIVATED org on the strength of a
   * membership row that outlived it. That is why the decision lives in this one
   * file rather than in sixteen routes: a caller that starts passing the field
   * inherits the refusal with no other change.
   *
   * The leak is closed a second way, where a caller CAN close it for free. The
   * three `buildWhere` helpers — `list-appointments.ts`, `list-documents.ts`,
   * `list-recordings.ts` — filter a relation the org arm already pins, so
   * `organization: { is: { status: { in: ORG_SCOPE_READABLE_STATUSES } } }`
   * rides the WHERE instead of needing a new field. `all` stays unfiltered on
   * purpose: an ADMIN reading a DEACTIVATED org is how the teardown is verified.
   *
   * Still OPEN, and the remaining work: every other consumer is either a
   * hand-rolled filter with no relation predicate to add one to
   * (`/api/collaborations`) or a route that would need to select the org status
   * it does not currently read. Wiring those is a per-caller select, not a
   * change to this resolver — making the resolver `async` would buy it at the
   * price of turning a pure, trivially-testable function into sixteen await
   * sites, and the field below is the better trade.
   *
   * `null` means the org row is gone, and is refused like DEACTIVATED.
   */
  orgStatus?: OrgStatus | null;
  /** Top-level UserRole — used to gate `?orgScope=all`. */
  userRole: string | null | undefined;
  /** Caller's user id — needed to build the `orgMember` downgrade below. */
  userId: string;
  /**
   * Opt-in for endpoints that are already self-scoped to the caller's
   * own data (e.g. `/api/dashboard/consultee/<myId>/events` — the route
   * authz already rejects requests for someone else's profile). For
   * those, `?orgScope=all` just means "personal + every org I belong
   * to" — no cross-tenant leak is possible, so the admin gate is
   * unnecessary and was the reason learners couldn't see their full
   * activity in one view. Cross-tenant endpoints (e.g. /api/appointments,
   * /api/appointments) leave this false and keep the admin restriction.
   */
  allowAllForOwner?: boolean;
}

const PRIVILEGED_USER_ROLES = new Set(["ADMIN", "STAFF"]);

/**
 * Parse + authorize a `?orgScope=` value. Returns either the resolved
 * scope or a structured error the route can map to a 400/403 response.
 *
 * Default (no param) is `personal` — backwards-compatible with every
 * pre-#674 list endpoint.
 */
export function resolveOrgScope(ctx: ResolveScopeContext): ScopeResolution {
  const raw = ctx.raw?.trim();
  // Accept both "mine" (canonical) and the legacy "personal" sentinel for
  // a deprecation grace window — drop "personal" in v1.1.
  if (!raw || raw === "mine" || raw === "personal") {
    return { ok: true, scope: { kind: "personal" } };
  }
  if (raw === "all") {
    const isPrivileged =
      ctx.userRole && PRIVILEGED_USER_ROLES.has(ctx.userRole);
    if (!isPrivileged && !ctx.allowAllForOwner) {
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
  const membership = ctx.memberships.find(
    (m) => m.organizationId === orgId && m.status === "ACTIVE",
  );
  if (!membership) {
    return {
      ok: false,
      status: 403,
      code: "ORG_MEMBERSHIP_REQUIRED",
      message: `You are not an active member of org ${orgId}.`,
    };
  }

  // An ACTIVE membership is not evidence that the ORG still exists. The
  // deactivate flow (`PATCH /api/organizations/[orgId]`) stamps
  // `DEACTIVATED` + `deletedAt` and leaves Membership rows untouched, so the
  // membership check above used to be the whole authorisation for a tenant that
  // had been torn down: a member kept reading that org's appointments,
  // documents, recordings and collaborations through the personal `?orgScope=`
  // door indefinitely — while `requireOrgAccess` 403'd the same org on the
  // sibling door.
  //
  // Refuse rather than downgrade to the caller's own rows: DEACTIVATED is
  // terminal, so the org is not coming back, and a downgrade would leave a
  // dead tenant addressable. SUSPENDED is not this branch — see
  // ORG_SCOPE_READABLE_STATUSES for why it stays readable.
  //
  // GATED ON `orgStatus !== undefined`, and no caller passes it yet — read the
  // field's docblock before assuming this branch is doing anything in
  // production. It is the door every caller should come through; the three
  // `buildWhere` helpers are the stopgap that actually fires today.
  if (ctx.orgStatus !== undefined && !isOrgReadableForScope(ctx.orgStatus)) {
    return {
      ok: false,
      status: 403,
      code: "ORG_DEACTIVATED",
      // The same sentence requireOrgAccess answers with, so a client that
      // already handles the org door does not need a second message.
      message: "Organization has been deactivated",
    };
  }

  // Membership alone is NOT enough. The `org` scope applies no user filter —
  // `buildWhere` returns rows for the whole org — so handing it to any active
  // member let a plain LEARNER read the org's entire appointment, document and
  // recording feed via `?orgScope=<orgId>`. The org-scoped sibling routes
  // (/api/organizations/[orgId]/...) all require `operations.read` for the
  // same rows; this is the same gate on the other door.
  //
  // Below that bar the request still has an honest answer — "my own rows in
  // this org" — so it downgrades to `orgMember` rather than 403ing. That is
  // what a learner passing their own org id actually means.
  if (!hasOrgPermission(membership.role, "operations.read")) {
    return {
      ok: true,
      scope: { kind: "orgMember", orgId, userId: ctx.userId },
    };
  }

  return { ok: true, scope: { kind: "org", orgId } };
}

/**
 * Exhaustiveness guard for `Scope`.
 *
 * Every `buildWhere` in this directory used to end in a bare `return base`,
 * which is the `all` (admin/staff) arm — no filter, every tenant. That made
 * the helpers fail OPEN by construction: the `orgMember` kind fell through it
 * for months as a latent leak, and any kind added later would do the same
 * silently. Calling this in the final position turns that into a compile
 * error when a variant is added, and a thrown error rather than a
 * platform-wide result set if one somehow reaches it at runtime.
 */
export function assertNeverScope(scope: never): never {
  throw new Error(
    `Unhandled scope kind: ${JSON.stringify(scope)}. Scoped list helpers must fail closed.`,
  );
}

/**
 * The organization a scope is pinned to, or `null` when it spans every org
 * (`all`) or none (`personal`).
 *
 * `org` and `orgMember` BOTH pin an organization — narrowing to the caller's
 * own rows is the only difference between them, and that half is applied by
 * the route's existing self-scoping. Six consumers hand-rolled
 * `kind === "org" ? { organizationId } : <unfiltered>` and so silently stopped
 * filtering the moment the `operations.read` downgrade made `orgMember`
 * reachable: a learner picking one org got their rows from every org plus
 * their personal ones. Route the question through here instead of repeating
 * the two-kind test, so a future `Scope` variant is a compile error in one
 * place rather than a quiet fall-through in seven.
 */
export function scopeOrgId(scope: Scope): string | null {
  return scope.kind === "org" || scope.kind === "orgMember"
    ? scope.orgId
    : null;
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
  if (scope.kind === "org" || scope.kind === "orgMember")
    return { organizationId: scope.orgId };
  return {};
}

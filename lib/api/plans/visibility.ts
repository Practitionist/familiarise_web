/**
 * Shared visibility filter for plan-marketplace endpoints (#726).
 *
 * Org-owned plans (ConsultationPlan / SubscriptionPlan / WebinarPlan /
 * ClassPlan with `organizationId` set) carry an `OrgPlanVisibility`
 * enum that decides whether they're discoverable on `/explore/**` and
 * the public plan list APIs:
 *
 *   PUBLIC          — visible everywhere (default for personal plans).
 *   ORG_AND_PUBLIC  — discoverable AND surfaced to org members.
 *   ORG_ONLY        — only org members see it; the marketplace MUST
 *                     filter it out.
 *
 * Every public-facing plan list endpoint should compose this filter
 * into its `where` clause. An org-internal catalog endpoint should NOT
 * use this helper — those endpoints accept `ORG_ONLY` for the viewer's
 * own org by design.
 *
 * Why a helper rather than inline checks: a dropped or mistyped filter
 * on any one of the four marketplace surfaces becomes a tenant-private
 * catalog leak (the bug class #726 was filed to prevent). Routing every
 * public surface through one constant keeps the gate auditable.
 */

import type { OrgPlanVisibility } from "@prisma/client";

/**
 * Visibility values that are safe to show on the public marketplace.
 * Used as a Prisma `where: { visibility: { in: ... } }` filter.
 */
export const MARKETPLACE_VISIBILITY: OrgPlanVisibility[] = [
  "PUBLIC",
  "ORG_AND_PUBLIC",
];

/**
 * Convenience filter object — spread into any plan-list `where`:
 *
 *   const where = {
 *     ...other filters,
 *     ...marketplaceVisibilityWhere(),
 *   };
 */
export function marketplaceVisibilityWhere() {
  return { visibility: { in: MARKETPLACE_VISIBILITY } } as const;
}

/**
 * Discovery filter for the two ARCHIVABLE plan types (WebinarPlan, ClassPlan).
 *
 * `marketplaceVisibilityWhere()` cannot carry this: it is also spread into
 * ConsultationPlan and SubscriptionPlan queries, and those models have no
 * `archivedAt` column — Prisma would reject the filter. So the two gates live
 * side by side here rather than one being inlined at eight call sites, for the
 * same auditability reason the header gives.
 *
 * Archived means withdrawn from sale. The row is kept because it carries the
 * terms of every booking made against it, and because the plan FK chain
 * cascades to Appointment and Payment — see the catalog DELETE handler.
 */
export function eventPlanDiscoverableWhere() {
  return {
    visibility: { in: MARKETPLACE_VISIBILITY },
    archivedAt: null,
  } as const;
}

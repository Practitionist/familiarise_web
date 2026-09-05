/**
 * Shared consultant-facing archive (withdraw) toggle for the four plan
 * families — ConsultationPlan, SubscriptionPlan, WebinarPlan, ClassPlan (#1494).
 *
 * The org-catalog bulk archive (`app/api/organizations/[orgId]/catalog/route.ts`)
 * was the only existing `archivedAt` writer; a sole-owner consultant (a plan
 * with `organizationId: null`) had no path to stop selling an offering. This
 * helper is the one place the archive/restore semantics live so the four
 * per-plan PATCH routes cannot drift from each other.
 *
 * Archiving stops NEW sales only: `archivedAt` already gates discovery
 * (`lib/api/plans/visibility.ts`), plan-list filters
 * (`app/api/plans/shared/plan-filters.ts`) and checkout
 * (`lib/payments/operations/checkout.ts`), but it never touches existing
 * `Appointment`/`Payment` rows.
 */

import { z } from "zod";

export const ArchivePlanBodySchema = z.object({
  archived: z.boolean(),
});

/**
 * Idempotent: archiving an already-archived plan keeps the original
 * withdrawal timestamp instead of bumping it, and restoring an already-live
 * plan is a no-op.
 */
export function nextArchivedAt(
  archived: boolean,
  currentArchivedAt: Date | null,
): Date | null {
  return archived ? (currentArchivedAt ?? new Date()) : null;
}

export const PLAN_ARCHIVE_RESPONSE_NOTE =
  "Archiving stops new bookings only; existing appointments and payments for this plan are unaffected.";

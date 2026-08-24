/**
 * Server-side document review invariants: per-appointment count caps and the
 * review status transition guard. Pure logic only — Prisma entrypoints are
 * deliberately not parameterized here because the $extends-wrapped client and
 * a transaction client are not mutually assignable at the type level; each
 * route inlines its own reads against whichever handle it holds.
 */

/** Hard ceiling on live (non-deleted) documents per appointment, both roles. */
export const MAX_DOCS_PER_APPOINTMENT = 20;

/** Grace window before the nightly cleanup job purges soft-deleted rows. */
export const DOCUMENT_DELETE_GRACE_DAYS = 7;

export type ReviewStatus =
  | "PENDING"
  | "IN_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "NEEDS_REVISION";

/**
 * Allowed transitions of `DocumentReviewStatus`. APPROVED and REJECTED are
 * terminal — reopening a decided review would silently rewrite history that
 * notifications and the consultee already acted on; the correct move for a
 * mistake is a threaded follow-up upload or a new submission.
 */
const REVIEW_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  PENDING: ["IN_REVIEW", "APPROVED", "REJECTED", "NEEDS_REVISION"],
  IN_REVIEW: ["PENDING", "APPROVED", "REJECTED", "NEEDS_REVISION"],
  NEEDS_REVISION: ["PENDING", "IN_REVIEW", "APPROVED", "REJECTED"],
  APPROVED: [],
  REJECTED: [],
};

export function isReviewTransitionAllowed(
  from: ReviewStatus,
  to: ReviewStatus,
): boolean {
  return REVIEW_TRANSITIONS[from].includes(to);
}

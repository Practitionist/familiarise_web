import type { DisputeStatus, ErasureStatus, Prisma } from "@prisma/client";

import { HELD_PRE_LAUNCH } from "@/lib/email/held";

/**
 * #1527 Q12 — the `where` behind every back-office queue, shared by the page's
 * own route and `/api/backoffice/nav-counts`, so a badge can never count a
 * different set than the page it opens (#1345). Pure: no Prisma client.
 */

// ── Support ─────────────────────────────────────────────────────────────

// The Support inbox (tickets + not-yet-escalated conversations) owns its
// builders in lib/support/inbox-query.ts; the badge reads them through
// `inboxBadgeCountReads` (lib/support/case-read.ts).

// ── Moderation ──────────────────────────────────────────────────────────

export const PENDING_REPORT_WHERE: Prisma.ModerationReportWhereInput = {
  status: "PENDING",
};

/**
 * Reports raised on the coercion ground — the ones that must not wait behind
 * the rest of the queue.
 *
 * `reasonCode` is the typed ground. Reports filed before it existed keep the
 * code in `reason`, so both are matched: the queue floats the same rows it
 * always did.
 */
export const COERCION_REPORT_WHERE: Prisma.ModerationReportWhereInput = {
  OR: [
    { reasonCode: "COERCION_OR_RETALIATION" },
    { reasonCode: null, reason: "COERCION_OR_RETALIATION" },
  ],
};

/** How the moderation queue narrows by assignment. */
export const REPORT_ASSIGNMENTS = ["all", "mine", "unassigned"] as const;
export type ReportAssignment = (typeof REPORT_ASSIGNMENTS)[number];

/**
 * The assignment slice of the moderation queue. Shared with the queue's own
 * route so a filter added here cannot drift between the queue and anything
 * that counts it.
 */
export function reportAssignmentWhere(
  assignment: ReportAssignment,
  viewerId: string,
): Prisma.ModerationReportWhereInput {
  switch (assignment) {
    case "mine":
      return { assignedToId: viewerId };
    case "unassigned":
      return { assignedToId: null };
    case "all":
      return {};
  }
}

// ── Verification ────────────────────────────────────────────────────────

export const PENDING_CONSULTANT_VERIFICATION_WHERE: Prisma.ConsultantProfileVerificationWhereInput =
  { status: "PENDING" };

/** Waiting on us: submitted, not verified, and not bounced back to the owner. */
export const ORG_AWAITING_VERIFICATION_WHERE: Prisma.OrganizationWhereInput = {
  status: "PENDING_VERIFICATION",
  verificationRejectedAt: null,
};

// ── Money ───────────────────────────────────────────────────────────────

/** Disputes still in proceedings (a response or a verdict is outstanding). */
export const OPEN_DISPUTE_STATUSES: DisputeStatus[] = [
  "WARNING_NEEDS_RESPONSE",
  "NEEDS_RESPONSE",
  "UNDER_REVIEW",
];
export const OPEN_DISPUTE_WHERE: Prisma.DisputeWhereInput = {
  status: { in: OPEN_DISPUTE_STATUSES },
};

// Payouts: `payoutListWhere({ status: "PENDING" })` in
// lib/api/operators/payouts.ts, the Awaiting approval tab's own builder.

// ── Compliance ──────────────────────────────────────────────────────────

/** Erasure requests with a DPDP clock still running. */
export const OPEN_ERASURE_STATUSES: ErasureStatus[] = [
  "PENDING",
  "IN_PROGRESS",
];
export const OPEN_ERASURE_WHERE: Prisma.ErasureRequestWhereInput = {
  status: { in: OPEN_ERASURE_STATUSES },
};

/** DPDP: the Board must hear of a breach within 72 hours of detection. */
export const BREACH_REPORTING_DEADLINE_HOURS = 72;

/** A breach the Board has not been told about yet (72-hour duty). */
export const UNREPORTED_BREACH_WHERE: Prisma.DataBreachWhereInput = {
  reportedAt: null,
};

/**
 * Emails every retry gave up on; only an operator replays them. Pre-launch holds
 * are expected, not failures. `lastError: null` stays in: SQL `<>` drops NULLs.
 */
export const DEAD_LETTER_EMAIL_WHERE: Prisma.FailedEmailWhereInput = {
  status: "DEAD_LETTER",
  OR: [{ lastError: null }, { lastError: { not: HELD_PRE_LAUNCH } }],
};

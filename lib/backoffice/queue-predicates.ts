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

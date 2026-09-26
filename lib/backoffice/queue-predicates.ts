import type {
  DisputeStatus,
  ErasureStatus,
  Prisma,
  SupportIssueType,
  SupportPriority,
  SupportThreadStatus,
  SupportTicketStatus,
} from "@prisma/client";

/**
 * #1527 Q12 — the `where` behind every back-office queue, shared by the page's
 * own route and `/api/backoffice/nav-counts`, so a badge can never count a
 * different set than the page it opens (#1345). Pure: no Prisma client.
 */

// ── Tickets ─────────────────────────────────────────────────────────────

export interface TicketListFilters {
  status?: SupportTicketStatus | null;
  priority?: SupportPriority | null;
  issueType?: SupportIssueType | null;
  /** A user id, or "unassigned". */
  assignedToId?: string | null;
  search?: string | null;
}

export function ticketListWhere(
  f: TicketListFilters,
): Prisma.SupportTicketWhereInput {
  const where: Prisma.SupportTicketWhereInput = {};
  if (f.status) where.status = f.status;
  if (f.priority) where.priority = f.priority;
  if (f.issueType) where.issueType = f.issueType;
  if (f.assignedToId) {
    where.assignedToId =
      f.assignedToId === "unassigned" ? null : f.assignedToId;
  }
  if (f.search) {
    const search = f.search;
    where.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
      { id: { contains: search, mode: "insensitive" } },
      {
        user: {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
          ],
        },
      },
    ];
  }
  return where;
}

/** The Tickets badge: open and nobody has picked it up (the Unassigned view). */
export const TICKET_QUEUE_FILTERS: TicketListFilters = {
  status: "OPEN",
  assignedToId: "unassigned",
};

// ── Conversations ───────────────────────────────────────────────────────

/** A conversation is waiting on support while open or escalated. */
export const THREAD_QUEUE_STATUSES: SupportThreadStatus[] = [
  "OPEN",
  "ESCALATED",
];
export const THREAD_QUEUE_WHERE: Prisma.AppointmentSupportThreadWhereInput = {
  status: { in: THREAD_QUEUE_STATUSES },
};

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

/** Emails every retry gave up on; only an operator replays them. */
export const DEAD_LETTER_EMAIL_WHERE: Prisma.FailedEmailWhereInput = {
  status: "DEAD_LETTER",
};

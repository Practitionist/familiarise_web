import type {
  Prisma,
  SupportIssueType,
  SupportThreadCategory,
} from "@prisma/client";

/**
 * #1527 — one topic vocabulary across tickets and conversations. A ticket
 * carries a free `category` (escalations copy the thread's category into it)
 * and an `issueType`; a conversation carries a SupportThreadCategory. The
 * inbox filter, the category chip, the suggested articles and the saved
 * replies all read the topic, so the three taxonomies meet in one place.
 */

export const CASE_TOPICS = [
  "payments",
  "cancellation",
  "scheduling",
  "session",
  "removal",
  "technical",
  "recordings",
  "documents",
  "account",
  "organisation",
  "general",
  "other",
] as const;
export type CaseTopic = (typeof CASE_TOPICS)[number];

export const CASE_TOPIC_LABEL: Record<CaseTopic, string> = {
  payments: "Payments",
  cancellation: "Cancellation",
  scheduling: "Scheduling",
  session: "Session",
  removal: "Conduct removal",
  technical: "Technical",
  recordings: "Recordings",
  documents: "Documents",
  account: "Account",
  organisation: "Organisation",
  general: "General inquiry",
  other: "Other",
};

/** The case category a host's conduct removal opens for the removed attendee. */
export const CONDUCT_REMOVAL_CATEGORY = "CONDUCT_REMOVAL";

export function isCaseTopic(value: unknown): value is CaseTopic {
  return (CASE_TOPICS as readonly unknown[]).includes(value);
}

const THREAD_TOPIC: Record<SupportThreadCategory, CaseTopic> = {
  CANCEL_REFUND: "cancellation",
  RESCHEDULE: "scheduling",
  NO_SHOW: "session",
  TECHNICAL: "technical",
  DOCUMENTS: "documents",
  PAYMENT_STATUS: "payments",
  RECORDING_ACCESS: "recordings",
  QUALITY_COMPLAINT: "session",
  SPONSORSHIP_BILLING: "payments",
  ORG_ADMIN_DISPUTE: "organisation",
  SAFETY_CONCERN: "session",
  OTHER: "other",
};

const ISSUE_TOPIC: Record<SupportIssueType, CaseTopic> = {
  CONSULTANT_NO_SHOW: "session",
  CONSULTANT_LATE: "session",
  SESSION_ENDED_EARLY: "session",
  SESSION_QUALITY_POOR: "session",
  COMMUNICATION_ISSUE: "technical",
  TECHNICAL_ISSUES: "technical",
  WRONG_CONSULTANT: "session",
  ACCESS_ISSUE: "technical",
  TIMEZONE_CONFUSION: "scheduling",
  RESCHEDULING_HELP: "scheduling",
  PAYMENT_FAILED: "payments",
  CHARGED_TWICE: "payments",
  REFUND_REQUEST: "payments",
  BILLING_QUESTION: "payments",
  TAX_GST: "payments",
  TDS_CERTIFICATE: "payments",
  PAN_CARD_MISMATCH: "payments",
  DOCUMENT_ISSUE: "documents",
  WANT_TO_CANCEL: "cancellation",
  CANCELLATION_ISSUE: "cancellation",
  ACCOUNT_ISSUE: "account",
  GENERAL_INQUIRY: "general",
  OTHER: "other",
};

const THREAD_CATEGORIES = Object.keys(THREAD_TOPIC) as SupportThreadCategory[];

const isThreadCategory = (v: string): v is SupportThreadCategory =>
  v in THREAD_TOPIC;

export function threadTopic(category: string | null | undefined): CaseTopic {
  return category && isThreadCategory(category)
    ? THREAD_TOPIC[category]
    : "other";
}

/** A ticket's topic: its thread category when escalated, else its issue type. */
export function ticketTopic(ticket: {
  category: string | null;
  issueType: string | null;
}): CaseTopic {
  if (ticket.category === CONDUCT_REMOVAL_CATEGORY) return "removal";
  if (ticket.category && isThreadCategory(ticket.category)) {
    return THREAD_TOPIC[ticket.category];
  }
  if (ticket.issueType && ticket.issueType in ISSUE_TOPIC) {
    return ISSUE_TOPIC[ticket.issueType as SupportIssueType];
  }
  return "other";
}

const threadCategoriesOf = (topic: CaseTopic) =>
  THREAD_CATEGORIES.filter((c) => THREAD_TOPIC[c] === topic);

const issueTypesOf = (topic: CaseTopic) =>
  (Object.keys(ISSUE_TOPIC) as SupportIssueType[]).filter(
    (t) => ISSUE_TOPIC[t] === topic,
  );

/** Match the same category and issue precedence used by ticketTopic. */
export function supportCaseTopicWhere(
  topic: CaseTopic,
): Prisma.SupportCaseWhereInput {
  if (topic === "removal") return { category: CONDUCT_REMOVAL_CATEGORY };
  const byIssue: Prisma.SupportCaseWhereInput[] = [
    { issueType: { in: issueTypesOf(topic) } },
  ];
  if (topic === "other") byIssue.push({ issueType: null });
  return {
    OR: [
      { category: { in: threadCategoriesOf(topic) } },
      {
        AND: [
          {
            OR: [
              { category: null },
              {
                category: {
                  notIn: [...THREAD_CATEGORIES, CONDUCT_REMOVAL_CATEGORY],
                },
              },
            ],
          },
          { OR: byIssue },
        ],
      },
    ],
  };
}

/**
 * Where a case's booking card leads, and whether the page may read the booking's thread: a removed
 * learner holds no seat, so the booking page refuses them and their Cancelled list is where it lives now.
 */
export function caseBookingLink(
  topic: CaseTopic,
  appointmentsBase: string,
  appointmentId: string,
): { href: string; readsBooking: boolean } {
  return topic === "removal"
    ? { href: `${appointmentsBase}?tab=cancelled`, readsBooking: false }
    : { href: `${appointmentsBase}/${appointmentId}`, readsBooking: true };
}

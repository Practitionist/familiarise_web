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
  "technical",
  "recordings",
  "documents",
  "account",
  "organisation",
  "other",
] as const;
export type CaseTopic = (typeof CASE_TOPICS)[number];

export const CASE_TOPIC_LABEL: Record<CaseTopic, string> = {
  payments: "Payments",
  cancellation: "Cancellation",
  scheduling: "Scheduling",
  session: "Session",
  technical: "Technical",
  recordings: "Recordings",
  documents: "Documents",
  account: "Account",
  organisation: "Organisation",
  other: "Other",
};

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
  DOCUMENT_ISSUE: "documents",
  WANT_TO_CANCEL: "cancellation",
  CANCELLATION_ISSUE: "cancellation",
  ACCOUNT_ISSUE: "account",
  GENERAL_INQUIRY: "other",
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

/** The `where` that selects exactly the tickets `ticketTopic` files under `topic`. */
export function ticketTopicWhere(
  topic: CaseTopic,
): Prisma.SupportTicketWhereInput {
  const noThreadCategory: Prisma.SupportTicketWhereInput = {
    OR: [{ category: null }, { category: { notIn: THREAD_CATEGORIES } }],
  };
  const byIssue: Prisma.SupportTicketWhereInput[] = [
    { issueType: { in: issueTypesOf(topic) } },
  ];
  if (topic === "other") byIssue.push({ issueType: null });
  return {
    OR: [
      { category: { in: threadCategoriesOf(topic) } },
      { AND: [noThreadCategory, { OR: byIssue }] },
    ],
  };
}

export function threadTopicWhere(
  topic: CaseTopic,
): Prisma.AppointmentSupportThreadWhereInput {
  return { category: { in: threadCategoriesOf(topic) } };
}

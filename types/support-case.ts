import type { SupportChannel, SupportPriority } from "@prisma/client";

import type { UserSentryIssues } from "@/lib/observability/sentry-issues-types";
import type { CaseTopic } from "@/lib/support/case-topic";
import type { SlaState } from "@/lib/support/sla";

/** Dashboard support payloads use canonical case IDs and ISO timestamps. */

export type CaseAuthor = "USER" | "BOT" | "AGENT" | "SYSTEM";

/** A Help Center article a client can link without the corpus. */
export interface ArticleLink {
  title: string;
  href: string;
}

/**
 * The inbox's wire shapes are defined ONCE, by the Zod schema the client
 * parses the response with; these are the same shapes seen from the server.
 */
export type {
  InboxListResponse,
  InboxRow,
  InboxStats,
} from "@/schemas/support-inbox";

export interface TimelineItem {
  id: string;
  seq?: number;
  author: CaseAuthor;
  authorName: string | null;
  body: string;
  /** A private note: staff-only, never sent to the user. */
  internal: boolean;
  at: string;
}

export interface CaseBooking {
  appointmentId: string;
  kind: string;
  title: string;
  expertName: string | null;
  learnerName: string | null;
  firstStartsAt: string | null;
  lastStartsAt: string | null;
  status: string | null;
}

export interface CasePayment {
  id: string;
  /** Paise, named as Payment declares it. */
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
}

export interface CaseDuplicateRef {
  id: string;
  reference: string;
  title: string;
  status: string;
}

export interface CaseHistoryEvent {
  id: string;
  kind: string;
  fromValue: string | null;
  toValue: string | null;
  note: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface CaseWorkspace {
  key: string;
  kind: "case";
  caseId: string;
  subject: string;
  reference: string | null;
  topic: CaseTopic;
  status: string;
  priority: SupportPriority | null;
  channel: SupportChannel | null;
  assignee: { id: string; name: string | null } | null;
  sla: SlaState | null;
  ackDueAt: string | null;
  resolutionDueAt: string | null;
  lastMessageAt?: string | null;
  createdAt: string;
  updatedAt: string;
  handoffSummary?: string | null;
  botPromises?: string[];
  duplicateOpenCases?: CaseDuplicateRef[];
  events?: CaseHistoryEvent[];
  person: {
    id: string;
    name: string | null;
    role: string | null;
    email: string | null;
    phone: string | null;
    callbackRequested?: boolean;
    joinedAt: string;
  };
  booking: CaseBooking | null;
  payment: CasePayment | null;
  organization: { id: string; name: string } | null;
  pastCases: { key: string; subject: string; status: string; at: string }[];
  sentryIssues?: UserSentryIssues;
  timeline: TimelineItem[];
  hasMore?: boolean;
  nextBeforeSeq?: number | null;
  attachments: { id: string; name: string; url: string; size: number }[];
}

/** Customer case view: private notes are excluded before serialization. */
export interface OwnTicketCase {
  key: string;
  caseId: string;
  appointmentId?: string | null;
  filedByOrganizationNotice?: boolean;
  canReply?: boolean;
  subject: string;
  reference: string | null;
  topic: CaseTopic;
  status: string;
  ackDueAt?: string | null;
  resolvedAt?: string | null;
  /** Submitted as `{ rating }` to `/api/support/cases/[caseId]/csat`; returned as `csatRating`. */
  csatRating?: number | null;
  createdAt: string;
  payment: CasePayment | null;
  organization: { id: string; name: string } | null;
  timeline: TimelineItem[];
  hasMore?: boolean;
  nextBeforeSeq?: number | null;
}

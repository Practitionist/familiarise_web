import type { SupportChannel, SupportPriority } from "@prisma/client";
import type { FundingRail } from "@/lib/payments/funding-rail";

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

export interface InboxRow {
  key: string;
  kind: "case";
  scope: "session" | "platform";
  /** Name only: contact fields are on the case detail, never the list. */
  requester: {
    id: string;
    name: string | null;
    callbackRequested?: boolean;
  };
  subject: string;
  reference: string | null;
  topic: CaseTopic;
  status: string;
  priority: SupportPriority | null;
  channel: SupportChannel | null;
  sla: SlaState | null;
  assignee: { id: string; name: string | null } | null;
  lastActivityAt: string;
}

export interface InboxListResponse {
  rows: InboxRow[];
  total: number;
  page: number;
  pageSize: number;
  /** True when `total` runs past the deepest page the merge will read. */
  truncated: boolean;
}

export interface InboxStats {
  openCases: number;
  slaBreaches: number;
  avgFirstResponseMs: number | null;
  windowDays: number;
}

export interface TimelineItem {
  id: string;
  seq?: number;
  author: CaseAuthor;
  authorName: string | null;
  body: string;
  /** A private note: staff-only, never sent to the user. */
  internal: boolean;
  /** A provider reply that is not Familiarise support. */
  actorKind?: "PRESENTER";
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
  /** The requester's own seat on a class or webinar; null for a 1:1. */
  seatStatus: string | null;
  /** The payment and open-move facts the list status reads. */
  facts: CaseBookingFacts;
}

export interface CaseBookingFacts {
  source: string | null;
  /** The payment facts are absent when the reader lacks payments.read. */
  paid?: boolean;
  payDeadline?: string | null;
  payLapsed?: boolean;
  /** Landed refunds summed, as the lists show them; absent without payments.read. */
  refunded?: { paise: number; currency: string; at: string | null } | null;
  reschedule: {
    by: "CONSULTANT" | "REQUESTER";
    proposedStartsAt: string | null;
    originalStartsAt: string | null;
    expiresAt: string | null;
  } | null;
}

export interface CasePayment {
  id: string;
  /** Paise, named as Payment declares it. */
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
}

/** The staff view also names how the payment was funded: a credit-funded refund always returns the whole booking. */
export interface StaffCasePayment extends CasePayment {
  rail: FundingRail;
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
  /** Plain words for an event whose values are not staff copy (a removal's order marker). */
  summary: string | null;
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
  /** The deadline the SLA state is judged against: the stored one plus time waiting on the customer. */
  effectiveResolutionDueAt: string | null;
  /** A conduct removal's 72-hour decision deadline; null for every other case. */
  reviewDueAt: string | null;
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
  payment: StaffCasePayment | null;
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
  /** An accepted presenter on the linked booking: thread-only access, no CSAT or reopen. */
  viewerIsPresenter?: boolean;
  subject: string;
  reference: string | null;
  topic: CaseTopic;
  status: string;
  ackDueAt?: string | null;
  acknowledgedAt?: string | null;
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

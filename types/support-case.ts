import type { SupportChannel, SupportPriority } from "@prisma/client";

import type { CaseTopic } from "@/lib/support/case-topic";
import type { SlaState } from "@/lib/support/sla";

/**
 * #1527 — the Support inbox payloads, shaped on the server
 * (lib/support/case-read.ts) and rendered by the back-office inbox and the
 * user's request page. Dates are ISO strings.
 */

export type CaseAuthor = "USER" | "BOT" | "AGENT" | "SYSTEM";

/** A Help Center article a client can link without the corpus. */
export interface ArticleLink {
  title: string;
  href: string;
}

export interface InboxRow {
  key: string;
  kind: "ticket" | "thread";
  scope: "session" | "platform";
  requester: { id: string; name: string | null; email: string | null };
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

export interface CaseWorkspace {
  key: string;
  kind: "ticket" | "thread";
  ticketId: string | null;
  threadId: string | null;
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
  createdAt: string;
  person: {
    id: string;
    name: string | null;
    role: string | null;
    email: string | null;
    joinedAt: string;
  };
  booking: CaseBooking | null;
  payment: CasePayment | null;
  organization: { id: string; name: string } | null;
  pastCases: { key: string; subject: string; status: string; at: string }[];
  timeline: TimelineItem[];
  attachments: { id: string; name: string; url: string; size: number }[];
}

/** The requester's own view of a platform ticket: no private notes, ever. */
export interface OwnTicketCase {
  key: string;
  ticketId: string;
  subject: string;
  reference: string | null;
  topic: CaseTopic;
  status: string;
  createdAt: string;
  payment: CasePayment | null;
  organization: { id: string; name: string } | null;
  timeline: TimelineItem[];
}

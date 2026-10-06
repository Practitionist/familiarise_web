import type {
  Prisma,
  SupportPriority,
  SupportThreadStatus,
  SupportTicketStatus,
} from "@prisma/client";

import {
  isCaseTopic,
  threadTopicWhere,
  ticketTopicWhere,
  type CaseTopic,
} from "./case-topic";
import { slaStateOf, type SlaClock } from "./sla";

/**
 * Back-office Support inbox: one list of CASES over two tables.
 * A case is a ticket (platform, or escalated with its thread folded in) or a
 * conversation that has not been escalated yet (`supportTicketId: null`), so
 * an escalated conversation appears once, as its ticket.
 */

export const INBOX_VIEWS = [
  "needs-reply",
  "sla-at-risk",
  "mine",
  "unassigned",
  "self-serve",
  "all",
] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

export const INBOX_VIEW_LABEL: Record<InboxView, string> = {
  "needs-reply": "Needs reply",
  "sla-at-risk": "SLA at risk",
  mine: "Mine",
  unassigned: "Unassigned",
  "self-serve": "Self-serve only",
  all: "All",
};

export const INBOX_SORTS = ["activity", "sla"] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];

export const INBOX_SCOPES = ["session", "platform"] as const;
export type InboxScope = (typeof INBOX_SCOPES)[number];

/** Union of both status enums; each table filters on the values it has. */
export const INBOX_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "ON_HOLD",
  "ESCALATED",
  "RESOLVED",
  "CLOSED",
] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

const PRIORITIES: readonly SupportPriority[] = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "URGENT",
];

/** The URL keys the inbox's views and filters live under (useListParams). */
export const INBOX_FILTER_KEYS = [
  "view",
  "sort",
  "scope",
  "status",
  "priority",
  "topic",
  "from",
  "to",
] as const;
export type InboxFilterKey = (typeof INBOX_FILTER_KEYS)[number];

export const INBOX_PAGE_SIZE = 25;
/** Deepest row a page may reach; the merge reads skip+take from each table. */
export const INBOX_MAX_DEPTH = 1000;

export interface InboxFilters {
  view: InboxView;
  sort: InboxSort;
  scope: InboxScope | null;
  status: InboxStatus | null;
  priority: SupportPriority | null;
  topic: CaseTopic | null;
  q: string | null;
  /** createdAt window, inclusive days. */
  from: Date | null;
  to: Date | null;
  viewerId: string;
}

const oneOf = <T extends string>(list: readonly T[], v: string | null) =>
  v && (list as readonly string[]).includes(v) ? (v as T) : null;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function day(v: string | null, endOfDay: boolean): Date | null {
  if (!v || !DAY_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return endOfDay ? new Date(d.getTime() + 86_400_000) : d;
}

export function parseInboxFilters(
  get: (key: string) => string | null,
  viewerId: string,
): InboxFilters {
  const topic = get("topic");
  const view = oneOf(INBOX_VIEWS, get("view")) ?? "needs-reply";
  const requestedSort = oneOf(INBOX_SORTS, get("sort"));
  return {
    view,
    sort: requestedSort ?? (view === "sla-at-risk" ? "sla" : "activity"),
    scope: oneOf(INBOX_SCOPES, get("scope")),
    status: oneOf(INBOX_STATUSES, get("status")),
    priority: oneOf(PRIORITIES, get("priority")),
    topic: isCaseTopic(topic) ? topic : null,
    q: get("q")?.trim().slice(0, 100) || null,
    from: day(get("from"), false),
    to: day(get("to"), true),
    viewerId,
  };
}

const SETTLED_TICKET: SupportTicketStatus[] = ["RESOLVED", "CLOSED"];
const SETTLED_THREAD: SupportThreadStatus[] = ["RESOLVED", "CLOSED"];
const TICKET_STATUSES = new Set<string>([
  "OPEN",
  "IN_PROGRESS",
  "ON_HOLD",
  "RESOLVED",
  "CLOSED",
]);
const THREAD_STATUSES = new Set<string>([
  "OPEN",
  "IN_PROGRESS",
  "ESCALATED",
  "RESOLVED",
  "CLOSED",
]);

/** The ball is in our court: unsettled and not waiting on the user. */
export const TICKET_NEEDS_REPLY_WHERE: Prisma.SupportTicketWhereInput = {
  status: { in: ["OPEN", "IN_PROGRESS"] },
  awaitingUserSince: null,
};

/** Tickets still being worked: the "open cases" stat and the Mine/Unassigned base. */
export const TICKET_OPEN_WHERE: Prisma.SupportTicketWhereInput = {
  status: { notIn: SETTLED_TICKET },
};

/** A conversation that has not been escalated (else its ticket is the case). */
export const THREAD_CASE_WHERE: Prisma.AppointmentSupportThreadWhereInput = {
  supportTicketId: null,
};

export const THREAD_OPEN_WHERE: Prisma.AppointmentSupportThreadWhereInput = {
  ...THREAD_CASE_WHERE,
  status: { notIn: SETTLED_THREAD },
};

function range(f: InboxFilters) {
  if (!f.from && !f.to) return null;
  return {
    createdAt: {
      ...(f.from ? { gte: f.from } : {}),
      ...(f.to ? { lt: f.to } : {}),
    },
  };
}

export function inboxTicketWhere(
  f: InboxFilters,
): Prisma.SupportTicketWhereInput | null {
  if (f.view === "self-serve") return null;
  if (f.status && !TICKET_STATUSES.has(f.status)) return null;
  const and: Prisma.SupportTicketWhereInput[] = [];
  if (f.view === "needs-reply") and.push(TICKET_NEEDS_REPLY_WHERE);
  if (f.view === "sla-at-risk") {
    and.push(TICKET_OPEN_WHERE);
    and.push({
      awaitingUserSince: null,
      OR: [{ ackDueAt: { not: null } }, { resolutionDueAt: { not: null } }],
    });
  }
  if (f.view === "mine") and.push({ assignedToId: f.viewerId });
  if (f.view === "unassigned") and.push({ assignedToId: null });
  // Mine/Unassigned are work queues: settled cases drop out unless asked for.
  if ((f.view === "mine" || f.view === "unassigned") && !f.status) {
    and.push(TICKET_OPEN_WHERE);
  }
  if (f.status) and.push({ status: f.status as SupportTicketStatus });
  if (f.priority) and.push({ priority: f.priority });
  if (f.topic) and.push(ticketTopicWhere(f.topic));
  if (f.scope === "session") {
    and.push({ appointmentSupportThread: { isNot: null } });
  }
  if (f.scope === "platform") {
    and.push({ appointmentSupportThread: { is: null } });
  }
  const window = range(f);
  if (window) and.push(window);
  if (f.q) {
    const contains = { contains: f.q, mode: "insensitive" as const };
    and.push({
      OR: [
        { title: contains },
        { description: contains },
        { referenceNumber: contains },
        { id: contains },
        { user: { OR: [{ name: contains }, { email: contains }] } },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

export function inboxThreadWhere(
  f: InboxFilters,
): Prisma.AppointmentSupportThreadWhereInput | null {
  // Conversations are never assigned, carry no priority, and do not have
  // statutory ticket SLA clocks; a platform case is not about a booking.
  if (
    f.view === "mine" ||
    f.view === "unassigned" ||
    f.view === "sla-at-risk"
  ) {
    return null;
  }
  if (f.priority || f.scope === "platform") return null;
  if (f.status && !THREAD_STATUSES.has(f.status)) return null;
  const and: Prisma.AppointmentSupportThreadWhereInput[] = [THREAD_CASE_WHERE];
  // A person took over but no ticket holds it (the link was cleared).
  if (f.view === "needs-reply") {
    and.push({ activeChannel: "HUMAN", status: { notIn: SETTLED_THREAD } });
  }
  if (f.view === "self-serve") {
    and.push({ activeChannel: { not: "HUMAN" } });
    if (!f.status) and.push({ status: { notIn: SETTLED_THREAD } });
  }
  if (f.status) and.push({ status: f.status as SupportThreadStatus });
  if (f.topic) and.push(threadTopicWhere(f.topic));
  const window = range(f);
  if (window) and.push(window);
  if (f.q) {
    const contains = { contains: f.q, mode: "insensitive" as const };
    and.push({
      OR: [
        { id: contains },
        { appointmentId: contains },
        { user: { OR: [{ name: contains }, { email: contains }] } },
      ],
    });
  }
  return { AND: and };
}

/** The nav badge: the default view, with no filters. */
export function inboxBadgeFilters(viewerId: string): InboxFilters {
  return parseInboxFilters(() => null, viewerId);
}

// ── Merging two sorted lists ────────────────────────────────────────────

export interface SortKey {
  key: string;
  lastMessageAt: Date | null;
  createdAt: Date;
  ackDueAt?: Date | null;
  resolutionDueAt?: Date | null;
}

/** Both reads order by this, so the merge reproduces a single ORDER BY. */
export const CASE_ORDER_BY = [
  { lastMessageAt: { sort: "desc", nulls: "last" } },
  { createdAt: "desc" },
  { id: "desc" },
] as const;

export const SLA_ORDER_BY = [
  { ackDueAt: { sort: "asc", nulls: "last" } },
  { resolutionDueAt: { sort: "asc", nulls: "last" } },
  { createdAt: "asc" },
  { id: "asc" },
] as const;

/** Mirrors CASE_ORDER_BY: latest activity first, never-active rows last. */
export function compareCases(a: SortKey, b: SortKey): number {
  if (Boolean(a.lastMessageAt) !== Boolean(b.lastMessageAt))
    return a.lastMessageAt ? -1 : 1;
  const byLast =
    (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0);
  if (byLast !== 0) return byLast;
  const byCreated = b.createdAt.getTime() - a.createdAt.getTime();
  if (byCreated !== 0) return byCreated;
  if (a.key === b.key) return 0;
  return a.key < b.key ? 1 : -1;
}

export function compareCasesBySla(a: SortKey, b: SortKey): number {
  const aAck = a.ackDueAt ?? null;
  const bAck = b.ackDueAt ?? null;
  if (Boolean(aAck) !== Boolean(bAck)) return aAck ? -1 : 1;
  if (aAck && bAck) {
    const diff = aAck.getTime() - bAck.getTime();
    if (diff !== 0) return diff;
  }
  const aRes = a.resolutionDueAt ?? null;
  const bRes = b.resolutionDueAt ?? null;
  if (Boolean(aRes) !== Boolean(bRes)) return aRes ? -1 : 1;
  if (aRes && bRes) {
    const diff = aRes.getTime() - bRes.getTime();
    if (diff !== 0) return diff;
  }
  const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
  if (byCreated !== 0) return byCreated;
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}

/** One page of the union, given each table's first `skip + take` rows in order. */
export function mergeCasePage<T extends SortKey>(
  a: readonly T[],
  b: readonly T[],
  skip: number,
  take: number,
  sort: InboxSort = "activity",
): T[] {
  const cmp = sort === "sla" ? compareCasesBySla : compareCases;
  return [...a, ...b].sort(cmp).slice(skip, skip + take);
}

// ── Team stats ──────────────────────────────────────────────────────────

export const STATS_WINDOW_DAYS = 7;

/** Mean of (first staff public reply − creation); null with no replies. */
export function averageFirstResponseMs(
  rows: readonly { createdAt: Date; firstAgentReplyAt: Date | null }[],
): number | null {
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    if (!r.firstAgentReplyAt) continue;
    sum += Math.max(0, r.firstAgentReplyAt.getTime() - r.createdAt.getTime());
    n += 1;
  }
  return n ? Math.round(sum / n) : null;
}

/** Candidates whose raw deadline passed; the pause can only push it later. */
export function slaCandidateWhere(now: Date): Prisma.SupportTicketWhereInput {
  return {
    ...TICKET_OPEN_WHERE,
    resolvedAt: null,
    OR: [
      { acknowledgedAt: null, ackDueAt: { lt: now } },
      { resolutionDueAt: { lt: now } },
    ],
  };
}

export function countSlaBreaches(
  rows: readonly SlaClock[],
  now: Date = new Date(),
): number {
  return rows.filter((r) => {
    const s = slaStateOf(r, now);
    return s.ackBreached || s.resolutionBreached;
  }).length;
}

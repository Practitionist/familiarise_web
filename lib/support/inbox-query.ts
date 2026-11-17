import type {
  Prisma,
  SupportPriority,
  SupportCaseStatus,
} from "@prisma/client";

import {
  isCaseTopic,
  supportCaseTopicWhere,
  type CaseTopic,
} from "./case-topic";
import { slaStateOf, type SlaClock } from "./sla";
import { fromOperatorWallTime } from "@/lib/time/operator-zone";

/**
 * Back-office Support inbox filters over the canonical SupportCase table.
 */

export const INBOX_VIEWS = [
  "needs-reply",
  "sla-at-risk",
  "evidence-overdue",
  "financial-pending",
  "appeals",
  "mine",
  "unassigned",
  "self-serve",
  "all",
] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

export const INBOX_VIEW_LABEL: Record<InboxView, string> = {
  "needs-reply": "Needs reply",
  "sla-at-risk": "SLA at risk",
  "evidence-overdue": "Evidence overdue",
  "financial-pending": "Financial recommendation pending",
  appeals: "Appeals",
  mine: "Mine",
  unassigned: "Unassigned",
  "self-serve": "Self-serve only",
  all: "All",
};

export const INBOX_SORTS = ["activity", "sla"] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];

export const INBOX_SCOPES = ["session", "platform"] as const;
export type InboxScope = (typeof INBOX_SCOPES)[number];

/** Supported canonical lifecycle statuses. */
export const INBOX_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
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
/** Deepest row a page may reach. */
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
/** A `YYYY-MM-DD` filter day cut at 00:00 IST, the day the operator picked; `endOfDay` is the next IST midnight. */
function day(v: string | null, endOfDay: boolean): Date | null {
  if (!v || !DAY_RE.test(v)) return null;
  const d = fromOperatorWallTime(`${v}T00:00`);
  if (!d) return null;
  // India keeps +05:30 all year, so its days are exactly 24 hours long.
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
    sort:
      requestedSort ??
      (view === "needs-reply" || view === "sla-at-risk" ? "sla" : "activity"),
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

const SETTLED: SupportCaseStatus[] = ["RESOLVED", "CLOSED"];

export const CASE_OPEN_WHERE: Prisma.SupportCaseWhereInput = {
  deletedAt: null,
  status: { notIn: SETTLED },
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

export const SLA_ACK_AT_RISK_MS = 6 * 3_600_000;
export const SLA_RESOLUTION_AT_RISK_MS = 12 * 3_600_000;

function inboxViewWhere(
  f: InboxFilters,
  now: Date,
  statutoryBinds: Prisma.SupportCaseWhereInput,
): Prisma.SupportCaseWhereInput[] {
  switch (f.view) {
    case "needs-reply":
      return [
        CASE_OPEN_WHERE,
        { activeChannel: "HUMAN", awaitingUserSince: null },
      ];
    case "evidence-overdue":
      return [
        CASE_OPEN_WHERE,
        {
          evidenceRequests: {
            some: { dueAt: { lte: now }, respondedAt: null, cancelledAt: null },
          },
        },
      ];
    case "financial-pending":
      return [{ recommendations: { some: { decidedAt: null } } }];
    case "appeals":
      return [
        {
          OR: [
            { appealOfDecisionId: { not: null } },
            { appealOfModerationActionId: { not: null } },
          ],
        },
      ];
    case "sla-at-risk":
      return [
        CASE_OPEN_WHERE,
        {
          OR: [
            {
              statutoryDueAt: {
                lte: new Date(now.getTime() + SLA_RESOLUTION_AT_RISK_MS),
              },
              ...statutoryBinds,
            },
            {
              acknowledgedAt: null,
              ackDueAt: { lte: new Date(now.getTime() + SLA_ACK_AT_RISK_MS) },
            },
            {
              resolutionDueAt: {
                lte: new Date(now.getTime() + SLA_RESOLUTION_AT_RISK_MS),
              },
            },
          ],
        },
      ];
    case "mine":
      return [{ assignedToId: f.viewerId }];
    case "unassigned":
      return [{ assignedToId: null, activeChannel: "HUMAN" }];
    case "self-serve":
      return [{ activeChannel: "SELF_SERVE" }];
    case "all":
      return [];
  }
}

/**
 * `statutoryBinds` narrows the statutory arm to cases the date still binds; the
 * server reader passes the column comparison, which needs the Prisma client.
 */
export function inboxCaseWhere(
  f: InboxFilters,
  now: Date = new Date(),
  statutoryBinds: Prisma.SupportCaseWhereInput = {},
): Prisma.SupportCaseWhereInput {
  const and: Prisma.SupportCaseWhereInput[] = [
    { deletedAt: null },
    ...inboxViewWhere(f, now, statutoryBinds),
  ];
  if (["mine", "unassigned", "self-serve"].includes(f.view) && !f.status)
    and.push(CASE_OPEN_WHERE);
  if (f.status) and.push({ status: f.status });
  if (f.priority) and.push({ priority: f.priority });
  if (f.topic) and.push(supportCaseTopicWhere(f.topic));
  if (f.scope === "session") and.push({ appointmentId: { not: null } });
  if (f.scope === "platform") and.push({ appointmentId: null });
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
        { requester: { OR: [{ name: contains }, { email: contains }] } },
      ],
    });
  }
  return { AND: and };
}

/** The nav badge: the default view, with no filters. */
export function inboxBadgeFilters(viewerId: string): InboxFilters {
  return parseInboxFilters(() => null, viewerId);
}

// ── Inbox ordering ────────────────────────────────────────────

export interface SortKey {
  key: string;
  lastMessageAt: Date | null;
  createdAt: Date;
  acknowledgedAt?: Date | null;
  ackDueAt?: Date | null;
  resolutionDueAt?: Date | null;
  statutoryDueAt?: Date | null;
  reopenedAt?: Date | null;
}

/** Deterministic activity order shared by inbox pages. */
export const CASE_ORDER_BY = [
  { lastMessageAt: { sort: "desc", nulls: "last" } },
  { createdAt: "desc" },
  { id: "desc" },
] as const;

export function compareCasesBySla(a: SortKey, b: SortKey): number {
  const aAck = a.acknowledgedAt ? null : (a.ackDueAt ?? null);
  const bAck = b.acknowledgedAt ? null : (b.ackDueAt ?? null);
  if (Boolean(aAck) !== Boolean(bAck)) return aAck ? -1 : 1;
  if (aAck && bAck) {
    const diff = aAck.getTime() - bAck.getTime();
    if (diff !== 0) return diff;
  }
  // A case reopened after its statutory date ranks by its new target, as its badge reads.
  const earliest = (row: SortKey) => {
    const reopenedPastStatutory =
      row.reopenedAt && row.statutoryDueAt && row.resolutionDueAt
        ? row.reopenedAt.getTime() > row.statutoryDueAt.getTime()
        : false;
    return (
      [row.resolutionDueAt, reopenedPastStatutory ? null : row.statutoryDueAt]
        .filter((date): date is Date => Boolean(date))
        .sort((left, right) => left.getTime() - right.getTime())[0] ?? null
    );
  };
  const aRes = earliest(a);
  const bRes = earliest(b);
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
export function slaCandidateWhere(now: Date): Prisma.SupportCaseWhereInput {
  return {
    ...CASE_OPEN_WHERE,
    resolvedAt: null,
    OR: [
      { acknowledgedAt: null, ackDueAt: { lt: now } },
      { resolutionDueAt: { lt: now } },
      { statutoryDueAt: { lt: now } },
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

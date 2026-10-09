import type { Prisma, UserRole } from "@prisma/client";

import prisma from "@/lib/prisma";
import type {
  InboxListResponse,
  InboxRow,
  InboxStats,
} from "@/types/support-case";

import { extractCallbackInfo } from "./callback-info";
import { caseKeyOf } from "./case-key";
import { threadTopic, ticketTopic } from "./case-topic";
import {
  CASE_ORDER_BY,
  INBOX_MAX_DEPTH,
  INBOX_PAGE_SIZE,
  STATS_WINDOW_DAYS,
  THREAD_OPEN_WHERE,
  TICKET_OPEN_WHERE,
  averageFirstResponseMs,
  countSlaBreaches,
  inboxBadgeFilters,
  inboxThreadWhere,
  inboxTicketWhere,
  mergeCasePage,
  slaCandidateWhere,
  type InboxFilters,
} from "./inbox-query";
import { slaStateOf } from "./sla";

export { extractCallbackInfo } from "./callback-info";

const STATS_ROW_CAP = 5000;

const orderBy: Prisma.SupportTicketOrderByWithRelationInput[] = [
  ...CASE_ORDER_BY,
];
const threadOrderBy: Prisma.AppointmentSupportThreadOrderByWithRelationInput[] =
  [...CASE_ORDER_BY];

export const SLA_SELECT = {
  status: true,
  ackDueAt: true,
  acknowledgedAt: true,
  resolutionDueAt: true,
  resolvedAt: true,
  awaitingUserSince: true,
  pausedSeconds: true,
} as const;

export const PLAN_TITLE_SELECT = {
  appointmentType: true,
  consultation: { select: { consultationPlan: { select: { title: true } } } },
  subscription: { select: { subscriptionPlan: { select: { title: true } } } },
  webinar: { select: { webinarPlan: { select: { title: true } } } },
  class: { select: { classPlan: { select: { title: true } } } },
  trial: { select: { subscriptionPlan: { select: { title: true } } } },
} as const;

type PlanTitled = Prisma.AppointmentGetPayload<{
  select: typeof PLAN_TITLE_SELECT;
}>;

export function planTitle(a: PlanTitled): string {
  return (
    a.consultation?.consultationPlan?.title ??
    a.subscription?.subscriptionPlan?.title ??
    a.webinar?.webinarPlan?.title ??
    a.class?.classPlan?.title ??
    a.trial?.subscriptionPlan?.title ??
    "Session"
  );
}

// ── The list ────────────────────────────────────────────────────────────

function toCaseRequester(
  u: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    role: UserRole;
  },
  showEmail: boolean,
): InboxRow["requester"] {
  return {
    id: u.id,
    name: u.name,
    email: showEmail ? u.email : null,
    phone: null,
  };
}

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
} as const;

const TICKET_ROW_SELECT = {
  id: true,
  referenceNumber: true,
  title: true,
  description: true,
  priority: true,
  category: true,
  issueType: true,
  createdAt: true,
  lastMessageAt: true,
  ...SLA_SELECT,
  user: { select: USER_SELECT },
  assignedTo: { select: { id: true, name: true } },
  appointmentSupportThread: { select: { id: true } },
} as const;

const THREAD_ROW_SELECT = {
  id: true,
  status: true,
  activeChannel: true,
  category: true,
  createdAt: true,
  lastMessageAt: true,
  user: { select: USER_SELECT },
  appointment: { select: PLAN_TITLE_SELECT },
} as const;

type TicketInboxSource = Prisma.SupportTicketGetPayload<{
  select: typeof TICKET_ROW_SELECT;
}>;
type ThreadInboxSource = Prisma.AppointmentSupportThreadGetPayload<{
  select: typeof THREAD_ROW_SELECT;
}>;

function ticketToInboxRow(
  t: TicketInboxSource,
  showEmail: boolean,
  now: Date,
): InboxRow {
  const callback = extractCallbackInfo(t.description, t.user.phone);
  return {
    key: caseKeyOf({ kind: "ticket", id: t.id }),
    kind: "ticket",
    scope: t.appointmentSupportThread ? "session" : "platform",
    requester: {
      ...toCaseRequester(t.user, showEmail),
      phone: null,
      callbackRequested: callback.callbackRequested,
    },
    subject: t.title,
    reference: t.referenceNumber,
    topic: ticketTopic(t),
    status: t.status,
    priority: t.priority,
    channel: null,
    sla: slaStateOf(
      { ...t, ackDueAt: t.acknowledgedAt ? null : t.ackDueAt },
      now,
    ),
    assignee: t.assignedTo,
    lastActivityAt: (t.lastMessageAt ?? t.createdAt).toISOString(),
  };
}

function threadToInboxRow(t: ThreadInboxSource, showEmail: boolean): InboxRow {
  return {
    key: caseKeyOf({ kind: "thread", id: t.id }),
    kind: "thread",
    scope: "session",
    requester: toCaseRequester(t.user, showEmail),
    subject: `Help with ${planTitle(t.appointment)}`,
    reference: null,
    topic: threadTopic(t.category),
    status: t.status,
    priority: null,
    channel: t.activeChannel,
    sla: null,
    assignee: null,
    lastActivityAt: (t.lastMessageAt ?? t.createdAt).toISOString(),
  };
}

const ticketKeySelect = {
  id: true,
  lastMessageAt: true,
  createdAt: true,
  acknowledgedAt: true,
  ackDueAt: true,
  resolutionDueAt: true,
} as const;

/**
 * Two reads whose DB orders each agree with `compareCasesBySla`: a single
 * `ackDueAt` order would rank acknowledged tickets by a deadline the comparator ignores.
 */
async function readTicketKeysBySla(
  ticketWhere: Prisma.SupportTicketWhereInput,
  depth: number,
) {
  const [awaitingAck, rest] = await Promise.all([
    prisma.supportTicket.findMany({
      where: {
        AND: [
          ticketWhere,
          { acknowledgedAt: null },
          { ackDueAt: { not: null } },
        ],
      },
      orderBy: [
        { ackDueAt: "asc" },
        { resolutionDueAt: { sort: "asc", nulls: "last" } },
        { createdAt: "asc" },
        { id: "asc" },
      ],
      take: depth,
      select: ticketKeySelect,
    }),
    prisma.supportTicket.findMany({
      where: {
        AND: [
          ticketWhere,
          { OR: [{ acknowledgedAt: { not: null } }, { ackDueAt: null }] },
        ],
      },
      orderBy: [
        { resolutionDueAt: { sort: "asc", nulls: "last" } },
        { createdAt: "asc" },
        { id: "asc" },
      ],
      take: depth,
      select: ticketKeySelect,
    }),
  ]);
  return [...awaitingAck, ...rest];
}

export async function readInboxPage(
  filters: InboxFilters,
  page: number,
  opts: { showEmail: boolean },
): Promise<InboxListResponse> {
  const pageSize = INBOX_PAGE_SIZE;
  const skip = Math.min((Math.max(1, page) - 1) * pageSize, INBOX_MAX_DEPTH);
  const depth = skip + pageSize;
  const ticketWhere = inboxTicketWhere(filters);
  const threadWhere = inboxThreadWhere(filters);
  const threadKeySelect = {
    id: true,
    lastMessageAt: true,
    createdAt: true,
  } as const;

  const [ticketKeys, threadKeys, ticketTotal, threadTotal] = await Promise.all([
    ticketWhere
      ? filters.sort === "sla"
        ? readTicketKeysBySla(ticketWhere, depth)
        : prisma.supportTicket.findMany({
            where: ticketWhere,
            orderBy,
            take: depth,
            select: ticketKeySelect,
          })
      : [],
    threadWhere
      ? prisma.appointmentSupportThread.findMany({
          where: threadWhere,
          orderBy:
            filters.sort === "sla"
              ? [{ createdAt: "asc" }, { id: "asc" }]
              : threadOrderBy,
          take: depth,
          select: threadKeySelect,
        })
      : [],
    ticketWhere ? prisma.supportTicket.count({ where: ticketWhere }) : 0,
    threadWhere
      ? prisma.appointmentSupportThread.count({ where: threadWhere })
      : 0,
  ]);

  const pageKeys = mergeCasePage(
    ticketKeys.map((t) => ({
      ...t,
      ackDueAt: t.acknowledgedAt ? null : t.ackDueAt,
      key: caseKeyOf({ kind: "ticket", id: t.id }),
    })),
    threadKeys.map((t) => ({
      ...t,
      key: caseKeyOf({ kind: "thread", id: t.id }),
    })),
    skip,
    pageSize,
    filters.sort,
  );
  const ticketIds = pageKeys
    .filter((k) => k.key.startsWith("t_"))
    .map((k) => k.id);
  const threadIds = pageKeys
    .filter((k) => k.key.startsWith("s_"))
    .map((k) => k.id);

  const [tickets, threads] = await Promise.all([
    ticketIds.length
      ? prisma.supportTicket.findMany({
          where: { id: { in: ticketIds } },
          select: TICKET_ROW_SELECT,
        })
      : [],
    threadIds.length
      ? prisma.appointmentSupportThread.findMany({
          where: { id: { in: threadIds } },
          select: THREAD_ROW_SELECT,
        })
      : [],
  ]);

  const now = new Date();
  const byKey = new Map<string, InboxRow>();
  for (const t of tickets) {
    byKey.set(
      caseKeyOf({ kind: "ticket", id: t.id }),
      ticketToInboxRow(t, opts.showEmail, now),
    );
  }
  for (const t of threads) {
    byKey.set(
      caseKeyOf({ kind: "thread", id: t.id }),
      threadToInboxRow(t, opts.showEmail),
    );
  }

  const total = ticketTotal + threadTotal;
  return {
    rows: pageKeys.flatMap((k) => byKey.get(k.key) ?? []),
    total: Math.min(total, INBOX_MAX_DEPTH + pageSize),
    page: Math.floor(skip / pageSize) + 1,
    pageSize,
    truncated: total > INBOX_MAX_DEPTH + pageSize,
  };
}

/** The nav badge: exactly the default (Needs reply) view's total (#1345). */
export function inboxBadgeCountReads(viewerId: string) {
  const f = inboxBadgeFilters(viewerId);
  const ticketWhere = inboxTicketWhere(f) ?? { id: { in: [] } };
  const threadWhere = inboxThreadWhere(f) ?? { id: { in: [] } };
  return [
    prisma.supportTicket.count({ where: ticketWhere }),
    prisma.appointmentSupportThread.count({ where: threadWhere }),
  ] as const;
}

// ── Team stats ──────────────────────────────────────────────────────────

export async function readInboxStats(now = new Date()): Promise<InboxStats> {
  const since = new Date(now.getTime() - STATS_WINDOW_DAYS * 86_400_000);
  const [openTickets, openThreads, slaRows, replied] = await Promise.all([
    prisma.supportTicket.count({ where: TICKET_OPEN_WHERE }),
    prisma.appointmentSupportThread.count({ where: THREAD_OPEN_WHERE }),
    prisma.supportTicket.findMany({
      where: slaCandidateWhere(now),
      select: SLA_SELECT,
      take: STATS_ROW_CAP,
    }),
    prisma.supportTicket.findMany({
      where: { firstAgentReplyAt: { gte: since } },
      select: { createdAt: true, firstAgentReplyAt: true },
      take: STATS_ROW_CAP,
    }),
  ]);
  return {
    openCases: openTickets + openThreads,
    slaBreaches: countSlaBreaches(slaRows, now),
    avgFirstResponseMs: averageFirstResponseMs(replied),
    windowDays: STATS_WINDOW_DAYS,
  };
}

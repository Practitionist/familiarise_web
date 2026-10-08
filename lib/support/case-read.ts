import type { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import type {
  InboxListResponse,
  InboxRow,
  InboxStats,
} from "@/types/support-case";

import { caseKeyOf } from "./case-key";
import { threadTopic, ticketTopic } from "./case-topic";
import {
  CASE_ORDER_BY,
  INBOX_MAX_DEPTH,
  INBOX_PAGE_SIZE,
  SLA_ORDER_BY,
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

const STATS_ROW_CAP = 5000;

const orderBy: Prisma.SupportTicketOrderByWithRelationInput[] = [
  ...CASE_ORDER_BY,
];
const slaOrderBy: Prisma.SupportTicketOrderByWithRelationInput[] = [
  ...SLA_ORDER_BY,
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

const CALLBACK_TAG_RE = /\[Callback Requested:\s*([^\]]+)\]/i;

/** Parse an explicit callback phone tag from ticket/message bodies or fall back to user.phone. */
export function extractCallbackInfo(
  texts: readonly (string | null | undefined)[],
  fallbackPhone?: string | null,
): { phone: string | null; callbackRequested: boolean } {
  for (const text of texts) {
    if (!text) continue;
    const match = CALLBACK_TAG_RE.exec(text);
    if (match?.[1]?.trim()) {
      return { phone: match[1].trim(), callbackRequested: true };
    }
  }
  const cleanFallback = fallbackPhone?.trim() || null;
  return { phone: cleanFallback, callbackRequested: false };
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
  const ticketKeySelect = {
    id: true,
    lastMessageAt: true,
    createdAt: true,
    acknowledgedAt: true,
    ackDueAt: true,
    resolutionDueAt: true,
  } as const;
  const threadKeySelect = {
    id: true,
    lastMessageAt: true,
    createdAt: true,
  } as const;

  const [ticketKeys, threadKeys, ticketTotal, threadTotal] = await Promise.all([
    ticketWhere
      ? prisma.supportTicket.findMany({
          where: ticketWhere,
          orderBy: filters.sort === "sla" ? slaOrderBy : orderBy,
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

  const userSelect = {
    id: true,
    name: true,
    email: true,
    phone: true,
  } as const;
  const [tickets, threads] = await Promise.all([
    ticketIds.length
      ? prisma.supportTicket.findMany({
          where: { id: { in: ticketIds } },
          select: {
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
            user: { select: userSelect },
            assignedTo: { select: { id: true, name: true } },
            appointmentSupportThread: { select: { id: true } },
          },
        })
      : [],
    threadIds.length
      ? prisma.appointmentSupportThread.findMany({
          where: { id: { in: threadIds } },
          select: {
            id: true,
            status: true,
            activeChannel: true,
            category: true,
            createdAt: true,
            lastMessageAt: true,
            user: { select: userSelect },
            appointment: { select: PLAN_TITLE_SELECT },
          },
        })
      : [],
  ]);

  const now = new Date();
  const byKey = new Map<string, InboxRow>();
  for (const t of tickets) {
    const callback = extractCallbackInfo([t.description], t.user.phone);
    const requester = {
      id: t.user.id,
      name: t.user.name,
      email: opts.showEmail ? t.user.email : null,
      phone: callback.phone,
    };
    byKey.set(caseKeyOf({ kind: "ticket", id: t.id }), {
      key: caseKeyOf({ kind: "ticket", id: t.id }),
      kind: "ticket",
      scope: t.appointmentSupportThread ? "session" : "platform",
      requester,
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
    });
  }
  for (const t of threads) {
    const requester = {
      id: t.user.id,
      name: t.user.name,
      email: opts.showEmail ? t.user.email : null,
      phone: t.user.phone,
    };
    byKey.set(caseKeyOf({ kind: "thread", id: t.id }), {
      key: caseKeyOf({ kind: "thread", id: t.id }),
      kind: "thread",
      scope: "session",
      requester,
      subject: `Help with ${planTitle(t.appointment)}`,
      reference: null,
      topic: threadTopic(t.category),
      status: t.status,
      priority: null,
      channel: t.activeChannel,
      sla: null,
      assignee: null,
      lastActivityAt: (t.lastMessageAt ?? t.createdAt).toISOString(),
    });
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

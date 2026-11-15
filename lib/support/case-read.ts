import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import type {
  InboxListResponse,
  InboxRow,
  InboxStats,
} from "@/types/support-case";
import { caseKeyOf } from "./case-key";
import { ticketTopic } from "./case-topic";
import {
  CASE_OPEN_WHERE,
  CASE_ORDER_BY,
  INBOX_MAX_DEPTH,
  INBOX_PAGE_SIZE,
  STATS_WINDOW_DAYS,
  averageFirstResponseMs,
  compareCasesBySla,
  countSlaBreaches,
  inboxBadgeFilters,
  inboxCaseWhere,
  slaCandidateWhere,
  type InboxFilters,
} from "./inbox-query";
import { slaStateOf } from "./sla";
export { extractCallbackInfo } from "./callback-info";

/** A case reopened after its statutory date works to its new target, so that date no longer puts it at risk. */
function statutoryStillBinds(): Prisma.SupportCaseWhereInput {
  return {
    OR: [
      { reopenedAt: null },
      { reopenedAt: { lte: prisma.supportCase.fields.statutoryDueAt } },
    ],
  };
}

/** The inbox predicate both the page and its nav badge read. */
function inboxWhere(filters: InboxFilters): Prisma.SupportCaseWhereInput {
  return inboxCaseWhere(filters, new Date(), statutoryStillBinds());
}

export const SLA_SELECT = {
  status: true,
  ackDueAt: true,
  acknowledgedAt: true,
  resolutionDueAt: true,
  statutoryDueAt: true,
  resolvedAt: true,
  reopenedAt: true,
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

const ROW_SELECT = {
  id: true,
  title: true,
  referenceNumber: true,
  category: true,
  issueType: true,
  priority: true,
  activeChannel: true,
  appointmentId: true,
  callbackPhone: true,
  createdAt: true,
  lastMessageAt: true,
  ...SLA_SELECT,
  externalRequesterName: true,
  requester: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
} satisfies Prisma.SupportCaseSelect;

export async function readInboxPage(
  filters: InboxFilters,
  page: number,
): Promise<InboxListResponse> {
  const skip = Math.min(
    (Math.max(1, page) - 1) * INBOX_PAGE_SIZE,
    INBOX_MAX_DEPTH,
  );
  const where = inboxWhere(filters);
  const totalRead = prisma.supportCase.count({ where });
  const depth = skip + INBOX_PAGE_SIZE;
  const keySelect = {
    id: true,
    createdAt: true,
    lastMessageAt: true,
    acknowledgedAt: true,
    ackDueAt: true,
    resolutionDueAt: true,
    statutoryDueAt: true,
    reopenedAt: true,
  } as const;
  const rowsRead =
    filters.sort === "sla"
      ? (async () => {
          // Acknowledged cases rank by resolution; their old acknowledgement deadline cannot reorder them.
          const [awaitingAck, rest, statutory] = await Promise.all([
            prisma.supportCase.findMany({
              where: {
                AND: [where, { acknowledgedAt: null, ackDueAt: { not: null } }],
              },
              orderBy: [
                { ackDueAt: "asc" },
                { resolutionDueAt: { sort: "asc", nulls: "last" } },
                { createdAt: "asc" },
                { id: "asc" },
              ],
              take: depth,
              select: keySelect,
            }),
            prisma.supportCase.findMany({
              where: {
                AND: [
                  where,
                  {
                    OR: [{ acknowledgedAt: { not: null } }, { ackDueAt: null }],
                  },
                ],
              },
              orderBy: [
                { resolutionDueAt: { sort: "asc", nulls: "last" } },
                { createdAt: "asc" },
                { id: "asc" },
              ],
              take: depth,
              select: keySelect,
            }),
            prisma.supportCase.findMany({
              where: { AND: [where, { statutoryDueAt: { not: null } }] },
              orderBy: [
                { statutoryDueAt: "asc" },
                { createdAt: "asc" },
                { id: "asc" },
              ],
              take: depth,
              select: keySelect,
            }),
          ]);
          const keys = [
            ...new Map(
              [...awaitingAck, ...rest, ...statutory].map((row) => [
                row.id,
                row,
              ]),
            ).values(),
          ]
            .map((c) => ({ ...c, key: c.id }))
            .sort(compareCasesBySla)
            .slice(skip, skip + INBOX_PAGE_SIZE);
          if (!keys.length) return [];
          const cases = await prisma.supportCase.findMany({
            where: { id: { in: keys.map((c) => c.id) }, deletedAt: null },
            select: ROW_SELECT,
          });
          const byId = new Map(cases.map((c) => [c.id, c]));
          return keys.flatMap((c) => byId.get(c.id) ?? []);
        })()
      : prisma.supportCase.findMany({
          where,
          orderBy: [...CASE_ORDER_BY],
          skip,
          take: INBOX_PAGE_SIZE,
          select: ROW_SELECT,
        });
  const [cases, total] = await Promise.all([rowsRead, totalRead]);
  const rows: InboxRow[] = cases.map((c) => ({
    key: caseKeyOf({ kind: "case", id: c.id }),
    kind: "case",
    scope: c.appointmentId ? "session" : "platform",
    requester: {
      // Spelled out rather than spread: a list row names the requester only,
      // and contact fields belong to the case detail. The projection, not the
      // query's select, is what keeps them out of the inbox.
      id: c.requester.id,
      name: c.externalRequesterName ?? c.requester.name,
      callbackRequested: Boolean(c.callbackPhone),
    },
    subject: c.title,
    reference: c.referenceNumber,
    topic: ticketTopic(c),
    status: c.status,
    priority: c.priority,
    channel: c.activeChannel,
    sla: slaStateOf(c),
    assignee: c.assignedTo,
    lastActivityAt: (c.lastMessageAt ?? c.createdAt).toISOString(),
  }));
  return {
    rows,
    total: Math.min(total, INBOX_MAX_DEPTH + INBOX_PAGE_SIZE),
    page: Math.floor(skip / INBOX_PAGE_SIZE) + 1,
    pageSize: INBOX_PAGE_SIZE,
    truncated: total > INBOX_MAX_DEPTH + INBOX_PAGE_SIZE,
  };
}

export function inboxBadgeCountReads(viewerId: string) {
  return [
    prisma.supportCase.count({
      where: inboxWhere(inboxBadgeFilters(viewerId)),
    }),
  ] as const;
}

export async function readInboxStats(now = new Date()): Promise<InboxStats> {
  const since = new Date(now.getTime() - STATS_WINDOW_DAYS * 86_400_000);
  const [openCases, slaRows, replied] = await Promise.all([
    prisma.supportCase.count({ where: CASE_OPEN_WHERE }),
    prisma.supportCase.findMany({
      where: slaCandidateWhere(now),
      select: SLA_SELECT,
      take: 5000,
    }),
    prisma.supportCase.findMany({
      where: { deletedAt: null, firstAgentReplyAt: { gte: since } },
      select: { createdAt: true, receivedAt: true, firstAgentReplyAt: true },
      take: 5000,
    }),
  ]);
  return {
    openCases,
    slaBreaches: countSlaBreaches(slaRows, now),
    avgFirstResponseMs: averageFirstResponseMs(
      replied.map((supportCase) => ({
        ...supportCase,
        createdAt: supportCase.receivedAt ?? supportCase.createdAt,
      })),
    ),
    windowDays: STATS_WINDOW_DAYS,
  };
}

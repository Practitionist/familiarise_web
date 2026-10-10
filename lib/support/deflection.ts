/**
 * #705 — recording, and reading, whether the tree actually helps.
 *
 * The deflection rate ("what fraction of conversations resolve without a
 * person") is the number every published support system tracks and the one this
 * subsystem could not produce, even retrospectively: platform-scope
 * resolutions wrote nothing at all.
 *
 * Read it with the caveat the research is unanimous about — deflection alone
 * scores a user who gave up exactly like a user who was helped. `recontactRate`
 * is the companion that catches that, and the two are meant to be read
 * together.
 */

import prisma from "@/lib/prisma";
import type { Prisma, SupportFlowOutcomeKind } from "@prisma/client";
import type { Tx } from "@/lib/prisma";

export interface FlowOutcomeInput {
  scope: "APPOINTMENT" | "PLATFORM";
  flowKey: string;
  terminalNodeId?: string | null;
  reason?: string | null;
  outcome: SupportFlowOutcomeKind;
  userId: string;
  organizationId?: string | null;
}

/**
 * Record one terminal turn. Never throws: an analytics row must not be able to
 * roll back the support turn that produced it, or a metric outage becomes a
 * support outage. Pass a `tx` when the caller already has one and WANTS the row
 * to share its fate.
 */
export async function recordFlowOutcome(
  input: FlowOutcomeInput,
  tx?: Tx,
): Promise<string | null> {
  const data = {
    scope: input.scope,
    flowKey: input.flowKey,
    terminalNodeId: input.terminalNodeId ?? null,
    reason: input.reason ?? null,
    outcome: input.outcome,
    userId: input.userId,
    organizationId: input.organizationId ?? null,
  };
  if (tx) {
    const row = await tx.supportFlowOutcome.create({
      data,
      select: { id: true },
    });
    return row.id;
  }
  try {
    const row = await prisma.supportFlowOutcome.create({
      data,
      select: { id: true },
    });
    return row.id;
  } catch (error) {
    console.error("support: failed to record flow outcome", { data, error });
    return null;
  }
}

/** Record user rating on a self-serve outcome once via compare-and-set on helpfulRating IS NULL. */
export async function rateFlowOutcome(
  outcomeId: string,
  userId: string,
  rating: number,
): Promise<{ updated: boolean }> {
  const updated = await prisma.supportFlowOutcome.updateMany({
    where: { id: outcomeId, userId, helpfulRating: null },
    data: { helpfulRating: rating },
  });
  return { updated: updated.count > 0 };
}

export interface DeflectionSummary {
  resolved: number;
  escalated: number;
  total: number;
  /** Null rather than 0 when nothing happened — 0% deflection and no traffic
   *  are different facts, and a dashboard that conflates them lies. */
  deflectionRate: number | null;
  resolvedUsers: number;
  recontactedUsers: number;
  recontactRate7d: number | null;
}

const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;

export async function deflectionSince(
  since: Date,
  where: Prisma.SupportFlowOutcomeWhereInput = {},
): Promise<DeflectionSummary> {
  const rows = await prisma.supportFlowOutcome.groupBy({
    by: ["outcome"],
    where: { ...where, createdAt: { gte: since } },
    _count: { _all: true },
  });
  const count = (kind: SupportFlowOutcomeKind) =>
    rows.find((r) => r.outcome === kind)?._count._all ?? 0;
  const resolved = count("RESOLVED");
  const escalated = count("ESCALATED");
  const total = resolved + escalated;

  const resolvedRows = await prisma.supportFlowOutcome.findMany({
    where: { ...where, outcome: "RESOLVED", createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { id: true, userId: true, createdAt: true },
  });

  const firstResolvedByUser = new Map<string, { id: string; at: Date }>();
  for (const r of resolvedRows) {
    if (!firstResolvedByUser.has(r.userId)) {
      firstResolvedByUser.set(r.userId, { id: r.id, at: r.createdAt });
    }
  }

  const userIds = [...firstResolvedByUser.keys()];
  const resolvedUsers = userIds.length;
  let recontactedUsers = 0;

  if (resolvedUsers > 0) {
    const earliestAt = resolvedRows[0].createdAt;
    const [subsequentOutcomes, subsequentCases, subsequentTickets] =
      await Promise.all([
        prisma.supportFlowOutcome.findMany({
          where: {
            userId: { in: userIds },
            createdAt: { gt: earliestAt },
          },
          select: { id: true, userId: true, createdAt: true },
        }),
        prisma.supportCase.findMany({
          where: {
            requesterUserId: { in: userIds },
            createdAt: { gt: earliestAt },
            deletedAt: null,
          },
          select: { requesterUserId: true, createdAt: true },
        }),
        prisma.supportTicket.findMany({
          where: {
            userId: { in: userIds },
            createdAt: { gt: earliestAt },
          },
          select: { userId: true, createdAt: true },
        }),
      ]);

    const recontacted = new Set<string>();
    for (const o of subsequentOutcomes) {
      const first = firstResolvedByUser.get(o.userId);
      if (
        first &&
        o.id !== first.id &&
        o.createdAt.getTime() > first.at.getTime() &&
        o.createdAt.getTime() - first.at.getTime() <= SEVEN_DAYS_MS
      ) {
        recontacted.add(o.userId);
      }
    }
    for (const c of subsequentCases) {
      const first = firstResolvedByUser.get(c.requesterUserId);
      if (
        first &&
        c.createdAt.getTime() > first.at.getTime() &&
        c.createdAt.getTime() - first.at.getTime() <= SEVEN_DAYS_MS
      ) {
        recontacted.add(c.requesterUserId);
      }
    }
    for (const t of subsequentTickets) {
      const first = firstResolvedByUser.get(t.userId);
      if (
        first &&
        t.createdAt.getTime() > first.at.getTime() &&
        t.createdAt.getTime() - first.at.getTime() <= SEVEN_DAYS_MS
      ) {
        recontacted.add(t.userId);
      }
    }
    recontactedUsers = recontacted.size;
  }

  return {
    resolved,
    escalated,
    total,
    deflectionRate: total ? Math.round((resolved / total) * 1000) / 10 : null,
    resolvedUsers,
    recontactedUsers,
    recontactRate7d: resolvedUsers
      ? Math.round((recontactedUsers / resolvedUsers) * 1000) / 10
      : null,
  };
}

export interface SupportHealthMetrics extends DeflectionSummary {
  csatAverage: number | null;
  csatCount: number;
  ackWithin24hRate: number | null;
  disposedWithin15dRate: number | null;
  medianFirstReplyMinutes: number | null;
}

export async function supportHealthMetrics(
  since: Date,
  now: Date = new Date(),
): Promise<SupportHealthMetrics> {
  const [deflection, cases, tickets] = await Promise.all([
    deflectionSince(since),
    prisma.supportCase.findMany({
      where: { createdAt: { gte: since }, deletedAt: null },
      select: {
        createdAt: true,
        acknowledgedAt: true,
        resolvedAt: true,
        pausedSeconds: true,
        firstAgentReplyAt: true,
        csatRating: true,
      },
    }),
    prisma.supportTicket.findMany({
      where: { createdAt: { gte: since } },
      select: {
        createdAt: true,
        acknowledgedAt: true,
        resolvedAt: true,
        pausedSeconds: true,
        firstAgentReplyAt: true,
      },
    }),
  ]);

  const ratings = cases
    .map((c) => c.csatRating)
    .filter((r): r is number => r !== null);
  const csatCount = ratings.length;
  const csatAverage =
    csatCount > 0
      ? Math.round((ratings.reduce((a, b) => a + b, 0) / csatCount) * 100) / 100
      : null;

  const ackMissCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const combined = [...cases, ...tickets];
  const ackEvaluatedRows = combined.filter(
    (r) =>
      r.acknowledgedAt !== null ||
      r.createdAt.getTime() <= ackMissCutoff.getTime(),
  );
  const ackWithin24h = ackEvaluatedRows.filter(
    (r) =>
      r.acknowledgedAt !== null &&
      r.acknowledgedAt.getTime() - r.createdAt.getTime() <= 24 * 3_600_000,
  ).length;
  const ackWithin24hRate =
    ackEvaluatedRows.length > 0
      ? Math.round((ackWithin24h / ackEvaluatedRows.length) * 1000) / 10
      : null;

  const resolvedRows = combined.filter((r) => r.resolvedAt !== null);
  const disposedWithin15d = resolvedRows.filter(
    (r) =>
      r.resolvedAt!.getTime() -
        r.createdAt.getTime() -
        r.pausedSeconds * 1000 <=
      15 * 24 * 3_600_000,
  ).length;
  const disposedWithin15dRate =
    resolvedRows.length > 0
      ? Math.round((disposedWithin15d / resolvedRows.length) * 1000) / 10
      : null;

  const firstReplyMinutes = combined
    .filter((r) => r.firstAgentReplyAt !== null)
    .map(
      (r) => (r.firstAgentReplyAt!.getTime() - r.createdAt.getTime()) / 60_000,
    )
    .sort((a, b) => a - b);
  const medianFirstReplyMinutes =
    firstReplyMinutes.length > 0
      ? Math.round(firstReplyMinutes[Math.floor(firstReplyMinutes.length / 2)])
      : null;

  return {
    ...deflection,
    csatAverage,
    csatCount,
    ackWithin24hRate,
    disposedWithin15dRate,
    medianFirstReplyMinutes,
  };
}

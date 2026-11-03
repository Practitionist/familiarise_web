/**
 * The SLA-sweep arm for case-linked chat access: ends expired grants and
 * grants on cases resolved by writers outside the staff funnel, retries the
 * Stream join, leave and channel lock, and sends (or records withholding) the post-decision
 * "we reviewed messages" notice through the durable outbox. Each step is
 * bounded and commits on its own; failures go to the shared `errors`.
 */

import type { Prisma } from "@prisma/client";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
  type PrismaLike,
} from "@/lib/prisma";
import type { StagedTrigger } from "@/lib/novu/outbox";
import {
  joinIntervention,
  leaveIntervention,
} from "@/lib/stream/support-intervention";
import { syncSupportBoundary } from "@/lib/stream/support-boundary";
import { endChatGrantTx } from "./chat-access-end";
import { CHAT_REVIEWED_STATUS, stagePartyBells } from "./chat-notices";

/** A join this young may still be running in the door's after-commit task. */
const JOIN_RETRY_AFTER_MS = 2 * 60_000;
/** Channels whose interventions started or ended this recently are re-locked or unlocked every run. */
const BOUNDARY_RECHECK_MS = 3_600_000;
const CLOSED_STATUSES = ["RESOLVED", "CLOSED"] as const;
const TX = {
  maxWait: ALLOCATION_TX_MAX_WAIT_MS,
  timeout: ALLOCATION_TX_TIMEOUT_MS,
};

export interface ChatAccessSweepResult {
  ended: number;
  joined: number;
  left: number;
  boundaries: number;
  notices: number;
}

/** Live grants that expired or whose case is closed or deleted. */
function dueGrantWhere(now: Date): Prisma.SupportCaseChatAccessWhereInput {
  return {
    endedAt: null,
    OR: [
      { expiresAt: { lte: now } },
      { supportCase: { status: { in: [...CLOSED_STATUSES] } } },
      { supportCase: { deletedAt: { not: null } } },
    ],
  };
}

/** Ended interventions still seated in the Stream channel. */
const PENDING_LEAVE_WHERE: Prisma.SupportCaseChatAccessWhereInput = {
  kind: "INTERVENE",
  endedAt: { not: null },
  streamJoinedAt: { not: null },
  streamLeftAt: null,
};

function recentBoundaryWhere(
  now: Date,
): Prisma.SupportCaseChatAccessWhereInput {
  const since = new Date(now.getTime() - BOUNDARY_RECHECK_MS);
  return {
    kind: "INTERVENE",
    OR: [{ createdAt: { gte: since } }, { endedAt: { gte: since } }],
  };
}

/** Live interventions whose Stream join has not landed past the after-commit window. */
function joinRetryWhere(now: Date): Prisma.SupportCaseChatAccessWhereInput {
  return {
    kind: "INTERVENE",
    endedAt: null,
    streamJoinedAt: null,
    expiresAt: { gt: now },
    createdAt: { lt: new Date(now.getTime() - JOIN_RETRY_AFTER_MS) },
  };
}

/** Ended grants on a closed case with no live grant left, not yet noticed. */
const REVIEW_NOTICE_WHERE: Prisma.SupportCaseChatAccessWhereInput = {
  endedAt: { not: null },
  reviewNoticeAt: null,
  supportCase: {
    status: { in: [...CLOSED_STATUSES] },
    deletedAt: null,
    chatAccess: { none: { endedAt: null } },
  },
};

/** The chat arm of the SLA sweep's idle probe: one statement over every step's selector. */
export async function hasChatAccessWork(
  db: PrismaLike,
  now: Date,
): Promise<boolean> {
  const row = await db.supportCaseChatAccess.findFirst({
    where: {
      OR: [
        dueGrantWhere(now),
        PENDING_LEAVE_WHERE,
        recentBoundaryWhere(now),
        joinRetryWhere(now),
        REVIEW_NOTICE_WHERE,
      ],
    },
    select: { id: true },
  });
  return row !== null;
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

async function endDueGrants(limit: number, now: Date, errors: string[]) {
  const due = await prisma.supportCaseChatAccess.findMany({
    where: dueGrantWhere(now),
    orderBy: { expiresAt: "asc" },
    take: limit,
    select: {
      id: true,
      caseId: true,
      kind: true,
      supportCase: { select: { status: true, deletedAt: true } },
    },
  });
  let ended = 0;
  for (const grant of due) {
    const caseOver =
      grant.supportCase.deletedAt !== null ||
      (CLOSED_STATUSES as readonly string[]).includes(grant.supportCase.status);
    try {
      const done = await prisma.$transaction(
        (tx) =>
          endChatGrantTx(tx, grant, {
            actorId: null,
            reason: caseOver ? "CASE_RESOLVED" : "EXPIRED",
            now,
          }),
        TX,
      );
      if (done) ended += 1;
    } catch (err) {
      errors.push(`chat-access end ${grant.id}: ${message(err)}`);
    }
  }
  return ended;
}

async function leaveEndedInterventions(limit: number, errors: string[]) {
  const pending = await prisma.supportCaseChatAccess.findMany({
    where: PENDING_LEAVE_WHERE,
    orderBy: { endedAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let left = 0;
  for (const grant of pending) {
    try {
      if ((await leaveIntervention(grant.id)) !== "skipped") left += 1;
    } catch (err) {
      errors.push(`chat-access leave ${grant.id}: ${message(err)}`);
    }
  }
  return left;
}

/**
 * Backstop for the after-commit channel lock and unlock: a missed call, or a
 * start racing an end on the same channel, converges here.
 */
async function syncRecentBoundaries(
  limit: number,
  now: Date,
  errors: string[],
) {
  const recent = await prisma.supportCaseChatAccess.findMany({
    where: recentBoundaryWhere(now),
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { channelType: true, channelId: true },
  });
  const channels = new Map(
    recent.map((g) => [`${g.channelType}:${g.channelId}`, g] as const),
  );
  let synced = 0;
  for (const [cid, g] of channels) {
    try {
      const outcome = await syncSupportBoundary(
        g.channelType,
        g.channelId,
        now,
      );
      if (outcome !== "gone") synced += 1;
    } catch (err) {
      errors.push(`chat-access boundary ${cid}: ${message(err)}`);
    }
  }
  return synced;
}

async function retryJoins(limit: number, now: Date, errors: string[]) {
  const pending = await prisma.supportCaseChatAccess.findMany({
    where: joinRetryWhere(now),
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, caseId: true, kind: true },
  });
  let joined = 0;
  for (const grant of pending) {
    try {
      const outcome = await joinIntervention(grant.id, now);
      if (outcome === "joined") joined += 1;
      // Retention deleted the channel: nothing left to sit in. A frozen channel may thaw, so it retries.
      if (outcome === "gone")
        await prisma.$transaction(
          (tx) =>
            endChatGrantTx(tx, grant, {
              actorId: null,
              reason: "CHANNEL_GONE",
              now,
            }),
          TX,
        );
    } catch (err) {
      errors.push(`chat-access join ${grant.id}: ${message(err)}`);
    }
  }
  return joined;
}

/**
 * After the case is resolved or closed, tells the people in the scope of its
 * ended grants that our team reviewed messages, once per batch of grants. A
 * grant marked `withholdNotice` withholds the whole batch; both outcomes are
 * stamped and recorded as CHAT_REVIEW_NOTIFIED.
 */
async function sendReviewNotices(
  limit: number,
  now: Date,
  errors: string[],
  stagedBells: StagedTrigger[],
) {
  const pending = await prisma.supportCaseChatAccess.findMany({
    where: REVIEW_NOTICE_WHERE,
    orderBy: { endedAt: "asc" },
    take: limit * 4,
    select: { caseId: true },
  });
  const caseIds = [...new Set(pending.map((g) => g.caseId))].slice(0, limit);
  let notices = 0;
  for (const caseId of caseIds) {
    try {
      const staged = await prisma.$transaction(async (tx) => {
        const grants = await tx.supportCaseChatAccess.findMany({
          where: { caseId, endedAt: { not: null }, reviewNoticeAt: null },
          orderBy: { createdAt: "asc" },
          select: { id: true, scopeUserIds: true, withholdNotice: true },
        });
        if (grants.length === 0) return null;
        const stamped = await tx.supportCaseChatAccess.updateMany({
          where: { id: { in: grants.map((g) => g.id) }, reviewNoticeAt: null },
          data: { reviewNoticeAt: now },
        });
        if (stamped.count !== grants.length)
          throw new Error("review notice raced another sweep");
        const withheld = grants.some((g) => g.withholdNotice);
        const supportCase = await tx.supportCase.findUniqueOrThrow({
          where: { id: caseId },
          select: {
            id: true,
            referenceNumber: true,
            organizationId: true,
            ownershipScope: true,
            submitterUserId: true,
            externalRequesterEmail: true,
          },
        });
        const bells = withheld
          ? []
          : await stagePartyBells(
              tx,
              supportCase,
              [...new Set(grants.flatMap((g) => g.scopeUserIds))],
              CHAT_REVIEWED_STATUS,
              `chat-reviewed:${grants[0].id}`,
            );
        await tx.supportCaseEvent.create({
          data: {
            caseId,
            kind: "CHAT_REVIEW_NOTIFIED",
            toValue: grants[0].id,
            note: withheld ? "withheld" : `sent (${grants.length} grant(s))`,
            createdAt: now,
          },
        });
        return bells;
      }, TX);
      if (staged) {
        notices += 1;
        stagedBells.push(...staged);
      }
    } catch (err) {
      errors.push(`chat-access notice ${caseId}: ${message(err)}`);
    }
  }
  return notices;
}

export async function sweepSupportChatAccess({
  limit,
  now,
  errors,
  stagedBells,
}: {
  limit: number;
  now: Date;
  errors: string[];
  stagedBells: StagedTrigger[];
}): Promise<ChatAccessSweepResult> {
  const result: ChatAccessSweepResult = {
    ended: 0,
    joined: 0,
    left: 0,
    boundaries: 0,
    notices: 0,
  };
  if (limit <= 0) return result;
  const steps: [keyof ChatAccessSweepResult, () => Promise<number>][] = [
    ["ended", () => endDueGrants(limit, now, errors)],
    ["left", () => leaveEndedInterventions(limit, errors)],
    // After ends and leaves, before join retries: Support is only seated in a locked channel.
    ["boundaries", () => syncRecentBoundaries(limit, now, errors)],
    ["joined", () => retryJoins(limit, now, errors)],
    ["notices", () => sendReviewNotices(limit, now, errors, stagedBells)],
  ];
  for (const [key, step] of steps) {
    try {
      result[key] = await step();
    } catch (err) {
      errors.push(`chat-access ${key} scan: ${message(err)}`);
    }
  }
  return result;
}

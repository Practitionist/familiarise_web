/**
 * The SLA-sweep arm for host conduct removals. A removal waits PENDING_REVIEW
 * on its support case:
 *   - once the case is resolved or closed, the removal is UPHELD, or OVERTURNED
 *     when a refund went out to the attendee after it (staff refund through the
 *     existing refund door; the case lifecycle releases the earnings hold);
 *   - if support has not resolved the case by its deadline, the attendee is
 *     refunded in full, the hold is released and the removal is OVERTURNED, so
 *     the host never keeps a consumer's money on an unreviewed removal.
 * Each removal commits on its own; failures go to the shared `errors`.
 */

import type { Prisma } from "@prisma/client";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
  type PrismaLike,
} from "@/lib/prisma";
import { refundRemovedAttendeeSeat } from "@/lib/payments/operations/event-refunds";
import { stageBell } from "@/lib/novu/stage-bell";
import type { StagedTrigger } from "@/lib/novu/outbox";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import { caseKeyOf } from "./case-key";
import { releaseAllCaseHolds } from "./case-holds";

const CLOSED_STATUSES = ["RESOLVED", "CLOSED"] as const;
const TX = {
  maxWait: ALLOCATION_TX_MAX_WAIT_MS,
  timeout: ALLOCATION_TX_TIMEOUT_MS,
};

export interface RemovalReviewSweepResult {
  decided: number;
  refundedOnDeadline: number;
}

const decidedWhere: Prisma.ParticipantRemovalWhereInput = {
  status: "PENDING_REVIEW",
  supportCase: { is: { status: { in: [...CLOSED_STATUSES] } } },
};

function overdueWhere(now: Date): Prisma.ParticipantRemovalWhereInput {
  return {
    status: "PENDING_REVIEW",
    supportCase: {
      is: {
        deletedAt: null,
        status: { notIn: [...CLOSED_STATUSES] },
        resolutionDueAt: { lt: now },
      },
    },
  };
}

/** Ticker idle probe: any removal waiting on a decision or past its deadline. */
export async function hasRemovalReviewWork(
  db: PrismaLike,
  now: Date,
): Promise<boolean> {
  const row = await db.participantRemoval.findFirst({
    where: { OR: [decidedWhere, overdueWhere(now)] },
    select: { id: true },
  });
  return row !== null;
}

const REMOVAL_SELECT = {
  id: true,
  userId: true,
  appointmentId: true,
  createdAt: true,
  supportCaseId: true,
  appointment: {
    select: {
      webinar: { select: { id: true } },
      class: { select: { id: true } },
    },
  },
} satisfies Prisma.ParticipantRemovalSelect;

type RemovalRow = Prisma.ParticipantRemovalGetPayload<{
  select: typeof REMOVAL_SELECT;
}>;

/** Refunds the attendee's seat has received since the removal. */
function refundsSince(removal: RemovalRow): Promise<number> {
  return prisma.refund.count({
    where: {
      status: { in: ["PENDING", "SUCCEEDED"] },
      createdAt: { gte: removal.createdAt },
      payment: {
        userId: removal.userId,
        appointmentId: removal.appointmentId,
      },
    },
  });
}

async function settleDecided(removal: RemovalRow): Promise<void> {
  const status = (await refundsSince(removal)) > 0 ? "OVERTURNED" : "UPHELD";
  await prisma.participantRemoval.updateMany({
    where: { id: removal.id, status: "PENDING_REVIEW" },
    data: { status, decidedAt: new Date() },
  });
}

async function refundOnDeadline(
  removal: RemovalRow,
  stagedBells: StagedTrigger[],
): Promise<boolean> {
  const event = removal.appointment.webinar
    ? { kind: "webinar" as const, id: removal.appointment.webinar.id }
    : removal.appointment.class
      ? { kind: "class" as const, id: removal.appointment.class.id }
      : null;
  const paid = await prisma.payment.count({
    where: {
      userId: removal.userId,
      appointmentId: removal.appointmentId,
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
    },
  });
  if (event && paid > 0 && (await refundsSince(removal)) === 0) {
    // Never throws; the refund is confirmed by reading it back below.
    await refundRemovedAttendeeSeat({
      kind: event.kind,
      eventId: event.id,
      attendeeUserId: removal.userId,
      initiatedByUserId: null,
      mode: "full",
      dedupeKey: `removal-review:${removal.id}`,
    });
    if ((await refundsSince(removal)) === 0) return false;
  }

  await prisma.$transaction(async (tx) => {
    const moved = await tx.participantRemoval.updateMany({
      where: { id: removal.id, status: "PENDING_REVIEW" },
      data: { status: "OVERTURNED", decidedAt: new Date() },
    });
    if (moved.count === 0 || !removal.supportCaseId) return;
    await releaseAllCaseHolds(tx, {
      caseId: removal.supportCaseId,
      actorId: null,
      note: "Released: support did not decide in time, so the attendee was refunded in full",
    });
    const { messageSeq } = await tx.supportCase.update({
      where: { id: removal.supportCaseId },
      data: { messageSeq: { increment: 1 }, lastMessageAt: new Date() },
      select: { messageSeq: true },
    });
    await tx.supportCaseMessage.create({
      data: {
        caseId: removal.supportCaseId,
        seq: messageSeq,
        sender: "SYSTEM",
        isInternal: false,
        body: "Support did not review this removal within the target time, so your payment has been refunded in full.",
      },
    });
    const bell = await stageBell(tx, {
      workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
      recipients: [removal.userId],
      dedupeKey: `removal-review:${removal.id}:refunded`,
      entityRef: `removal-review:${removal.id}`,
      payload: {
        ticketId: removal.supportCaseId,
        ticketTitle: "Removed from a group session",
        status: "Refunded in full",
        dashboardUrl: supportRequestHref(
          caseKeyOf({ kind: "case", id: removal.supportCaseId }),
          null,
        ),
        ...notificationScope(null),
      },
    });
    if (bell) stagedBells.push(bell);
  }, TX);
  return true;
}

/** Settles decided removals and refunds the overdue ones, a bounded batch per run. */
export async function sweepRemovalReviews(opts: {
  limit: number;
  now: Date;
  errors: string[];
  stagedBells: StagedTrigger[];
}): Promise<RemovalReviewSweepResult> {
  const result: RemovalReviewSweepResult = {
    decided: 0,
    refundedOnDeadline: 0,
  };
  const decided = await prisma.participantRemoval.findMany({
    where: decidedWhere,
    take: opts.limit,
    orderBy: { createdAt: "asc" },
    select: REMOVAL_SELECT,
  });
  for (const removal of decided) {
    try {
      await settleDecided(removal);
      result.decided += 1;
    } catch (error) {
      opts.errors.push(
        `removal-review ${removal.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const overdue = await prisma.participantRemoval.findMany({
    where: overdueWhere(opts.now),
    take: opts.limit,
    orderBy: { createdAt: "asc" },
    select: REMOVAL_SELECT,
  });
  for (const removal of overdue) {
    try {
      if (await refundOnDeadline(removal, opts.stagedBells)) {
        result.refundedOnDeadline += 1;
      } else {
        opts.errors.push(
          `removal-review ${removal.id}: deadline refund did not land`,
        );
      }
    } catch (error) {
      opts.errors.push(
        `removal-review ${removal.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}

/**
 * The support side of a host's conduct removal: the case it opens for the
 * removed attendee, the seat earnings it holds, what an overturn or a missed
 * review deadline owes, and the sweep arm that enforces the deadline.
 */

import type { Prisma } from "@prisma/client";

import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
  type PrismaLike,
  type Tx,
} from "@/lib/prisma";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { isPriceFreePayment } from "@/lib/payments/funding-rail";
import { refundRemovedAttendeeSeat } from "@/lib/payments/operations/event-refunds";
import {
  driveRefundOwed,
  markerFromRow,
  REFUND_OWED_SELECT,
  stampOwedOrHeld,
  stampRefundOwed,
  type RefundOwedMarker,
} from "@/lib/payments/operations/refund-owed";
import {
  persistConductBlockInTx,
  syncConductCallBlock,
} from "@/lib/stream/access-revocation";
import { holdPaymentForCase } from "./case-holds";
import { stageSupportCaseIntakeTx } from "./case-service";
import { supportDeadline } from "./deadline-policy";
import { priorityForReason } from "./priority";
import { allocateTicketReference } from "./reference";
import { slaDeadlinesFor } from "./sla";
import {
  CONDUCT_REMOVAL_CATEGORY,
  CONDUCT_REMOVAL_REVIEW_HOURS,
  conductRemovalRefundKey,
  reviewedRemovalCaseId,
} from "./conduct-removal-state";

const HOUR_MS = 3_600_000;
const REMOVAL_CASE_TITLE = "Removed from a group session";

export interface OpenRemovalCaseInput {
  appointmentId: string;
  removedUserId: string;
  actorUserId: string;
  eventTitle: string | null;
  reasonLabel: string;
  note: string | null;
}

/** What the host recorded; the removed attendee adds their side as replies. */
export function removalCaseBody(input: {
  eventTitle: string | null;
  reasonLabel: string;
  note: string | null;
}): string {
  const lines = [
    `The host removed you from ${input.eventTitle ?? "a group session"}.`,
    `Reason recorded: ${input.reasonLabel}`,
  ];
  if (input.note) lines.push(`Host's note: ${input.note}`);
  lines.push(
    "",
    `Support reviews this within ${CONDUCT_REMOVAL_REVIEW_HOURS} hours. Reply here to give your side. If the removal is overturned, or support does not decide in time, whatever is still unrefunded on your seat is refunded to where you paid from.`,
  );
  return lines.join("\n");
}

/**
 * Opens the case on `tx` with the attendee as requester and submitter, so the
 * host never reads it. The CREATED event's actor is the remover.
 */
export async function openConductRemovalCaseTx(
  tx: Tx,
  input: OpenRemovalCaseInput,
  now: Date,
): Promise<{ id: string; referenceNumber: string }> {
  const body = removalCaseBody(input);
  const priority = priorityForReason(null);
  const created = await tx.supportCase.create({
    data: {
      ownershipScope: "PERSONAL",
      organizationId: null,
      scopeKey: `APPOINTMENT:${input.appointmentId}`,
      requesterUserId: input.removedUserId,
      submitterUserId: input.removedUserId,
      category: CONDUCT_REMOVAL_CATEGORY,
      referenceNumber: await allocateTicketReference(tx, now),
      appointmentId: input.appointmentId,
      title: REMOVAL_CASE_TITLE,
      description: body,
      activeChannel: "HUMAN",
      priority,
      status: "OPEN",
      receivedAt: now,
      ...supportDeadline(CONDUCT_REMOVAL_CATEGORY, now),
      ...slaDeadlinesFor(priority, now),
      messageSeq: 1,
      lastMessageAt: now,
      subjects: {
        create: [
          {
            subjectType: "APPOINTMENT",
            subjectId: input.appointmentId,
            isPrimary: true,
          },
        ],
      },
      messages: {
        create: [
          {
            seq: 1,
            sender: "SYSTEM",
            body,
            isInternal: false,
            authorUserId: null,
            createdAt: now,
          },
        ],
      },
      events: {
        create: [
          {
            actorId: input.actorUserId,
            kind: "CREATED",
            toValue: "OPEN",
            note: "Opened by a host removing the attendee for conduct",
            createdAt: now,
          },
        ],
      },
    },
  });
  // AGENT, not SYSTEM: the attendee must get the bell; SYSTEM notifies staff only.
  await stageSupportCaseIntakeTx(tx, created, "AGENT");
  return { id: created.id, referenceNumber: created.referenceNumber };
}

/** Posts a line on the case the attendee and support both read. */
async function postCaseMessageTx(
  tx: Tx,
  caseId: string,
  body: string,
  isInternal: boolean,
  now: Date,
): Promise<void> {
  const { messageSeq } = await tx.supportCase.update({
    where: { id: caseId },
    data: { messageSeq: { increment: 1 }, lastMessageAt: now },
    select: { messageSeq: true },
  });
  await tx.supportCaseMessage.create({
    data: {
      caseId,
      seq: messageSeq,
      sender: "SYSTEM",
      isInternal,
      body,
      createdAt: now,
    },
  });
}

/** The seat's captured order: the one the attendee bought first, as every seat door reads it. */
function seatPayment(db: PrismaLike, appointmentId: string, userId: string) {
  return db.payment.findFirst({
    orderBy: { createdAt: "asc" },
    where: {
      userId,
      appointmentId,
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
    },
    select: {
      id: true,
      amount: true,
      originalAmount: true,
      paymentIntent: true,
      refundOwedKey: true,
    },
  });
}

/**
 * Freezes the seat's unpaid earnings for the case. A payment another door's
 * refund already holds is left alone, and a payout already being sent cannot
 * be held: the case still opens and staff see why. Returns whether it held.
 */
export async function holdSeatEarningsTx(
  tx: Tx,
  args: { appointmentId: string; userId: string; caseId: string; now: Date },
): Promise<boolean> {
  const payment = await seatPayment(tx, args.appointmentId, args.userId);
  if (!payment || payment.refundOwedKey) return false;
  const note = "Held while support reviews a host's removal of the attendee";
  try {
    await holdPaymentForCase(tx, {
      caseId: args.caseId,
      paymentId: payment.id,
      note,
    });
  } catch (error) {
    if (!(error instanceof OpsRefusal)) throw error;
    await postCaseMessageTx(
      tx,
      args.caseId,
      `Earnings hold not placed (${error.code}): ${error.message}`,
      true,
      args.now,
    );
    return false;
  }
  await tx.supportCaseEvent.create({
    data: {
      caseId: args.caseId,
      actorId: null,
      kind: "HOLD_APPLIED",
      toValue: payment.id,
      note,
      createdAt: args.now,
    },
  });
  return true;
}

/** What an overturn or a missed deadline left to do after its commit. */
export interface ConductRemovalRemedy {
  caseId: string;
  appointmentId: string;
  userId: string;
  event: { kind: "webinar" | "class"; id: string } | null;
  /** Null when nothing is owed: a free seat, no payment, or another door's refund holds it. */
  marker: RefundOwedMarker | null;
  /** The unblock intent's generation; null when only the money is owed. */
  unblockGeneration: Date | null;
}

/**
 * Stamps the refund the removal now owes: whatever is still unrefunded on the
 * seat's payment (a full-balance marker), keyed on the removal case so an
 * overturn after a missed deadline never refunds twice. A free seat owes nothing.
 */
async function stampRemovalRefundTx(
  tx: Tx,
  caseId: string,
  appointmentId: string,
  userId: string,
  reason: string,
): Promise<RefundOwedMarker | null> {
  const payment = await seatPayment(tx, appointmentId, userId);
  if (
    !payment ||
    isPriceFreePayment({
      paymentIntent: payment.paymentIntent,
      amountPaise: Number(payment.amount),
      listPricePaise: Number(payment.originalAmount),
    })
  ) {
    return null;
  }
  const marker: RefundOwedMarker = {
    paymentId: payment.id,
    amountPaise: null,
    key: `${conductRemovalRefundKey(caseId)}:pay:${payment.id}`,
    reason,
  };
  if (payment.refundOwedKey === marker.key) return marker;
  if (await stampRefundOwed(tx, marker)) return marker;
  // Another door's refund holds the payment: record the hand top-up and hold its earnings.
  await stampOwedOrHeld(tx, marker);
  return null;
}

async function removalTargetTx(db: PrismaLike, removalCaseId: string) {
  const removal = await db.supportCase.findUniqueOrThrow({
    where: { id: removalCaseId },
    select: {
      appointmentId: true,
      requesterUserId: true,
      appointment: { select: { webinarId: true, classId: true } },
    },
  });
  if (!removal.appointmentId) return null;
  const { webinarId, classId } = removal.appointment ?? {};
  return {
    appointmentId: removal.appointmentId,
    userId: removal.requesterUserId,
    event: webinarId
      ? { kind: "webinar" as const, id: webinarId }
      : classId
        ? { kind: "class" as const, id: classId }
        : null,
  };
}

/**
 * Inside the decision's transaction: an OVERTURNED decision on a removal case,
 * or on an appeal of one, owes the seat's unrefunded balance and an unblock.
 * Any other outcome changes nothing; support refunds through its own doors.
 */
export async function conductRemovalDecidedTx(
  tx: Tx,
  supportCase: {
    id: string;
    category: string | null;
    appealOfDecisionId: string | null;
  },
  outcome: string,
): Promise<void> {
  if (outcome !== "OVERTURNED") return;
  const caseId = await reviewedRemovalCaseId(tx, supportCase);
  if (!caseId) return;
  const target = await removalTargetTx(tx, caseId);
  if (!target) return;
  await stampRemovalRefundTx(
    tx,
    caseId,
    target.appointmentId,
    target.userId,
    "conduct removal overturned",
  );
  await persistConductBlockInTx(tx, target.appointmentId, target.userId);
}

/**
 * After an OVERTURNED decision commits: reads what the removal still owes
 * (its refund marker and its open block intent) and settles it. A replayed
 * decision finds whatever an earlier attempt left. Never throws.
 */
export async function settleDecidedRemoval(caseId: string): Promise<void> {
  try {
    const decided = await prisma.supportCase.findUnique({
      where: { id: caseId },
      select: { id: true, category: true, appealOfDecisionId: true },
    });
    const removalCaseId = decided
      ? await reviewedRemovalCaseId(prisma, decided)
      : null;
    if (!removalCaseId) return;
    const target = await removalTargetTx(prisma, removalCaseId);
    if (!target) return;
    const [payment, intent] = await Promise.all([
      prisma.payment.findFirst({
        where: {
          userId: target.userId,
          appointmentId: target.appointmentId,
          refundOwedKey: {
            startsWith: `${conductRemovalRefundKey(removalCaseId)}:pay:`,
          },
        },
        select: REFUND_OWED_SELECT,
      }),
      prisma.streamRevocationRetry.findFirst({
        where: {
          erasureRequestId: null,
          kind: "CONDUCT_CALL_BLOCK",
          planId: target.appointmentId,
          userId: target.userId,
          status: { not: "SUCCEEDED" },
        },
        select: { nextRetryAt: true },
      }),
    ]);
    await settleConductRemovalRemedy({
      caseId: removalCaseId,
      ...target,
      marker: payment ? markerFromRow(payment) : null,
      unblockGeneration: intent?.nextRetryAt ?? null,
    });
  } catch (error) {
    // The marker and the intent stay owed; retry-auto-refunds and the revocation sweep drive them.
    console.warn(
      `[conduct-removal] settling case ${caseId} failed:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * After the commit: refunds what the marker owes on the seat's own rails (the
 * seat door returns credits, wallet or card as it was paid), then replays the
 * marker to clear it, and drives the unblock. A death before this leaves the
 * marker for retry-auto-refunds and the intent for the revocation sweep.
 */
export async function settleConductRemovalRemedy(
  remedy: ConductRemovalRemedy,
): Promise<void> {
  if (remedy.marker && remedy.event) {
    await refundRemovedAttendeeSeat({
      kind: remedy.event.kind,
      eventId: remedy.event.id,
      attendeeUserId: remedy.userId,
      initiatedByUserId: null,
      initiatedBy: "organiser",
      mode: "full",
      dedupeKey: conductRemovalRefundKey(remedy.caseId),
      paymentId: remedy.marker.paymentId,
    });
    await driveRefundOwed(remedy.marker);
  }
  if (remedy.unblockGeneration) {
    await syncConductCallBlock(
      remedy.appointmentId,
      remedy.userId,
      remedy.unblockGeneration,
    );
  }
}

/** Removal cases past their review deadline with no decision and no lapse recorded yet. */
export function conductRemovalLapsedWhere(
  now: Date,
): Prisma.SupportCaseWhereInput {
  return {
    category: CONDUCT_REMOVAL_CATEGORY,
    deletedAt: null,
    appointmentId: { not: null },
    createdAt: {
      lte: new Date(now.getTime() - CONDUCT_REMOVAL_REVIEW_HOURS * HOUR_MS),
    },
    decisions: { none: {} },
    events: { none: { kind: "REMOVAL_REVIEW_LAPSED" } },
  };
}

/**
 * Records the lapse once and stamps the refund it owes, in one transaction.
 * Null when another run or a decision got there first.
 */
async function lapseRemovalTx(
  tx: Tx,
  caseId: string,
  now: Date,
): Promise<ConductRemovalRemedy | null> {
  const still = await tx.supportCase.findFirst({
    where: { id: caseId, ...conductRemovalLapsedWhere(now) },
    select: { id: true },
  });
  if (!still) return null;
  await tx.supportCaseEvent.create({
    data: {
      caseId,
      actorId: null,
      kind: "REMOVAL_REVIEW_LAPSED",
      note: `No decision within ${CONDUCT_REMOVAL_REVIEW_HOURS} hours`,
      createdAt: now,
    },
  });
  const target = await removalTargetTx(tx, caseId);
  if (!target) return null;
  const marker = await stampRemovalRefundTx(
    tx,
    caseId,
    target.appointmentId,
    target.userId,
    "conduct removal review lapsed",
  );
  await postCaseMessageTx(
    tx,
    caseId,
    `Support did not decide within ${CONDUCT_REMOVAL_REVIEW_HOURS} hours, so whatever is still unrefunded on your seat is being returned to where you paid from. Support can still review the removal.`,
    false,
    now,
  );
  return { caseId, ...target, marker, unblockGeneration: null };
}

export interface ConductRemovalDeadlineResult {
  lapsed: number;
}

/**
 * The support SLA sweep's arm for conduct removals: once a removal passes
 * its 72-hour review deadline undecided, the seat's unrefunded balance is
 * refunded. Fires once per case; the block stays until support decides.
 */
export async function sweepConductRemovalDeadlines(opts: {
  limit: number;
  now: Date;
  errors: string[];
}): Promise<ConductRemovalDeadlineResult> {
  const due = await prisma.supportCase.findMany({
    where: conductRemovalLapsedWhere(opts.now),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: opts.limit,
    select: { id: true },
  });
  let lapsed = 0;
  // Sequential: each case is one transaction and a refund on the shared pool.
  for (const { id } of due) {
    try {
      const remedy = await prisma.$transaction(
        (tx) => lapseRemovalTx(tx, id, opts.now),
        {
          maxWait: ALLOCATION_TX_MAX_WAIT_MS,
          timeout: ALLOCATION_TX_TIMEOUT_MS,
        },
      );
      if (!remedy) continue;
      lapsed++;
      await settleConductRemovalRemedy(remedy);
    } catch (error) {
      opts.errors.push(
        `conduct-removal-deadline ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { lapsed };
}

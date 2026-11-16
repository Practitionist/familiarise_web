/** The review case a conduct removal opens, its earnings hold, and what an overturn or the 72-hour lapse owes. */

import { CONDUCT_REMOVAL_CATEGORY } from "./case-topic";
import { Prisma } from "@prisma/client";

import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
  type PrismaLike,
  type Tx,
} from "@/lib/prisma";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  isFreeCreditIntent,
  isPriceFreePayment,
} from "@/lib/payments/funding-rail";
import {
  REFUNDABLE_BALANCE_SELECT,
  RETURNED_REFUND_STATUSES,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
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
  CONDUCT_REMOVAL_REVIEW_HOURS,
  conductRemovalRefundKey,
  reviewedRemovalCaseId,
} from "./conduct-removal-state";

const HOUR_MS = 3_600_000;
const REMOVAL_CASE_TITLE = "Removed from a group session";

interface OpenRemovalCaseInput {
  appointmentId: string;
  removedUserId: string;
  actorUserId: string;
  eventTitle: string | null;
  reasonLabel: string;
  note: string | null;
}

/** What the host recorded; the removed attendee adds their side as replies. */
function removalCaseBody(input: {
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
    `Support decides within ${CONDUCT_REMOVAL_REVIEW_HOURS} hours. Reply here to give your side. If the removal is overturned, or support does not decide in time, whatever is still unrefunded on your seat is refunded to where you paid from.`,
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
 * Holds the seat's unpaid earnings for the case; a payment another refund holds, or a payout
 * already sending, is left alone and the case says why. Returns whether it held.
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
interface ConductRemovalRemedy {
  caseId: string;
  appointmentId: string;
  userId: string;
  /** Null when nothing is owed: a free seat, no payment, or another door's refund holds it. */
  marker: RefundOwedMarker | null;
  /** The unblock intent's generation; null when only the money is owed. */
  unblockGeneration: Date | null;
}

/** Stamps the seat's unrefunded balance as owed, keyed on the removal case so it is refunded once. */
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
    select: { appointmentId: true, requesterUserId: true },
  });
  if (!removal.appointmentId) return null;
  return {
    appointmentId: removal.appointmentId,
    userId: removal.requesterUserId,
  };
}

/** What an overturn must refund first on which payment: unrefunded paise, unrestored credits, or null. */
export async function removalRefundOutstandingTx(
  tx: Tx,
  supportCase: {
    id: string;
    category: string | null;
    appealOfDecisionId: string | null;
  },
): Promise<{ paymentId: string; owed: number | "credits" } | null> {
  const caseId = await reviewedRemovalCaseId(tx, supportCase);
  const target = caseId ? await removalTargetTx(tx, caseId) : null;
  if (!target) return null;
  const payment = await tx.payment.findFirst({
    orderBy: { createdAt: "asc" },
    where: {
      userId: target.userId,
      appointmentId: target.appointmentId,
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
    },
    select: {
      id: true,
      amount: true,
      originalAmount: true,
      paymentIntent: true,
      ...REFUNDABLE_BALANCE_SELECT,
    },
  });
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
  if (isFreeCreditIntent(payment.paymentIntent)) {
    return payment.refunds.some((r) => RETURNED_REFUND_STATUSES.has(r.status))
      ? null
      : { paymentId: payment.id, owed: "credits" };
  }
  const balance = refundableBalancePaise(Number(payment.amount), payment);
  return balance > 0 ? { paymentId: payment.id, owed: balance } : null;
}

/** On the decision's tx, once its refund is settled: an OVERTURNED removal (or appeal of one) owes an unblock. */
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
  const target = caseId ? await removalTargetTx(tx, caseId) : null;
  if (!target) return;
  await persistConductBlockInTx(tx, target.appointmentId, target.userId);
}

/** After an OVERTURNED decision commits: drives whatever marker and block intent are still owed. Never throws. */
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
      error instanceof Error ? error.name : typeof error,
    );
  }
}

/** Drives the owed refund and the unblock; returns the refund failure for the caller to report. */
async function settleConductRemovalRemedy(
  remedy: ConductRemovalRemedy,
): Promise<string | null> {
  let failure: string | null = null;
  if (remedy.marker) {
    const outcome = await driveRefundOwed(remedy.marker);
    if (outcome.kind === "failed") {
      failure =
        outcome.error instanceof Error
          ? outcome.error.message
          : String(outcome.error);
    } else if (outcome.kind === "blocked") {
      failure = "refund blocked by a dispute or a changed marker";
    }
  }
  if (remedy.unblockGeneration) {
    await syncConductCallBlock(
      remedy.appointmentId,
      remedy.userId,
      remedy.unblockGeneration,
    );
  }
  return failure;
}

/**
 * Removal cases past their 72-hour deadline with no lapse recorded and no decision made in time:
 * a decision after the deadline does not cancel the refund it owes.
 */
function lapsedCaseIds(
  db: PrismaLike,
  now: Date,
  limit: number,
  onlyCaseId?: string,
) {
  return db.$queryRaw<{ id: string }[]>`
    SELECT c.id FROM "SupportCase" c
    WHERE c.category = ${CONDUCT_REMOVAL_CATEGORY}
      ${onlyCaseId ? Prisma.sql`AND c.id = ${onlyCaseId}` : Prisma.empty}
      AND c."deletedAt" IS NULL
      AND c."appointmentId" IS NOT NULL
      AND c."createdAt" <= ${new Date(now.getTime() - CONDUCT_REMOVAL_REVIEW_HOURS * HOUR_MS)}
      AND NOT EXISTS (
        SELECT 1 FROM "SupportCaseEvent" e
        WHERE e."caseId" = c.id AND e.kind = 'REMOVAL_REVIEW_LAPSED')
      AND NOT EXISTS (
        SELECT 1 FROM "SupportCaseDecision" d
        WHERE d."caseId" = c.id
          AND d."createdAt" <= c."createdAt" + ${CONDUCT_REMOVAL_REVIEW_HOURS}::int * interval '1 hour')
    ORDER BY c."createdAt" ASC, c.id ASC
    LIMIT ${limit}`;
}

/** The ticker's idle probe for the conduct removal arm. */
export async function hasConductRemovalLapse(
  db: PrismaLike,
  now: Date,
): Promise<boolean> {
  return (await lapsedCaseIds(db, now, 1)).length > 0;
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
  // Lock first, then read: a run that committed a lapse meanwhile is visible to the check below.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "SupportCase" WHERE id = ${caseId} FOR UPDATE`;
  if (locked.length === 0) return null;
  if ((await lapsedCaseIds(tx, now, 1, caseId)).length === 0) return null;
  // A new version, so a decision still holding the old one is refused as stale.
  await tx.supportCase.updateMany({
    where: { id: caseId },
    data: { updatedAt: new Date() },
  });
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
  if (marker) {
    await postCaseMessageTx(
      tx,
      caseId,
      `Support did not decide within ${CONDUCT_REMOVAL_REVIEW_HOURS} hours, so whatever is still unrefunded on your seat is being returned to where you paid from.`,
      false,
      now,
    );
  }
  return { caseId, ...target, marker, unblockGeneration: null };
}

interface ConductRemovalDeadlineResult {
  lapsed: number;
}

/** The SLA sweep's arm: a removal undecided at 72 hours owes its unrefunded balance, once per case. */
export async function sweepConductRemovalDeadlines(opts: {
  limit: number;
  now: Date;
  errors: string[];
}): Promise<ConductRemovalDeadlineResult> {
  const due = await lapsedCaseIds(prisma, opts.now, opts.limit);
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
      // The marker stays owed for retry-auto-refunds; the sweep reports the failure once per run.
      const failure = await settleConductRemovalRemedy(remedy);
      if (failure)
        opts.errors.push(`conduct-removal-deadline ${id}: ${failure}`);
    } catch (error) {
      opts.errors.push(
        `conduct-removal-deadline ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { lapsed };
}

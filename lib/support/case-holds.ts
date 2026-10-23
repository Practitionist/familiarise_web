/**
 * Support-case payout holds, carried by the shared EarningsHold model with
 * reason SUPPORT_CASE and the case id as its source. The case's timeline owns
 * the intent: the latest HOLD_APPLIED / HOLD_RELEASED event for a payment
 * (`toValue` = payment id) says whether the case still holds it, so earnings
 * created later for that payment are frozen too.
 */

import {
  EarningStatus,
  EarningsHoldReason,
  type SupportCaseEventKind,
} from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { cancelOpenPayoutsForPayment } from "@/lib/payments/payouts/cancel-open-payouts";
import {
  EarningsHoldRaceError,
  HOLDABLE_EARNING_STATUSES,
  placeEarningsHolds,
  releaseEarningsHolds,
} from "@/lib/payments/payouts/earnings-holds";

const CASE_HOLDABLE: EarningStatus[] = [
  ...HOLDABLE_EARNING_STATUSES,
  EarningStatus.HELD,
];
const HOLD_EVENT_KINDS: SupportCaseEventKind[] = [
  "HOLD_APPLIED",
  "HOLD_RELEASED",
];
const SUPPORT_CASE = EarningsHoldReason.SUPPORT_CASE;

export interface HeldEarnings {
  consultantEarningIds: string[];
  orgEarningIds: string[];
}

async function holdableEarningIds(tx: Tx, paymentId: string) {
  const where = { paymentId, status: { in: CASE_HOLDABLE } };
  const [consultant, org] = [
    await tx.consultantEarnings.findMany({ where, select: { id: true } }),
    await tx.organizationEarnings.findMany({ where, select: { id: true } }),
  ];
  return {
    consultant: consultant.map((row) => row.id),
    org: org.map((row) => row.id),
  };
}

async function placeCaseHold(
  tx: Tx,
  caseId: string,
  paymentId: string,
  note: string | null,
): Promise<HeldEarnings> {
  const ids = await holdableEarningIds(tx, paymentId);
  const hold = { reason: SUPPORT_CASE, sourceRef: caseId, note };
  try {
    await placeEarningsHolds(tx, "consultant", ids.consultant, hold);
    await placeEarningsHolds(tx, "org", ids.org, hold);
  } catch (error) {
    if (error instanceof EarningsHoldRaceError)
      throw new OpsRefusal(
        "EARNING_CHANGED",
        "An earning changed while the hold was placed — reload and try again.",
      );
    throw error;
  }
  return { consultantEarningIds: ids.consultant, orgEarningIds: ids.org };
}

/**
 * Freezes the payment's unpaid earnings for the case: payouts not yet sent are
 * cancelled first, and a payout already being sent refuses the hold.
 */
export async function holdPaymentForCase(
  tx: Tx,
  input: { caseId: string; paymentId: string; note: string },
): Promise<HeldEarnings & { cancelledPayoutIds: string[] }> {
  const sending = { status: "PROCESSING" as const };
  const inFlight =
    (await tx.consultantEarnings.findFirst({
      where: { paymentId: input.paymentId, payout: sending },
      select: { id: true },
    })) ??
    (await tx.organizationEarnings.findFirst({
      where: { paymentId: input.paymentId, orgPayout: sending },
      select: { id: true },
    }));
  if (inFlight)
    throw new OpsRefusal(
      "PAYOUT_IN_FLIGHT",
      "A linked payout is already being sent. Review it before applying this hold.",
    );
  const cancelled = await cancelOpenPayoutsForPayment(
    tx,
    input.paymentId,
    "Cancelled: linked payment is held for a support case",
  );
  const stillBatched =
    (await tx.consultantEarnings.findFirst({
      where: { paymentId: input.paymentId, status: EarningStatus.BATCHED },
      select: { id: true },
    })) ??
    (await tx.organizationEarnings.findFirst({
      where: { paymentId: input.paymentId, status: EarningStatus.BATCHED },
      select: { id: true },
    }));
  if (stillBatched)
    throw new OpsRefusal(
      "PAYOUT_IN_FLIGHT",
      "A linked payout started sending while the hold was placed. Review it before applying this hold.",
    );
  const held = await placeCaseHold(
    tx,
    input.caseId,
    input.paymentId,
    input.note,
  );
  return {
    ...held,
    cancelledPayoutIds: [...cancelled.consultant, ...cancelled.org],
  };
}

/** Releases the case's active holds, on one payment or on all of them. */
export async function releaseCaseHoldRows(
  tx: Tx,
  input: { caseId: string; paymentId?: string; releasedById: string | null },
): Promise<HeldEarnings> {
  const onPayment = input.paymentId
    ? {
        OR: [
          { consultantEarnings: { paymentId: input.paymentId } },
          { organizationEarnings: { paymentId: input.paymentId } },
        ],
      }
    : {};
  const active = await tx.earningsHold.findMany({
    where: {
      reason: SUPPORT_CASE,
      sourceRef: input.caseId,
      releasedAt: null,
      ...onPayment,
    },
    select: { consultantEarningsId: true, organizationEarningsId: true },
  });
  const consultant = active.flatMap((h) =>
    h.consultantEarningsId ? [h.consultantEarningsId] : [],
  );
  const org = active.flatMap((h) =>
    h.organizationEarningsId ? [h.organizationEarningsId] : [],
  );
  const match = { reasons: [SUPPORT_CASE], sourceRef: input.caseId };
  const opts = { releasedById: input.releasedById };
  const [c, o] = [
    await releaseEarningsHolds(tx, "consultant", consultant, match, opts),
    await releaseEarningsHolds(tx, "org", org, match, opts),
  ];
  return { consultantEarningIds: c.released, orgEarningIds: o.released };
}

export interface CaseHoldEvent {
  id: string;
  caseId: string;
  kind: SupportCaseEventKind;
  toValue: string | null;
  note: string | null;
  createdAt: Date;
}

/** The hold events of these cases, newest first; optionally for one payment. */
export function caseHoldEvents(
  tx: Tx,
  caseIds: string[],
  paymentId?: string,
): Promise<CaseHoldEvent[]> {
  return tx.supportCaseEvent.findMany({
    where: {
      caseId: { in: caseIds },
      kind: { in: HOLD_EVENT_KINDS },
      ...(paymentId ? { toValue: paymentId } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      caseId: true,
      kind: true,
      toValue: true,
      note: true,
      createdAt: true,
    },
  });
}

/** The latest HOLD_APPLIED event per payment the case still holds. */
export function activeHolds(events: CaseHoldEvent[]): CaseHoldEvent[] {
  const latest = new Map<string, CaseHoldEvent>();
  for (const event of events) {
    const key = `${event.caseId}:${event.toValue ?? ""}`;
    if (!latest.has(key)) latest.set(key, event);
  }
  return [...latest.values()].filter((event) => event.kind === "HOLD_APPLIED");
}

export interface ReleasedCaseHold {
  holdId: string;
  paymentId: string | null;
}

/** Releases every hold the case still has, with a HOLD_RELEASED event per payment; returns the holds released. */
export async function releaseAllCaseHolds(
  tx: Tx,
  input: { caseId: string; actorId: string | null; note: string },
): Promise<ReleasedCaseHold[]> {
  const open = activeHolds(await caseHoldEvents(tx, [input.caseId]));
  if (open.length === 0) return [];
  await releaseCaseHoldRows(tx, {
    caseId: input.caseId,
    releasedById: input.actorId,
  });
  for (const hold of open) {
    await tx.supportCaseEvent.create({
      data: {
        caseId: input.caseId,
        actorId: input.actorId,
        kind: "HOLD_RELEASED",
        fromValue: hold.id,
        toValue: hold.toValue,
        note: input.note,
      },
    });
  }
  return open.map((hold) => ({ holdId: hold.id, paymentId: hold.toValue }));
}

/**
 * Applies every open case's active hold on this payment to its earnings; run
 * after new earnings are written so they start frozen like their siblings.
 */
export async function applyCaseHoldsToNewEarnings(
  tx: Tx,
  payment: { id: string; appointmentId: string | null },
): Promise<void> {
  const paymentId = payment.id;
  const cases = await tx.supportCase.findMany({
    where: {
      deletedAt: null,
      status: { notIn: ["RESOLVED", "CLOSED"] },
      OR: [
        ...(payment.appointmentId
          ? [{ appointmentId: payment.appointmentId }]
          : []),
        {
          subjects: { some: { subjectType: "PAYMENT", subjectId: paymentId } },
        },
      ],
    },
    select: { id: true },
  });
  if (cases.length === 0) return;
  const open = activeHolds(
    await caseHoldEvents(
      tx,
      cases.map((c) => c.id),
      paymentId,
    ),
  );
  for (const hold of open) {
    await placeCaseHold(tx, hold.caseId, paymentId, hold.note);
  }
}

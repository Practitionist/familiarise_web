import {
  EarningStatus,
  EarningsHoldReason,
  PaymentStatus,
  Prisma,
  RefundStatus,
} from "@prisma/client";
import { z } from "zod";

import prisma, { type Tx } from "@/lib/prisma";
import {
  recordSystemError,
  recordSystemErrorSafe,
  recordSystemEvent,
} from "@/lib/enterprise/system-events";
import { Refusal } from "@/lib/errors/refusal";
import { LAUNCH_TIMEZONE } from "@/lib/scheduling/weeklyUtcOffset";
import { formatDateLabel } from "@/lib/time/display";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import type { FundingRail } from "@/lib/payments/funding-rail";
import { GATEWAY_NOT_FOUND } from "@/lib/payments/core/types";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import {
  EarningsHoldRaceError,
  HOLDABLE_EARNING_STATUSES,
  OWED_ALREADY_HELD_PREFIX,
  placeEarningsHolds,
} from "@/lib/payments/payouts/earnings-holds";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { refundBookingPayment } from "./booking-refund";
import {
  findDedupedRefund,
  RefundGatewayError,
  RefundValidationError,
} from "./refund";

/**
 * A refund a door owes on one payment, stamped in the same commit that ended
 * the booking (state-as-outbox: the marker is the work queue). `amountPaise`
 * null means the full remaining balance, the only shape the credits rail takes.
 */
export type RefundOwedMarker = {
  paymentId: string;
  amountPaise: number | null;
  key: string;
  reason: string;
  /** Failed drives so far; the sweep retires the marker at the cap. */
  attempts?: number;
};

/** Failed drives after which an operator refunds by hand. */
export const MAX_REFUND_OWED_ATTEMPTS = 3;

/**
 * The wait after the first and second failed drive before the sweep drives
 * again; with the sweep's 15-minute grace the cap pages about 5 h after the stamp.
 */
const REFUND_OWED_BACKOFF_MS = [60 * 60_000, 4 * 60 * 60_000] as const;

/** The standing ops finding for a payment whose stuck marker blocks a cancel. */
export const REFUND_NEEDS_SUPPORT_PREFIX = "refund-needs-support:";

/** Every marker column as it reads once the marker is gone. */
const CLEARED_MARKER = {
  refundOwedKey: null,
  refundOwedPaise: null,
  refundOwedReason: null,
  refundOwedAt: null,
  refundOwedAttempts: 0,
  refundOwedNextAt: null,
} as const;

/**
 * A refund that settles under its marker's own key clears the marker in the
 * settling transaction, by CAS on that key, so the payment's earnings hold lifts.
 */
export async function clearOwedMarkerSettledBy(
  tx: Pick<Tx, "payment">,
  paymentId: string,
  dedupeKey: string | null,
): Promise<void> {
  if (!dedupeKey) return;
  await tx.payment.updateMany({
    where: { id: paymentId, refundOwedKey: dedupeKey },
    data: CLEARED_MARKER,
  });
}

/** What an operator needs to see of the owed refund that already went out. */
const SENT_REFUND_SELECT = {
  id: true,
  status: true,
  amountPaise: true,
  createdAt: true,
  refundId: true,
} as const;

type SentRefund = {
  id: string;
  amountPaise: bigint | number;
  createdAt: Date;
  refundId: string | null;
};

/**
 * The refusal a hand refund gets when the payment's owed refund already went
 * out, with the amount, date and reference of that refund.
 */
function owedAlreadySent(
  paymentId: string,
  key: string,
  sent: SentRefund,
): RefundValidationError {
  const reference = sent.refundId ?? sent.id;
  const on = formatDateLabel(sent.createdAt, { zone: LAUNCH_TIMEZONE });
  return new RefundValidationError(
    `${rupees(Number(sent.amountPaise))} already went back to the buyer on ${on} (refund ${reference}), so nothing is owed on this payment. Only submit again if you mean to refund more on top of this.`,
    "OWED_REFUND_ALREADY_SENT",
    { paymentId, key, refundRowId: sent.id, reference },
  );
}

/**
 * Before an operator's refund opens its transaction, given the marker key it
 * read: when that owed refund already succeeded, clears the marker and refuses,
 * so the hand refund never pays the same money twice.
 */
export async function refuseIfOwedAlreadySent(
  paymentId: string,
  key: string | null | undefined,
): Promise<void> {
  if (!key) return;
  const own = await prisma.refund.findUnique({
    where: { dedupeKey: key },
    select: SENT_REFUND_SELECT,
  });
  if (own?.status !== RefundStatus.SUCCEEDED) return;
  await clearOwedMarkerSettledBy(prisma, paymentId, key);
  throw owedAlreadySent(paymentId, key, own);
}

/** What an operator's hand refund did to the owed refund, as its Refund row's metadata records it. */
export const handSettledOwedSchema = z.object({
  key: z.string(),
  reason: z.string(),
  /** The owed amount as stamped; null is the full remaining balance. */
  owedPaise: z.number().nullable(),
  settledPaise: z.number(),
  /** Zero when the marker was cleared; otherwise what the marker still owes and retries. */
  stillOwedPaise: z.number(),
  /** The operator-facing summary. */
  note: z.string(),
});
export type HandSettledOwed = z.infer<typeof handSettledOwedSchema>;

/** How much of the owed refund a hand refund covers. */
export type HandRefundCover =
  /** Restores everything left (the credits rail's whole restoration). */
  | { kind: "whole" }
  /** Moves `handPaise` out of a balance of `refundableBeforePaise`. */
  | { kind: "amount"; handPaise: number; refundableBeforePaise: number }
  /** A partial credit return, which a full-balance credit marker cannot shrink to. */
  | { kind: "credits-part" };

const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

/**
 * An operator's refund settles the payment's owed refund by hand, inside the
 * refund's own transaction and by CAS on the marker key and its owed amount:
 * one that covers what is owed clears the marker, a smaller one reduces it and
 * leaves its attempts and backoff alone. Refused while the marker's own refund
 * is in flight, and once it has already gone out.
 */
export async function settleOwedByHand(
  tx: Pick<Tx, "payment" | "refund">,
  paymentId: string,
  cover: HandRefundCover,
): Promise<HandSettledOwed | null> {
  const row = await tx.payment.findUnique({
    where: { id: paymentId },
    select: {
      refundOwedKey: true,
      refundOwedPaise: true,
      refundOwedReason: true,
      refundOwedAttempts: true,
    },
  });
  const key = row?.refundOwedKey;
  if (!key) return null;
  const own = await tx.refund.findUnique({
    where: { dedupeKey: key },
    select: SENT_REFUND_SELECT,
  });
  if (own?.status === RefundStatus.PENDING) {
    throw new RefundValidationError(
      "This payment's owed refund is being sent right now. Wait for it to finish, then check what is still owed before refunding by hand.",
      "OWED_REFUND_IN_FLIGHT",
      { paymentId, key },
    );
  }
  const stamped =
    row.refundOwedPaise === null ? null : Number(row.refundOwedPaise);
  const where = { id: paymentId, refundOwedKey: key, refundOwedPaise: stamped };
  // The pre-check clears it; one that succeeded since is still never paid twice.
  if (own?.status === RefundStatus.SUCCEEDED)
    throw owedAlreadySent(paymentId, key, own);
  if (cover.kind === "credits-part") {
    throw new RefundValidationError(
      "This payment still owes its whole credit restoration. Return every remaining session, or let the owed restoration run.",
      "OWED_RESTORATION_WHOLE",
      { paymentId, key },
    );
  }
  // A hand refund of nothing settles nothing; never let a non-positive amount grow the debt.
  if (cover.kind === "amount" && cover.handPaise <= 0) return null;
  const reason = row.refundOwedReason ?? "refund owed";
  const owedNow =
    stamped ?? (cover.kind === "amount" ? cover.refundableBeforePaise : null);
  if (
    cover.kind === "whole" ||
    owedNow === null ||
    cover.handPaise >= owedNow
  ) {
    const { count } = await tx.payment.updateMany({
      where,
      data: CLEARED_MARKER,
    });
    if (count === 0) return null;
    return {
      key,
      reason,
      owedPaise: stamped,
      settledPaise: owedNow ?? 0,
      stillOwedPaise: 0,
      note:
        owedNow === null
          ? "The owed refund is fully settled."
          : `The owed ${rupees(owedNow)} is fully settled.`,
    };
  }
  const stillOwedPaise = owedNow - cover.handPaise;
  const { count } = await tx.payment.updateMany({
    where,
    data: { refundOwedPaise: stillOwedPaise },
  });
  if (count === 0) return null;
  return {
    key,
    reason,
    owedPaise: stamped,
    settledPaise: cover.handPaise,
    stillOwedPaise,
    note:
      row.refundOwedAttempts >= MAX_REFUND_OWED_ATTEMPTS
        ? `Settled ${rupees(cover.handPaise)} of the owed ${rupees(owedNow)}; ${rupees(stillOwedPaise)} still owed, and its automatic retries are spent: refund it by hand.`
        : `Settled ${rupees(cover.handPaise)} of the owed ${rupees(owedNow)}; ${rupees(stillOwedPaise)} still owed and retrying.`,
  };
}

/**
 * A drive refunds only while its marker still holds the payment at the amount
 * it read: a hand refund that cleared it settles the drive, one that reduced it
 * leaves the marker for the next drive to read afresh.
 */
async function assertOwedMarkerHeld(
  tx: Pick<Tx, "payment">,
  paymentId: string,
  owed: { key: string; amountPaise: number | null },
): Promise<void> {
  const row = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { refundOwedKey: true, refundOwedPaise: true },
  });
  if (row?.refundOwedKey !== owed.key) {
    throw new RefundValidationError(
      `Payment ${paymentId} no longer owes ${owed.key}`,
      "OWED_MARKER_SETTLED",
    );
  }
  const now = row.refundOwedPaise === null ? null : Number(row.refundOwedPaise);
  if (now !== owed.amountPaise) {
    throw new RefundValidationError(
      `Payment ${paymentId}'s owed refund ${owed.key} changed since it was read`,
      "OWED_MARKER_CHANGED",
    );
  }
}

/** What a refund rail does with the payment's owed-refund marker inside its refund transaction. */
export type OwedMarkerInput = {
  /** An operator's refund: it settles the payment's owed refund by hand. */
  settlesOwedByHand?: boolean;
  /** A marker drive: it refunds only while this marker still holds the payment as read. */
  owedMarker?: { key: string; amountPaise: number | null };
};

/** The marker side of a refund's own transaction; what a hand refund settled, if anything. */
export async function claimOwedMarker(
  tx: Pick<Tx, "payment" | "refund">,
  paymentId: string,
  input: OwedMarkerInput,
  cover: HandRefundCover,
): Promise<HandSettledOwed | null> {
  if (input.owedMarker)
    await assertOwedMarkerHeld(tx, paymentId, input.owedMarker);
  return input.settlesOwedByHand
    ? settleOwedByHand(tx, paymentId, cover)
    : null;
}

/** A failed hand refund's metadata: what it settled, and whether that was given back. */
const FAILED_HAND_REFUND = z
  .object({
    settledOwed: handSettledOwedSchema,
    settledOwedRestored: z.boolean().optional(),
    settledOwedRestoredPaise: z.number().optional(),
    settledOwedRestoredKey: z.string().optional(),
    settledOwedResettled: z.boolean().optional(),
  })
  .passthrough();

/** Re-reads a failed hand refund's restore takes against a marker other hand refunds keep moving. */
const RESTORE_ATTEMPTS = 3;

/** A re-stamped marker waits out the sweep's grace like a fresh one. */
const RESTAMP_GRACE_MS = 15 * 60_000;

/**
 * A hand refund that failed gives back the owed refund it settled, in the
 * transaction that failed it, capped at the refundable balance: a reduced
 * marker grows back by CAS, a cleared one is re-stamped under a new key.
 * `settledOwedRestored`, claimed by CAS on the row, makes it once-only.
 */
export async function restoreOwedOnFailedRefund(
  tx: Tx,
  refundRowId: string,
): Promise<void> {
  const refund = await tx.refund.findUnique({
    where: { id: refundRowId },
    select: { paymentId: true, status: true, metadata: true, updatedAt: true },
  });
  if (refund?.status !== RefundStatus.FAILED) return;
  const meta = FAILED_HAND_REFUND.safeParse(refund.metadata);
  if (!meta.success || meta.data.settledOwedRestored) return;
  const settled = meta.data.settledOwed;
  // A concurrent hand refund can move the marker between the read and the
  // CAS, so the plan is re-read against the debt as it stands now.
  for (let attempt = 0; attempt < RESTORE_ATTEMPTS; attempt += 1) {
    const plan = await planOwedRestore(
      tx,
      refund.paymentId,
      refundRowId,
      settled,
    );
    if (plan.kind === "write" && (await plan.write()).count !== 1) continue;
    if (plan.kind === "unrestorable") {
      await recordSystemError({
        organizationId: null,
        category: "PAYMENT",
        summary: `A failed hand refund on payment ${refund.paymentId} could not give back the ${rupees(settled.settledPaise)} it settled (${settled.key}): another refund is owed or the payment is no longer live — refund by hand`,
        err: new Error("OWED_REFUND_NOT_RESTORED"),
        context: { refundRowId, heldKey: plan.heldKey, ...settled },
        db: tx,
      });
    }
    const restoredPaise = plan.kind === "write" ? plan.paise : 0;
    const claimed = await tx.refund.updateMany({
      where: {
        id: refundRowId,
        status: RefundStatus.FAILED,
        updatedAt: refund.updatedAt,
      },
      data: {
        metadata: {
          ...meta.data,
          settledOwedRestored: true,
          settledOwedRestoredPaise: restoredPaise,
          ...(plan.kind === "write"
            ? { settledOwedRestoredKey: plan.key }
            : {}),
        } as Prisma.InputJsonValue,
      },
    });
    if (claimed.count === 1) return;
    // Another writer restored it first; roll this restore back with the transaction.
    throw new Error(
      `Failed hand refund ${refundRowId} was restored concurrently`,
    );
  }
  throw new Error(
    `Owed refund on payment ${refund.paymentId} kept changing while failed hand refund ${refundRowId} gave it back`,
  );
}

type RestorePlan =
  | {
      kind: "write";
      paise: number;
      key: string;
      write: () => Promise<{ count: number }>;
    }
  | { kind: "nothing" }
  | { kind: "unrestorable"; heldKey: string | null };

/** How to give back `settled` against the payment's marker as it reads now, capped at the refundable balance. */
async function planOwedRestore(
  tx: Tx,
  paymentId: string,
  refundRowId: string,
  settled: HandSettledOwed,
): Promise<RestorePlan> {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: {
      amount: true,
      paymentStatus: true,
      deletedAt: true,
      refundOwedKey: true,
      refundOwedPaise: true,
      ...REFUNDABLE_BALANCE_SELECT,
    },
  });
  if (!payment) return { kind: "nothing" };
  const refundable = refundableBalancePaise(Number(payment.amount), payment);
  const owedNow =
    payment.refundOwedPaise === null ? null : Number(payment.refundOwedPaise);
  if (payment.refundOwedKey === settled.key) {
    // A full-balance marker (null) already owes everything that is left.
    if (owedNow === null) return { kind: "nothing" };
    const paise = Math.max(
      0,
      Math.min(owedNow + settled.settledPaise, refundable) - owedNow,
    );
    if (paise === 0) return { kind: "nothing" };
    return {
      kind: "write",
      paise,
      key: settled.key,
      write: () =>
        tx.payment.updateMany({
          where: {
            id: paymentId,
            refundOwedKey: settled.key,
            refundOwedPaise: owedNow,
          },
          data: { refundOwedPaise: owedNow + paise },
        }),
    };
  }
  // A marker is only ever stamped on a live SUCCEEDED payment.
  const stampable =
    payment.paymentStatus === PaymentStatus.SUCCEEDED &&
    payment.deletedAt === null;
  if (payment.refundOwedKey !== null || !stampable) {
    return { kind: "unrestorable", heldKey: payment.refundOwedKey };
  }
  const paise = Math.max(0, Math.min(settled.settledPaise, refundable));
  if (paise === 0) return { kind: "nothing" };
  const key = `${settled.key}:restored:${refundRowId}`;
  const now = new Date();
  return {
    kind: "write",
    paise,
    key,
    write: () =>
      tx.payment.updateMany({
        where: {
          id: paymentId,
          refundOwedKey: null,
          paymentStatus: PaymentStatus.SUCCEEDED,
          deletedAt: null,
        },
        data: {
          refundOwedKey: key,
          refundOwedPaise: paise,
          refundOwedReason: settled.reason,
          refundOwedAt: now,
          refundOwedAttempts: 0,
          refundOwedNextAt: new Date(now.getTime() + RESTAMP_GRACE_MS),
        },
      }),
  };
}

/**
 * Moves a refund to FAILED through the caller's CAS and, in the same
 * transaction, gives back the owed refund it settled by hand and counts the
 * failed drive when it was the marker's own refund.
 */
export function failRefund(
  refundRowId: string,
  fail: (tx: Tx) => Promise<{ count: number }>,
): Promise<{ count: number }> {
  return prisma.$transaction(async (tx) => {
    const moved = await fail(tx);
    if (moved.count === 1) {
      await restoreOwedOnFailedRefund(tx, refundRowId);
      await countOwedDriveFailure(tx, refundRowId);
    }
    return moved;
  });
}

/**
 * A marker's own refund confirmed FAILED (a refusal, or reconcile failing an
 * ambiguous answer) is one failed drive: counted by CAS in the failing
 * transaction, so a gateway that keeps answering ambiguously still reaches
 * the needs-human cap.
 */
export async function countOwedDriveFailure(
  tx: Tx,
  refundRowId: string,
): Promise<void> {
  const refund = await tx.refund.findUnique({
    where: { id: refundRowId },
    select: { paymentId: true, dedupeKey: true },
  });
  if (!refund?.dedupeKey) return;
  const payment = await tx.payment.findUnique({
    where: { id: refund.paymentId },
    select: { refundOwedKey: true, refundOwedAttempts: true },
  });
  if (!payment || payment.refundOwedKey !== refund.dedupeKey) return;
  const attempts = payment.refundOwedAttempts;
  const bumped = await bumpOwedAttempt(tx, {
    paymentId: refund.paymentId,
    key: refund.dedupeKey,
    attempts,
    permanent: false,
  });
  if (!bumped.counted || !bumped.stuck) return;
  await recordSystemError({
    organizationId: null,
    category: "PAYMENT",
    summary: `Refund owed on payment ${refund.paymentId} failed ${bumped.next} times — refund by hand`,
    err: new Error("OWED_REFUND_ATTEMPTS_SPENT"),
    context: {
      paymentId: refund.paymentId,
      key: refund.dedupeKey,
      refundRowId,
    },
    db: tx,
  });
}

/**
 * A failed hand refund that later succeeds moved the money after all, so the
 * owed refund it gave back is taken off the marker again by CAS, once.
 */
export async function resettleOwedOnLateSuccess(
  tx: Tx,
  refundRowId: string,
): Promise<void> {
  const refund = await tx.refund.findUnique({
    where: { id: refundRowId },
    select: { paymentId: true, metadata: true, updatedAt: true },
  });
  const meta = FAILED_HAND_REFUND.safeParse(refund?.metadata);
  if (!refund || !meta.success) return;
  const { settledOwedRestoredPaise: given, settledOwedRestoredKey: key } =
    meta.data;
  if (!meta.data.settledOwedRestored || meta.data.settledOwedResettled) return;
  const claimed = await tx.refund.updateMany({
    where: { id: refundRowId, updatedAt: refund.updatedAt },
    data: {
      metadata: {
        ...meta.data,
        settledOwedResettled: true,
      } as Prisma.InputJsonValue,
    },
  });
  if (claimed.count === 0 || !given || !key) return;
  const payment = await tx.payment.findUnique({
    where: { id: refund.paymentId },
    select: { refundOwedKey: true, refundOwedPaise: true },
  });
  const owedNow =
    payment?.refundOwedPaise === null || payment?.refundOwedPaise === undefined
      ? null
      : Number(payment.refundOwedPaise);
  if (payment?.refundOwedKey !== key || owedNow === null) {
    await recordSystemError({
      organizationId: null,
      category: "PAYMENT",
      summary: `Hand refund ${refundRowId} on payment ${refund.paymentId} succeeded after its ${rupees(given)} owed refund was given back, and that marker has moved on — check for a double refund`,
      err: new Error("OWED_REFUND_LATE_SUCCESS"),
      context: { refundRowId, key, given, heldKey: payment?.refundOwedKey },
      db: tx,
    });
    return;
  }
  const where = {
    id: refund.paymentId,
    refundOwedKey: key,
    refundOwedPaise: owedNow,
  };
  await tx.payment.updateMany(
    owedNow <= given
      ? { where, data: CLEARED_MARKER }
      : { where, data: { refundOwedPaise: owedNow - given } },
  );
}

export const REFUND_OWED_SELECT = {
  id: true,
  refundOwedKey: true,
  refundOwedPaise: true,
  refundOwedReason: true,
  refundOwedAttempts: true,
} as const;

/** The marker on a row read with {@link REFUND_OWED_SELECT}, or null when none is set. */
export function markerFromRow(row: {
  id: string;
  refundOwedKey: string | null;
  refundOwedPaise: number | null;
  refundOwedReason: string | null;
  refundOwedAttempts: number;
}): RefundOwedMarker | null {
  if (!row.refundOwedKey) return null;
  return {
    paymentId: row.id,
    amountPaise: row.refundOwedPaise,
    key: row.refundOwedKey,
    reason: row.refundOwedReason ?? "refund owed",
    attempts: row.refundOwedAttempts,
  };
}

const STAMPABLE = {
  paymentStatus: PaymentStatus.SUCCEEDED,
  deletedAt: null,
  refundOwedKey: null,
} as const;

export const REFUND_NEEDS_SUPPORT = "REFUND_NEEDS_SUPPORT";
export const REFUND_IN_PROGRESS = "REFUND_IN_PROGRESS";

/** What the refused door was changing: a whole booking, one seat in it, or a whole class or webinar. */
export type HeldMarkerSubject = "booking" | "seat" | "class" | "webinar";

const HELD_MARKER_COPY: Record<
  HeldMarkerSubject,
  { needsSupport: string; inProgress: string }
> = {
  booking: {
    needsSupport:
      "A refund on this booking needs our support team before it can be cancelled. We've been notified and will be in touch.",
    inProgress:
      "A refund on this booking is still being processed. You can make changes once it completes.",
  },
  seat: {
    needsSupport:
      "This seat couldn't be released yet: a refund on it needs our support team. We've been notified and will be in touch.",
    inProgress:
      "This seat couldn't be released yet: a refund on it is still being processed. You can release it once that completes.",
  },
  class: {
    needsSupport:
      "This class couldn't be cancelled yet: a refund on one of its seats needs our support team. We've been notified and will be in touch.",
    inProgress:
      "This class couldn't be cancelled yet: a refund on one of its seats is still being processed. Try again once it completes.",
  },
  webinar: {
    needsSupport:
      "This webinar couldn't be cancelled yet: a refund on one of its seats needs our support team. We've been notified and will be in touch.",
    inProgress:
      "This webinar couldn't be cancelled yet: a refund on one of its seats is still being processed. Try again once it completes.",
  },
};

/**
 * The answer a door gives when another door's refund marker already holds the
 * payment, with nothing committed: a marker still retrying clears itself once
 * its refund completes; one that spent its attempts, or that a live dispute
 * holds, waits for support, who settle it through an ops refund door.
 */
export async function heldMarkerRefusal(
  tx: Pick<Tx, "payment">,
  paymentId: string,
  context: Record<string, unknown> = {},
  subject: HeldMarkerSubject = "booking",
): Promise<Refusal> {
  const held = await tx.payment.findUnique({
    where: { id: paymentId },
    select: {
      refundOwedKey: true,
      refundOwedAttempts: true,
      disputes: {
        where: { status: { notIn: DISPUTE_INACTIVE_FOR_GATING } },
        select: { id: true },
      },
    },
  });
  const stuck =
    (held?.refundOwedAttempts ?? 0) >= MAX_REFUND_OWED_ATTEMPTS ||
    (held?.disputes.length ?? 0) > 0;
  if (stuck) {
    return new Refusal({
      code: REFUND_NEEDS_SUPPORT,
      httpStatus: 409,
      userMessage: HELD_MARKER_COPY[subject].needsSupport,
      devMessage: `Payment ${paymentId} holds a stuck refund marker; refused`,
      context: { ...context, paymentId, heldKey: held?.refundOwedKey, subject },
    });
  }
  return new Refusal({
    code: REFUND_IN_PROGRESS,
    httpStatus: 409,
    userMessage: HELD_MARKER_COPY[subject].inProgress,
    devMessage: `Payment ${paymentId} already owes another door's refund; refused`,
    context: { ...context, paymentId, heldKey: held?.refundOwedKey, subject },
  });
}

/**
 * The held-marker refusal as an operator reads it (ADMIN or STAFF): which
 * payment holds which refund, and the next step; `retry` names the operator's
 * own door (default: cancel the class, webinar or booking again). Null for any
 * other refusal.
 */
export function opsHeldMarkerMessage(
  refusal: Refusal,
  retry?: string,
): string | null {
  if (
    refusal.code !== REFUND_NEEDS_SUPPORT &&
    refusal.code !== REFUND_IN_PROGRESS
  )
    return null;
  const paymentId = refusal.context?.paymentId;
  if (typeof paymentId !== "string") return null;
  const heldKey = refusal.context?.heldKey;
  const from = typeof heldKey === "string" ? ` (${heldKey})` : "";
  const subject = refusal.context?.subject;
  const event = subject === "class" || subject === "webinar";
  const payment =
    event || subject === "seat"
      ? `Seat payment ${paymentId}`
      : `Payment ${paymentId}`;
  const target = event ? "the " + String(subject) : "this booking";
  const next = retry ?? `cancel ${target} again`;
  return refusal.code === REFUND_NEEDS_SUPPORT
    ? `${payment} has a refund still owed from another action${from}; settle it from Refunds → Needs human, then ${next}.`
    : `${payment} has a refund from another action${from} still being sent; wait for it to finish, then ${next}. If it fails, settle it by hand from Refunds → Needs human.`;
}

/**
 * The audit trail of a door a stuck marker refused, one row per payment and
 * marker, written after the refused transaction rolled back; a repeat finds
 * it. The ops queue reads stuck markers from the payment itself.
 */
export async function recordRefundNeedsSupport(
  refusal: Refusal,
): Promise<void> {
  if (refusal.code !== REFUND_NEEDS_SUPPORT) return;
  const paymentId = refusal.context?.paymentId;
  if (typeof paymentId !== "string") return;
  const heldKey = refusal.context?.heldKey;
  const correlationId = `${REFUND_NEEDS_SUPPORT_PREFIX}${paymentId}:${typeof heldKey === "string" ? heldKey : "unknown"}`;
  const standing = await prisma.systemEvent
    .findFirst({ where: { correlationId }, select: { id: true } })
    .catch(() => null);
  if (standing) return;
  await recordSystemEvent({
    category: "PAYMENT",
    severity: "WARN",
    message: `Payment ${paymentId} has a stuck refund owed; a booking change is waiting on support`,
    context: refusal.context,
    correlationId,
  });
}

/**
 * Stamps one marker on the caller's transaction. The first writer wins: a
 * payment that already owes a refund keeps its marker and this returns false.
 */
export async function stampRefundOwed(
  tx: Pick<Tx, "payment">,
  marker: RefundOwedMarker,
): Promise<boolean> {
  if (marker.amountPaise !== null && marker.amountPaise <= 0) return false;
  const { count } = await tx.payment.updateMany({
    where: { id: marker.paymentId, ...STAMPABLE },
    data: {
      refundOwedKey: marker.key,
      refundOwedPaise: marker.amountPaise,
      refundOwedReason: marker.reason,
      refundOwedAt: new Date(),
      refundOwedAttempts: 0,
      refundOwedNextAt: null,
    },
  });
  return count === 1;
}

/** A door's refund that another door's owed refund already held: the door added nothing. */
export type OwedRefundAlreadyHeld = {
  paymentId: string;
  /** The key this door would have stamped. */
  key: string;
  heldKey: string;
  /** Null is the full remaining balance. */
  heldPaise: number | null;
  /** The operator-facing explanation. */
  note: string;
};

/**
 * Stamps the door's marker; when another door's owed refund already holds the
 * payment (first writer wins), records in the caller's transaction that this
 * action added nothing, holds the payment's earnings for the hand top-up, and
 * answers what holds it.
 */
export async function stampOwedOrHeld(
  tx: Tx,
  marker: RefundOwedMarker,
): Promise<OwedRefundAlreadyHeld | null> {
  if (await stampRefundOwed(tx, marker)) return null;
  return heldBy(tx, marker);
}

/** The operator-facing line for a door whose refund another door's owed refund already held. */
export function owedAlreadyHeldNote(
  paymentId: string,
  heldKey: string,
  heldPaise: number | null,
): string {
  return `A refund of ${heldPaise === null ? "the full balance" : rupees(heldPaise)} was already owed on payment ${paymentId} for another reason (${heldKey}), so this action added nothing to it. Refund any difference by hand.`;
}

/** What holds the payment instead of `marker`, recorded as an ops event; null when nothing else does. */
async function heldBy(
  tx: Tx,
  marker: RefundOwedMarker,
): Promise<OwedRefundAlreadyHeld | null> {
  const row = await tx.payment.findUnique({
    where: { id: marker.paymentId },
    select: { id: true, refundOwedKey: true, refundOwedPaise: true },
  });
  return row ? reportHeld(tx, marker, row) : null;
}

/** The ops instruction for a door's refund another door's owed refund held: what to pay by hand. */
export function handTopUpCopy(owedPaise: number, held: boolean): string {
  const remaining = `the remaining ${rupees(owedPaise)}`;
  return held
    ? `Another refund is still owed on this payment; refund ${remaining} by hand, then release the hold.`
    : `Another refund is still owed on this payment; refund ${remaining} by hand.`;
}

/** The earnings a hand top-up hold freezes: unpaid, or already held by another owner. */
const TOP_UP_HOLDABLE: EarningStatus[] = [
  ...HOLDABLE_EARNING_STATUSES,
  EarningStatus.HELD,
];

/**
 * Freezes the payment's unpaid earnings under an OPERATOR hold keyed on the
 * door's event, so they wait for the hand top-up; a replay finds its own hold.
 * A row that keeps moving refuses with a retryable 409 and rolls the door back:
 * no earning is ever left HELD without an active hold.
 */
async function holdForHandTopUp(
  tx: Tx,
  paymentId: string,
  sourceRef: string,
  owedPaise: number,
): Promise<void> {
  const where = { paymentId, status: { in: TOP_UP_HOLDABLE } };
  const consultant = await tx.consultantEarnings.findMany({
    where,
    select: { id: true },
  });
  const org = await tx.organizationEarnings.findMany({
    where,
    select: { id: true },
  });
  const hold = {
    reason: EarningsHoldReason.OPERATOR,
    sourceRef,
    note: handTopUpCopy(owedPaise, true),
  };
  try {
    await placeEarningsHolds(
      tx,
      "consultant",
      consultant.map((r) => r.id),
      hold,
    );
    await placeEarningsHolds(
      tx,
      "org",
      org.map((r) => r.id),
      hold,
    );
  } catch (err) {
    if (err instanceof EarningsHoldRaceError) {
      throw new BookingRuleError(
        "PAYMENT_BUSY",
        "Another update is in progress on this payment — try again.",
      );
    }
    throw err;
  }
}

/**
 * What the losing door still adds on top of the holding marker: its own amount
 * (a full-balance door: everything left), capped at the balance the holding
 * marker leaves. Zero when a full-balance marker already covers it.
 */
async function topUpOwedPaise(
  tx: Tx,
  marker: RefundOwedMarker,
  held: { key: string; paise: number | null },
): Promise<number> {
  if (held.paise === null) return 0;
  const payment = await tx.payment.findUnique({
    where: { id: marker.paymentId },
    select: { amount: true, ...REFUNDABLE_BALANCE_SELECT },
  });
  if (!payment) return 0;
  // A holding refund already sent (or in flight) is in the balance; never subtract it twice.
  const sent = await tx.refund.findFirst({
    where: {
      dedupeKey: held.key,
      status: { in: [RefundStatus.SUCCEEDED, RefundStatus.PENDING] },
    },
    select: { id: true },
  });
  const left =
    refundableBalancePaise(Number(payment.amount), payment) -
    (sent ? 0 : held.paise);
  return Math.max(0, Math.min(marker.amountPaise ?? left, left));
}

async function reportHeld(
  tx: Tx,
  marker: RefundOwedMarker,
  row: { refundOwedKey: string | null; refundOwedPaise: number | null },
): Promise<OwedRefundAlreadyHeld | null> {
  const heldKey = row.refundOwedKey;
  if (!heldKey || heldKey === marker.key) return null;
  const heldPaise =
    row.refundOwedPaise === null ? null : Number(row.refundOwedPaise);
  const held = {
    paymentId: marker.paymentId,
    key: marker.key,
    heldKey,
    heldPaise,
    note: owedAlreadyHeldNote(marker.paymentId, heldKey, heldPaise),
  };
  const owedPaise = await topUpOwedPaise(tx, marker, {
    key: heldKey,
    paise: heldPaise,
  });
  // Nothing to add on top of the holding marker: no ops row, no hold.
  if (owedPaise <= 0) return held;
  const correlationId = `${OWED_ALREADY_HELD_PREFIX}${marker.paymentId}:${marker.key}`;
  // The event is the needs-human row: written once per payment and door key, with the door's commit.
  const standing = await tx.systemEvent.findFirst({
    where: { correlationId },
    select: { id: true },
  });
  if (!standing) {
    await recordSystemEvent({
      category: "PAYMENT",
      severity: "WARN",
      message: held.note,
      context: { ...held, reason: marker.reason, owedPaise },
      correlationId,
      db: tx,
      strict: true,
    });
  }
  await holdForHandTopUp(tx, marker.paymentId, correlationId, owedPaise);
  return held;
}

/** For a batch the caller already stamped: the markers another door's owed refund held instead, in one read. */
export async function heldInsteadOf(
  tx: Tx,
  markers: readonly RefundOwedMarker[],
): Promise<OwedRefundAlreadyHeld[]> {
  if (markers.length === 0) return [];
  const rows = await tx.payment.findMany({
    where: {
      id: { in: markers.map((m) => m.paymentId) },
      refundOwedKey: { not: null },
    },
    select: { id: true, refundOwedKey: true, refundOwedPaise: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const held: OwedRefundAlreadyHeld[] = [];
  for (const marker of markers) {
    const row = byId.get(marker.paymentId);
    const h = row ? await reportHeld(tx, marker, row) : null;
    if (h) held.push(h);
  }
  return held;
}

/**
 * Stamps many markers in one statement, so a whole roster costs one round trip
 * inside the caller's transaction instead of one per seat.
 */
export function stampRefundsOwed(
  tx: Pick<Tx, "$executeRaw">,
  markers: readonly RefundOwedMarker[],
): Promise<number> {
  const due = markers.filter(
    (m) => m.amountPaise === null || m.amountPaise > 0,
  );
  if (due.length === 0) return Promise.resolve(0);
  const ids = due.map((m) => m.paymentId);
  const keys = due.map((m) => m.key);
  const owed = due.map((m) => m.amountPaise);
  const reasons = due.map((m) => m.reason);
  return tx.$executeRaw(Prisma.sql`
    UPDATE "Payment" AS p
    SET "refundOwedKey" = v.key,
        "refundOwedPaise" = v.owed,
        "refundOwedReason" = v.reason,
        "refundOwedAt" = now(),
        "refundOwedAttempts" = 0,
        "refundOwedNextAt" = NULL,
        "updatedAt" = now()
    FROM unnest(${ids}::text[], ${keys}::text[], ${owed}::bigint[], ${reasons}::text[])
      AS v(id, key, owed, reason)
    WHERE p."id" = v.id
      AND p."refundOwedKey" IS NULL
      AND p."paymentStatus" = 'SUCCEEDED'
      AND p."deletedAt" IS NULL`);
}

export type RefundOwedOutcome =
  /** Money moved now, or the gateway is still settling it (a PENDING refund); the marker clears once it settles. */
  | { kind: "refunded"; refund: DrivenRefund }
  /** An earlier drive under this key already refunded it. */
  | { kind: "replayed"; refund: DrivenRefund }
  /** Nothing is left to refund, or an operator's hand refund settled it; the marker is cleared. */
  | { kind: "settled" }
  /** A live dispute owns the payment, or a hand refund just reduced the marker; it waits for the next drive. */
  | { kind: "blocked" }
  /** Kept for the sweep; `stuck` once the attempt budget is spent, `permanent` when no retry can succeed. */
  | { kind: "failed"; error: unknown; stuck: boolean; permanent: boolean };

export type DrivenRefund = {
  refundId: string;
  amountRefundedPaise: number;
  rail?: FundingRail;
  status?: "SUCCEEDED" | "PENDING";
};

/**
 * Drives one marker through the refund front door under its own key, outside
 * any transaction. Never throws: a failure is counted on the marker and left
 * for the retry-auto-refunds sweep.
 */
export async function driveRefundOwed(
  marker: RefundOwedMarker,
  opts: { initiatedByUserId?: string | null } = {},
): Promise<RefundOwedOutcome> {
  // The marker's amount is a cap the drive may lower, so a replay matches on the payment.
  const replayed = async (): Promise<RefundOwedOutcome | null> => {
    const prior = await findDedupedRefund(marker.key, {
      paymentId: marker.paymentId,
    });
    if (!prior) return null;
    if (prior.status !== "PENDING") await clearRefundOwed(marker);
    return {
      kind: "replayed",
      refund: {
        refundId: prior.refundId,
        amountRefundedPaise: prior.amountRefundedPaise,
        status: prior.status,
      },
    };
  };
  try {
    const prior = await replayed();
    if (prior) return prior;
    const refund = await refundUpToBalance(marker, opts);
    if (refund === null) {
      await clearRefundOwed(marker);
      return { kind: "settled" };
    }
    if (refund.status !== "PENDING") await clearRefundOwed(marker);
    return { kind: "refunded", refund };
  } catch (error) {
    if (error instanceof RefundValidationError) {
      // Nothing is owed on a price-free seat or a payment already made whole.
      if (
        error.code === "ALREADY_FULLY_REFUNDED" ||
        error.code === "PRICE_FREE_PAYMENT"
      ) {
        await clearRefundOwed(marker);
        return { kind: "settled" };
      }
      if (error.code === "REFUND_BLOCKED_BY_DISPUTE")
        return { kind: "blocked" };
      // An operator's hand refund cleared the marker, or reduced it for the next drive.
      if (error.code === "OWED_MARKER_SETTLED") return { kind: "settled" };
      if (error.code === "OWED_MARKER_CHANGED") return { kind: "blocked" };
      // A racing drive clamped the cap and spent the key first: its refund is this marker's.
      if (error.code === "IDEMPOTENCY_KEY_REUSED") {
        const winner = await readOrNull(replayed);
        if (winner) return winner;
      }
    }
    // The drive's own refund is still PENDING (an ambiguous gateway answer, or
    // a settle that failed after the gateway took it): reconcile settles it by
    // lookup, so the drive spends no attempt on it.
    const inFlight = await pendingReservation(marker);
    if (inFlight) return { kind: "refunded", refund: inFlight };
    // The gateway has no such payment: retrying only adds FAILED refund rows.
    const permanent =
      error instanceof RefundGatewayError &&
      error.gatewayCode === GATEWAY_NOT_FOUND;
    // The transaction that failed the drive's own refund may have counted it.
    const now = await readOrNull(() =>
      prisma.payment.findUnique({
        where: { id: marker.paymentId },
        select: { refundOwedKey: true, refundOwedAttempts: true },
      }),
    );
    const read = marker.attempts ?? 0;
    if (now?.refundOwedKey === marker.key && now.refundOwedAttempts > read) {
      const spent = now.refundOwedAttempts >= MAX_REFUND_OWED_ATTEMPTS;
      const stuck =
        spent ||
        (permanent &&
          (await countFailedAttempt(
            { ...marker, attempts: now.refundOwedAttempts },
            error,
            true,
          )));
      return { kind: "failed", error, stuck, permanent };
    }
    const stuck = await countFailedAttempt(marker, error, permanent);
    return { kind: "failed", error, stuck, permanent };
  }
}

/** A read the never-throwing drive can lose: a failure reads as nothing found. */
async function readOrNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** The drive's own refund under the marker's key, on the marker's payment, while it is still PENDING, else null. */
async function pendingReservation(
  marker: Pick<RefundOwedMarker, "key" | "paymentId">,
): Promise<DrivenRefund | null> {
  const row = await readOrNull(() =>
    prisma.refund.findUnique({
      where: { dedupeKey: marker.key },
      select: { id: true, paymentId: true, amountPaise: true, status: true },
    }),
  );
  // An incident key names no payment, so a row under it may belong to another payment.
  if (
    row?.status !== RefundStatus.PENDING ||
    row.paymentId !== marker.paymentId
  )
    return null;
  return {
    refundId: row.id,
    amountRefundedPaise: Number(row.amountPaise),
    status: "PENDING",
  };
}

/**
 * Refunds the marker through the front door. A fixed amount that a later
 * refund pushed past the balance is retried once at what is still refundable;
 * null when nothing is left.
 */
async function refundUpToBalance(
  marker: RefundOwedMarker,
  opts: { initiatedByUserId?: string | null },
): Promise<DrivenRefund | null> {
  const refundOnce = (amountPaise: number | null) =>
    refundBookingPayment({
      paymentId: marker.paymentId,
      // No amount is the front door's full-balance call, the credits rail's only shape.
      ...(amountPaise === null ? {} : { amountPaise }),
      dedupeKey: marker.key,
      owedMarker: { key: marker.key, amountPaise: marker.amountPaise },
      reason: marker.reason,
      initiatedByUserId: opts.initiatedByUserId ?? null,
    });
  try {
    return await refundOnce(marker.amountPaise);
  } catch (error) {
    if (
      marker.amountPaise === null ||
      !(error instanceof RefundValidationError) ||
      error.code !== "AMOUNT_EXCEEDS_REFUNDABLE"
    ) {
      throw error;
    }
    const refundable = await refundablePaiseOf(marker.paymentId);
    if (refundable <= 0) return null;
    return refundOnce(Math.min(marker.amountPaise, refundable));
  }
}

/** The payment's refundable balance as it stands now. */
async function refundablePaiseOf(paymentId: string): Promise<number> {
  const row = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { amount: true, ...REFUNDABLE_BALANCE_SELECT },
  });
  return row ? refundableBalancePaise(Number(row.amount), row) : 0;
}

/** Clears the marker by CAS on its key; a lost clear is re-settled by the sweep's replay. */
async function clearRefundOwed(marker: RefundOwedMarker): Promise<void> {
  await prisma.payment
    .updateMany({
      where: { id: marker.paymentId, refundOwedKey: marker.key },
      data: CLEARED_MARKER,
    })
    .catch((err: unknown) => {
      console.warn(
        `[refund-owed] clear failed for payment ${marker.paymentId}:`,
        err instanceof Error ? err.message : String(err),
      );
    });
}

/**
 * Counts one failed drive by CAS on the attempt it read and schedules the
 * sweep's next drive; a permanent failure spends the whole budget at once.
 * Only the drive that hits the cap pages.
 */
async function countFailedAttempt(
  marker: RefundOwedMarker,
  error: unknown,
  permanent: boolean,
): Promise<boolean> {
  const attempts = marker.attempts ?? 0;
  const { counted, stuck } = await bumpOwedAttempt(prisma, {
    paymentId: marker.paymentId,
    key: marker.key,
    attempts,
    permanent,
  }).catch(() => ({ counted: false, ...nextAttempt(attempts, permanent) }));
  if (counted && stuck) {
    await recordSystemErrorSafe({
      organizationId: null,
      category: "PAYMENT",
      summary: permanent
        ? `Refund owed on payment ${marker.paymentId} names a payment the gateway does not know — refund by hand`
        : `Refund owed on payment ${marker.paymentId} failed ${attempts + 1} times — refund by hand`,
      err: error,
      context: {
        paymentId: marker.paymentId,
        key: marker.key,
        owedPaise: marker.amountPaise,
        gatewayCode:
          error instanceof RefundGatewayError ? error.gatewayCode : undefined,
      },
    });
  }
  return stuck;
}

/**
 * One failed drive, by CAS on the marker's key and the attempt count read,
 * with the sweep's next drive scheduled; a permanent failure spends the budget.
 */
async function bumpOwedAttempt(
  db: Pick<Tx, "payment">,
  args: {
    paymentId: string;
    key: string;
    attempts: number;
    permanent: boolean;
  },
): Promise<{ counted: boolean; stuck: boolean; next: number }> {
  const { next, stuck } = nextAttempt(args.attempts, args.permanent);
  const { count } = await db.payment.updateMany({
    where: {
      id: args.paymentId,
      refundOwedKey: args.key,
      refundOwedAttempts: args.attempts,
    },
    data: {
      refundOwedAttempts: next,
      refundOwedNextAt: stuck
        ? null
        : new Date(Date.now() + REFUND_OWED_BACKOFF_MS[next - 1]),
    },
  });
  return { counted: count === 1, stuck, next };
}

/** The attempt count after one more failed drive, and whether it spends the budget. */
function nextAttempt(
  attempts: number,
  permanent: boolean,
): { next: number; stuck: boolean } {
  const next = permanent
    ? Math.max(attempts + 1, MAX_REFUND_OWED_ATTEMPTS)
    : attempts + 1;
  return { next, stuck: next >= MAX_REFUND_OWED_ATTEMPTS };
}

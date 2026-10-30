import { PaymentStatus, Prisma, RefundStatus } from "@prisma/client";

import prisma, { type PrismaLike, type Tx } from "@/lib/prisma";
import {
  recordSystemErrorSafe,
  recordSystemEvent,
} from "@/lib/enterprise/system-events";
import { Refusal } from "@/lib/errors/refusal";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import type { FundingRail } from "@/lib/payments/funding-rail";
import { GATEWAY_NOT_FOUND } from "@/lib/payments/core/types";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
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

/** What an ops hand refund did to a stuck marker on the same payment. */
export type StuckMarkerClear =
  | { cleared: string }
  | { stillOwed: { key: string; paise: number | null } }
  | null;

/**
 * Clears a marker that spent its attempts once an operator's hand refunds
 * cover it: a full-balance refund, or refunds since the marker was stamped
 * adding up to what it owes (a marker owing the full balance clears only on
 * a full refund). A smaller refund leaves it standing and answers what is
 * still owed; a marker still retrying is never touched.
 */
export async function clearStuckRefundOwed(
  db: Pick<PrismaLike, "payment" | "refund">,
  paymentId: string,
  handRefund: { full: boolean },
): Promise<StuckMarkerClear> {
  const row = await db.payment.findUnique({
    where: { id: paymentId },
    select: {
      refundOwedKey: true,
      refundOwedAttempts: true,
      refundOwedPaise: true,
      refundOwedAt: true,
    },
  });
  if (!row?.refundOwedKey || row.refundOwedAttempts < MAX_REFUND_OWED_ATTEMPTS)
    return null;
  const owedPaise =
    row.refundOwedPaise === null ? null : Number(row.refundOwedPaise);
  const covered =
    handRefund.full ||
    (owedPaise !== null &&
      row.refundOwedAt !== null &&
      (await refundedSincePaise(db, paymentId, row.refundOwedAt)) >= owedPaise);
  if (!covered) {
    return { stillOwed: { key: row.refundOwedKey, paise: owedPaise } };
  }
  const { count } = await db.payment.updateMany({
    where: {
      id: paymentId,
      refundOwedKey: row.refundOwedKey,
      refundOwedAttempts: { gte: MAX_REFUND_OWED_ATTEMPTS },
    },
    data: {
      refundOwedKey: null,
      refundOwedPaise: null,
      refundOwedReason: null,
      refundOwedAt: null,
      refundOwedAttempts: 0,
      refundOwedNextAt: null,
    },
  });
  return count === 1 ? { cleared: row.refundOwedKey } : null;
}

async function refundedSincePaise(
  db: Pick<PrismaLike, "refund">,
  paymentId: string,
  since: Date,
): Promise<number> {
  const sum = await db.refund.aggregate({
    where: {
      paymentId,
      status: RefundStatus.SUCCEEDED,
      createdAt: { gte: since },
    },
    _sum: { amountPaise: true },
  });
  return Number(sum._sum.amountPaise ?? 0);
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

/** What the refused door was changing: a whole booking, or one seat in it. */
export type HeldMarkerSubject = "booking" | "seat";

const HELD_MARKER_COPY: Record<
  HeldMarkerSubject,
  { needsSupport: string; inProgress: string }
> = {
  booking: {
    needsSupport:
      "A refund on this booking needs our support team before it can be cancelled. We've been notified and will be in touch.",
    inProgress:
      "A refund on this booking is still being processed. Try again in a few minutes.",
  },
  seat: {
    needsSupport:
      "This seat couldn't be released yet: a refund on it needs our support team. We've been notified and will be in touch.",
    inProgress:
      "This seat couldn't be released yet: a refund on it is still being processed. Try again in a few minutes.",
  },
};

/**
 * The answer a door gives when another door's refund marker already holds the
 * payment, with nothing committed: a marker still retrying clears itself
 * shortly; one that spent its attempts, or that a live dispute holds, waits
 * for support, who settle it through the ops refund door.
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
      context: { ...context, paymentId, heldKey: held?.refundOwedKey },
    });
  }
  return new Refusal({
    code: "REFUND_IN_PROGRESS",
    httpStatus: 409,
    userMessage: HELD_MARKER_COPY[subject].inProgress,
    devMessage: `Payment ${paymentId} already owes another door's refund; refused`,
    context: { ...context, paymentId },
  });
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
  /** Money moved now; the marker is cleared unless the gateway is still settling. */
  | { kind: "refunded"; refund: DrivenRefund }
  /** An earlier drive under this key already refunded it. */
  | { kind: "replayed"; refund: DrivenRefund }
  /** Nothing is left to refund; the marker is cleared. */
  | { kind: "settled" }
  /** A live dispute owns the payment; the marker waits for it. */
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
  try {
    const prior = await findDedupedRefund(marker.key);
    if (prior) {
      if (prior.status !== "PENDING") await clearRefundOwed(marker);
      return {
        kind: "replayed",
        refund: {
          refundId: prior.refundId,
          amountRefundedPaise: prior.amountRefundedPaise,
          status: prior.status,
        },
      };
    }
    const refund = await refundUpToBalance(marker, opts);
    if (refund === null) {
      await clearRefundOwed(marker);
      return { kind: "settled" };
    }
    if (refund.status !== "PENDING") await clearRefundOwed(marker);
    return { kind: "refunded", refund };
  } catch (error) {
    if (error instanceof RefundValidationError) {
      if (error.code === "ALREADY_FULLY_REFUNDED") {
        await clearRefundOwed(marker);
        return { kind: "settled" };
      }
      if (error.code === "REFUND_BLOCKED_BY_DISPUTE")
        return { kind: "blocked" };
    }
    // The gateway has no such payment: retrying only adds FAILED refund rows.
    const permanent =
      error instanceof RefundGatewayError &&
      error.gatewayCode === GATEWAY_NOT_FOUND;
    const stuck = await countFailedAttempt(marker, error, permanent);
    return { kind: "failed", error, stuck, permanent };
  }
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
      data: {
        refundOwedKey: null,
        refundOwedPaise: null,
        refundOwedReason: null,
        refundOwedAt: null,
        refundOwedAttempts: 0,
        refundOwedNextAt: null,
      },
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
  const next = permanent
    ? Math.max(attempts + 1, MAX_REFUND_OWED_ATTEMPTS)
    : attempts + 1;
  const stuck = next >= MAX_REFUND_OWED_ATTEMPTS;
  const counted = await prisma.payment
    .updateMany({
      where: {
        id: marker.paymentId,
        refundOwedKey: marker.key,
        refundOwedAttempts: attempts,
      },
      data: {
        refundOwedAttempts: next,
        refundOwedNextAt: stuck
          ? null
          : new Date(Date.now() + REFUND_OWED_BACKOFF_MS[next - 1]),
      },
    })
    .then((r) => r.count === 1)
    .catch(() => false);
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

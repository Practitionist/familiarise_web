import { PaymentStatus, Prisma, RefundStatus } from "@prisma/client";
import { z } from "zod";

import prisma, { type Tx } from "@/lib/prisma";
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
  /** Read back from the payment row: it is driven only while the row still reads so. */
  asRead?: boolean;
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
 * is in flight; a marker whose own refund already moved is just cleared.
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
    },
  });
  const key = row?.refundOwedKey;
  if (!key) return null;
  const own = await tx.refund.findUnique({
    where: { dedupeKey: key },
    select: { status: true },
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
  if (own?.status === RefundStatus.SUCCEEDED) {
    await tx.payment.updateMany({ where, data: CLEARED_MARKER });
    return null;
  }
  if (cover.kind === "credits-part") {
    throw new RefundValidationError(
      "This payment still owes its whole credit restoration. Return every remaining session, or let the owed restoration run.",
      "OWED_RESTORATION_WHOLE",
      { paymentId, key },
    );
  }
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
    note: `Settled ${rupees(cover.handPaise)} of the owed ${rupees(owedNow)}; ${rupees(stillOwedPaise)} still owed and retrying.`,
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

/**
 * A hand refund the gateway refused moved no money, so the marker goes back to
 * what it owed before; a failed restore pages, because nothing else holds that debt.
 */
export async function restoreHandSettledOwed(
  paymentId: string,
  settled: HandSettledOwed,
): Promise<void> {
  const restored =
    settled.stillOwedPaise > 0
      ? await prisma.payment
          .updateMany({
            where: {
              id: paymentId,
              refundOwedKey: settled.key,
              refundOwedPaise: settled.stillOwedPaise,
            },
            data: { refundOwedPaise: settled.owedPaise },
          })
          .then((r) => r.count === 1)
          .catch(() => false)
      : await stampRefundOwed(prisma, {
          paymentId,
          amountPaise: settled.owedPaise,
          key: settled.key,
          reason: settled.reason,
        }).catch(() => false);
  if (restored) return;
  await recordSystemErrorSafe({
    organizationId: null,
    category: "PAYMENT",
    summary: `A failed hand refund on payment ${paymentId} could not restore the refund it owed (${settled.key}) — refund by hand`,
    err: new Error("OWED_REFUND_NOT_RESTORED"),
    context: { paymentId, ...settled },
  });
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
    asRead: true,
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
      "A refund on this booking is still being processed. You can make changes once it completes.",
  },
  seat: {
    needsSupport:
      "This seat couldn't be released yet: a refund on it needs our support team. We've been notified and will be in touch.",
    inProgress:
      "This seat couldn't be released yet: a refund on it is still being processed. You can release it once that completes.",
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
      // An operator's hand refund cleared the marker, or reduced it for the next drive.
      if (error.code === "OWED_MARKER_SETTLED") return { kind: "settled" };
      if (error.code === "OWED_MARKER_CHANGED") return { kind: "blocked" };
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
      ...(marker.asRead
        ? { owedMarker: { key: marker.key, amountPaise: marker.amountPaise } }
        : {}),
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

import { PaymentStatus, Prisma } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import type { FundingRail } from "@/lib/payments/funding-rail";
import { GATEWAY_NOT_FOUND } from "@/lib/payments/core/types";
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
    const refund = await refundBookingPayment({
      paymentId: marker.paymentId,
      // No amount is the front door's full-balance call, the credits rail's only shape.
      ...(marker.amountPaise === null
        ? {}
        : { amountPaise: marker.amountPaise }),
      dedupeKey: marker.key,
      reason: marker.reason,
      initiatedByUserId: opts.initiatedByUserId ?? null,
    });
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
 * Counts one failed drive by CAS on the attempt it read; a permanent failure
 * spends the whole budget at once. Only the drive that hits the cap pages.
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
  const counted = await prisma.payment
    .updateMany({
      where: {
        id: marker.paymentId,
        refundOwedKey: marker.key,
        refundOwedAttempts: attempts,
      },
      data: { refundOwedAttempts: next },
    })
    .then((r) => r.count === 1)
    .catch(() => false);
  const stuck = next >= MAX_REFUND_OWED_ATTEMPTS;
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

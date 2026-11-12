import type { DisputeStatus, Prisma, RefundStatus } from "@prisma/client";

/**
 * #1846 N2 — the durable marker of a capture the confirmation pipeline must
 * give back.
 *
 * Five Phase-2 branches refund a capture that funds no booking (a capture
 * after the hold was released, an amount mismatch, a capture after the
 * booking was cancelled, a double-booking loser and a GiST-overlap loser).
 * Each calls the refund door once, after commit. Phase 1 stamps this prefix
 * on `Payment.description` in the same transaction that decides the refund,
 * so the pending refund survives a failed gateway call or a killed function,
 * and `scripts/payments/retry-auto-refunds.ts` drives it to completion. A
 * settled refund rewrites the prefix to {@link AUTO_REFUNDED_PREFIX}.
 */

export const AUTO_REFUND_PENDING_PREFIX = "Auto-refund pending:";
export const AUTO_REFUNDED_PREFIX = "Auto-refunded:";
/**
 * The sweep gave up after its attempt budget; an operator refunds by hand.
 * Leaving the pending prefix would retry (and notify the payer of a failed
 * refund) forever.
 */
export const AUTO_REFUND_STUCK_PREFIX = "Auto-refund stuck:";

/** A settled replay sale: appointment-less by design, so never an orphan. */
export const REPLAY_SALE_PREFIX = "Replay sale:";

/** A settled digital product sale: appointment-less by design, so never an orphan. */
export const DIGITAL_PRODUCT_SALE_PREFIX = "Digital product sale:";

/** A row no sweep can settle; it leaves every sweep's cohort until an operator acts. */
export const MANUAL_RECOVERY_PREFIX = "REQUIRES_MANUAL_RECOVERY:";

/**
 * SUCCEEDED rows another owner settles (replay and digital product sales and every
 * auto-refund marker): the orphan sweeps neither page, link nor refund them, and a HELD
 * seat on one opens no room.
 */
export const notSettledElsewhereWhere: Prisma.PaymentWhereInput =
  descriptionWithoutPrefixes([
    AUTO_REFUND_PENDING_PREFIX,
    AUTO_REFUNDED_PREFIX,
    AUTO_REFUND_STUCK_PREFIX,
    REPLAY_SALE_PREFIX,
    DIGITAL_PRODUCT_SALE_PREFIX,
    MANUAL_RECOVERY_PREFIX,
  ]);

function descriptionWithoutPrefixes(
  prefixes: readonly string[],
): Prisma.PaymentWhereInput {
  return {
    OR: [
      { description: null },
      {
        NOT: prefixes.map((prefix) => ({
          description: { startsWith: prefix },
        })),
      },
    ],
  };
}

const REFUND_STATUSES_RETURNING_MONEY: RefundStatus[] = [
  "PENDING",
  "SUCCEEDED",
];
/** Disputes that leave the captured money with the platform. */
const DISPUTES_KEEPING_MONEY: DisputeStatus[] = [
  "WON",
  "CLOSED",
  "WARNING_CLOSED",
];

/**
 * A capture the recover door may still book: no refund pending or paid, no
 * owed-refund or auto-refund marker, and no dispute that is open or lost.
 */
export const unreturnedCaptureWhere: Prisma.PaymentWhereInput = {
  ...descriptionWithoutPrefixes([
    AUTO_REFUND_PENDING_PREFIX,
    AUTO_REFUNDED_PREFIX,
    AUTO_REFUND_STUCK_PREFIX,
  ]),
  refundOwedKey: null,
  refunds: { none: { status: { in: REFUND_STATUSES_RETURNING_MONEY } } },
  disputes: { none: { status: { notIn: DISPUTES_KEEPING_MONEY } } },
};

/**
 * The double-booking loser also holds tentative slots that are released once
 * the money is back, so the retry sweep has to recognise it.
 */
export const DOUBLE_BOOKING_BLOCKED_NOTE =
  "double-booking blocked at confirmation";

/** The pending marker for one refund reason. */
export function autoRefundPendingDescription(reason: string): string {
  return `${AUTO_REFUND_PENDING_PREFIX} ${reason}. Booking NOT confirmed.`;
}

function swapPrefix(pending: string, prefix: string): string {
  return pending.startsWith(AUTO_REFUND_PENDING_PREFIX)
    ? `${prefix}${pending.slice(AUTO_REFUND_PENDING_PREFIX.length)}`
    : pending;
}

/**
 * Settled form of a pending marker. Over-capture surpluses transition to
 * REQUIRES_MANUAL_RECOVERY so operators recover the excess above expectedAmount.
 */
export function settledAutoRefundDescription(pending: string): string {
  if (
    pending.startsWith(`${AUTO_REFUND_PENDING_PREFIX} Over-capture surplus`)
  ) {
    return swapPrefix(pending, MANUAL_RECOVERY_PREFIX);
  }
  return swapPrefix(pending, AUTO_REFUNDED_PREFIX);
}

/** The given-up form of a pending marker, keeping its reason. */
export function stuckAutoRefundDescription(pending: string): string {
  return swapPrefix(pending, AUTO_REFUND_STUCK_PREFIX);
}

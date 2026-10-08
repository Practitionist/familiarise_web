import type { Prisma } from "@prisma/client";

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

/**
 * Appointment-less SUCCEEDED rows another owner settles (replay sales and every
 * auto-refund marker); the orphan sweeps must neither page, link nor refund them.
 */
export const notSettledElsewhereWhere: Prisma.PaymentWhereInput = {
  OR: [
    { description: null },
    {
      NOT: [
        AUTO_REFUND_PENDING_PREFIX,
        AUTO_REFUNDED_PREFIX,
        AUTO_REFUND_STUCK_PREFIX,
        REPLAY_SALE_PREFIX,
        "REQUIRES_MANUAL_RECOVERY:",
      ].map((prefix) => ({ description: { startsWith: prefix } })),
    },
  ],
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

/** The settled form of a pending marker, keeping its reason. */
export function settledAutoRefundDescription(pending: string): string {
  return swapPrefix(pending, AUTO_REFUNDED_PREFIX);
}

/** The given-up form of a pending marker, keeping its reason. */
export function stuckAutoRefundDescription(pending: string): string {
  return swapPrefix(pending, AUTO_REFUND_STUCK_PREFIX);
}

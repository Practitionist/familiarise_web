/**
 * A group event (webinar, class) has one Payment per attendee per appointment
 * (`@@unique([userId, appointmentId])`), so the host's view of the money is a
 * status per seat, not a list of amounts. Pure helpers, shared by the detail
 * page and the participants roster so the two cannot disagree.
 *
 * `PaymentStatus` never reaches REFUNDED — refunds live on the Refund
 * relation — so the status a seat SHOWS is derived here from the succeeded
 * refunds the read carries, by the same rule the consultee Payments API uses.
 */

import type { PaymentStatus } from "@prisma/client";
import type { PaymentDisplayStatus } from "@/lib/labels/session-labels";

export type SeatPaymentRow = {
  userId: string;
  paymentStatus: PaymentStatus | string;
  amount: bigint | number | string;
  currency: string;
  createdAt: Date | string;
  /** Succeeded refunds against the row, when the read selected them. */
  refunds?: ReadonlyArray<{
    amountPaise: bigint | number | string;
    status?: string;
  }>;
};

/** Paise refunded against the row, counting only refunds that went through. */
export function refundedPaise(row: Pick<SeatPaymentRow, "refunds">): number {
  return (row.refunds ?? [])
    .filter((r) => r.status === undefined || r.status === "SUCCEEDED")
    .reduce((sum, r) => sum + Number(r.amountPaise), 0);
}

/** Full refund wins over partial; only a captured payment can read as refunded. */
export function paymentDisplayStatus(
  row: Pick<SeatPaymentRow, "paymentStatus" | "amount" | "refunds">,
): PaymentDisplayStatus {
  const refunded = refundedPaise(row);
  if (row.paymentStatus === "SUCCEEDED" && refunded > 0) {
    return refunded >= Number(row.amount) ? "REFUNDED" : "PARTIALLY_REFUNDED";
  }
  return row.paymentStatus as PaymentDisplayStatus;
}

/** What the platform still holds of the row after refunds. */
export function netPaise(
  row: Pick<SeatPaymentRow, "amount" | "refunds">,
): number {
  return Math.max(0, Number(row.amount) - refundedPaise(row));
}

/** Which row speaks for a seat when a user has more than one (a class). */
const STATUS_RANK: Record<string, number> = {
  SUCCEEDED: 0,
  PARTIALLY_REFUNDED: 0,
  PENDING: 1,
  FAILED: 2,
  EXPIRED: 3,
  // Money came back: the seat is not paid for, and a newer PENDING row (a
  // rebooking) must speak over it.
  REFUNDED: 3,
};

function rank(status: string): number {
  return STATUS_RANK[status] ?? 4;
}

export function seatPaymentsByUser<T extends SeatPaymentRow>(
  rows: readonly T[],
): Map<string, T> {
  const best = new Map<string, T>();
  for (const row of rows) {
    const current = best.get(row.userId);
    if (!current) {
      best.set(row.userId, row);
      continue;
    }
    const byRank =
      rank(paymentDisplayStatus(row)) - rank(paymentDisplayStatus(current));
    const newer =
      new Date(row.createdAt).getTime() > new Date(current.createdAt).getTime();
    if (byRank < 0 || (byRank === 0 && newer)) best.set(row.userId, row);
  }
  return best;
}

export type SeatPaymentSummary = {
  paid: number;
  pending: number;
  lapsed: number;
  refunded: number;
  /** Net of refunds, in the summary's currency only. */
  collectedPaise: number;
  currency: string;
  /** Seats settled in a currency other than the summary's — never summed. */
  otherCurrency: number;
};

export function summarizeSeatPayments(
  byUser: ReadonlyMap<string, SeatPaymentRow>,
  fallbackCurrency = "INR",
): SeatPaymentSummary {
  const summary: SeatPaymentSummary = {
    paid: 0,
    pending: 0,
    lapsed: 0,
    refunded: 0,
    collectedPaise: 0,
    currency: fallbackCurrency,
    otherCurrency: 0,
  };
  // Every seat on an appointment settles in one currency (ADR 15: INR-only);
  // the first row names it. A row in any other currency is counted, never
  // added — paise of two currencies do not sum.
  let currencySeen = false;
  for (const row of byUser.values()) {
    if (!currencySeen && row.currency) {
      summary.currency = String(row.currency);
      currencySeen = true;
    }
    const status = paymentDisplayStatus(row);
    if (status === "SUCCEEDED" || status === "PARTIALLY_REFUNDED") {
      summary.paid += 1;
      if (String(row.currency) === summary.currency) {
        summary.collectedPaise += netPaise(row);
      } else {
        summary.otherCurrency += 1;
      }
    } else if (status === "PENDING") {
      summary.pending += 1;
    } else if (status === "REFUNDED") {
      summary.refunded += 1;
    } else {
      summary.lapsed += 1;
    }
  }
  return summary;
}

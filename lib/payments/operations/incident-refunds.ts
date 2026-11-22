/**
 * The refund a declared platform incident owes one seat, keyed
 * `incident:<incident>:<occurrence>:<user>`: 100 % of the balance, or the
 * amount already stamped under that key (a settled plan's one-session unit).
 * The marker is stamped first, so a failed drive is re-driven by
 * retry-auto-refunds as well as by the next sweep.
 */

import { PaymentStatus } from "@prisma/client";

import prisma from "@/lib/prisma";
import { incidentRefundKey } from "@/lib/booking/incident-keys";
import { freeTrialPair } from "@/lib/booking/platform-incidents";
import { findDedupedRefund } from "./refund";
import {
  driveRefundOwed,
  markerFromRow,
  REFUND_OWED_SELECT,
  stampRefundOwed,
  type RefundOwedMarker,
} from "./refund-owed";

interface IncidentRefundSeat {
  incidentId: string;
  occurrenceId: string;
  userId: string;
  paymentId: string;
  /** A paid trial is cancelled in the commit that stamps its refund. */
  trialId: string | null;
}

type IncidentRefundOutcome =
  | { kind: "done"; refundedPaise: number }
  /** Nothing is refundable on this payment any more. */
  | { kind: "nothing" }
  /** The payment already owes another door's refund; this one waits behind it. */
  | { kind: "conflict"; heldKey: string }
  | { kind: "blocked" }
  | { kind: "failed"; error: unknown };

function incidentRefundMarker(seat: IncidentRefundSeat): RefundOwedMarker {
  return {
    paymentId: seat.paymentId,
    // Null is the front door's full remaining balance, the only shape the credits rail takes.
    amountPaise: null,
    key: incidentRefundKey(seat.incidentId, seat.occurrenceId, seat.userId),
    reason: `platform incident ${seat.incidentId}: session voided, full refund`,
  };
}

/** Stamps, then drives, one seat's refund; never throws for a refund failure. */
export async function refundIncidentSeat(
  seat: IncidentRefundSeat,
): Promise<IncidentRefundOutcome> {
  const marker = incidentRefundMarker(seat);
  const prior = await findDedupedRefund(marker.key, {
    paymentId: marker.paymentId,
  });
  if (prior) return { kind: "done", refundedPaise: prior.amountRefundedPaise };

  const claim = await prisma.$transaction(async (tx) => {
    let owed = marker;
    if (!(await stampRefundOwed(tx, marker))) {
      const pay = await tx.payment.findUnique({
        where: { id: marker.paymentId },
        select: { ...REFUND_OWED_SELECT, paymentStatus: true, deletedAt: true },
      });
      if (
        !pay ||
        pay.deletedAt ||
        pay.paymentStatus !== PaymentStatus.SUCCEEDED
      ) {
        return { kind: "nothing" as const };
      }
      // The first marker wins; a different key is never overwritten.
      if (pay.refundOwedKey && pay.refundOwedKey !== marker.key) {
        return { kind: "conflict" as const, heldKey: pay.refundOwedKey };
      }
      // This key stamped earlier (a settled plan's one-session unit) keeps its amount.
      owed = markerFromRow(pay) ?? marker;
    }
    if (seat.trialId) await freeTrialPair(tx, seat.trialId, seat.incidentId);
    return { kind: "drive" as const, owed };
  });
  if (claim.kind !== "drive") return claim;

  const outcome = await driveRefundOwed(claim.owed, {
    initiatedByUserId: null,
  });
  switch (outcome.kind) {
    case "refunded":
    case "replayed":
      return {
        kind: "done",
        refundedPaise: outcome.refund.amountRefundedPaise,
      };
    case "settled":
      return { kind: "done", refundedPaise: 0 };
    case "blocked":
      return { kind: "blocked" };
    case "failed":
      return { kind: "failed", error: outcome.error };
  }
}

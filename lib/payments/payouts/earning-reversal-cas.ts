/**
 * The ONE CAS writer for a consultant earning's refund.
 *
 * Three call sites move an earning to REFUNDED — `refundEarnings` (capture-time
 * and dispute-driven), `applyRefundCascade` (the refund front door) and
 * `reverseFreeCreditSettlement` (the free-credit rail). They were originally
 * three near-identical copies, which is precisely the shape that drifts: a
 * fourth copy appeared when the org twin was added. This module makes "one
 * implementation" structural rather than a convention.
 *
 * It lives outside `earnings-service.ts` deliberately, so the two refund front
 * doors can share it without either importing the other or pulling the whole
 * 2,000-line earnings module into their graph.
 */
import { EarningStatus } from "@prisma/client";

import type { PrismaLike } from "@/lib/payments/ledger/post";
import { assertEarningStatusTransitionLegal } from "@/lib/payments/payouts/earning-status";

/**
 * The statuses an earning may legally be moved OUT OF on the way to REFUNDED.
 * Every one of these is accepted because `assertEarningStatusTransitionLegal`
 * only forbids PAID → (anything but REFUNDED); REFUNDED is deliberately ABSENT
 * because it is terminal, so a row some other writer already reversed is never
 * a legal source. This array is the WHERE clause, not a hint.
 */
export const REFUNDABLE_EARNING_SOURCE: EarningStatus[] = [
  EarningStatus.PENDING,
  EarningStatus.PENDING_TRUST,
  EarningStatus.HELD,
  EarningStatus.READY,
  EarningStatus.BATCHED,
  EarningStatus.PAID,
];

export type EarningReversalOutcome = {
  /** Paise this call actually wrote. 0 when the CAS was refused. */
  reversedPaise: number;
  /** `refundedShareAmount` as it stands after this call. */
  refundedShareAmount: number;
  /** The row now sits at/over its share (or was already REFUNDED). */
  fullyRefunded: boolean;
  /** A concurrent writer won the CAS; the value here is the re-read state. */
  lostRace: boolean;
};

/**
 * CAS-in-WHERE writer for a consultant earning's refund (the `#CASC` doctrine
 * `refundEarnings`/`payout-service` already follow: repeat the money predicate
 * in the WHERE, never read-then-write).
 *
 * `assertEarningStatusTransitionLegal` asserts on a value read into JS, so it
 * cannot stop two concurrent refund paths (an app refund racing a lost-dispute
 * webhook, or two cascades) from both reading READY, both passing it, and both
 * writing. The conditional write repeats the guard in the database:
 *
 *   status: { in: REFUNDABLE_EARNING_SOURCE }  — the legal sources, and it
 *     refuses an already-REFUNDED (terminal) row outright.
 *   refundedShareAmount: <pre-read>             — the optimistic half, and what
 *     keeps the cap sound: the value written is an ABSOLUTE
 *     `min(share, preRead + request)`, never an `increment`. Two writers can
 *     therefore only ever compose into `min(share, a + b)`; an `increment`
 *     capped from a stale read (the old shape here) could sum past the share.
 *
 * `count === 0` is a lost race, never "assume it worked": we re-read once and
 * take whatever the cap still allows, so the reversal converges instead of
 * silently dropping this writer's request (a dropped partial clawback is a real
 * under-clawback). A second refusal, a row already at/over its share, or a row
 * another writer has moved to REFUNDED is left to the winner.
 */
export async function applyCappedEarningReversal(
  db: PrismaLike,
  row: {
    id: string;
    consultantSharePaise: number;
    refundedShareAmount: number;
    status: EarningStatus;
  },
  requestPaise: number,
): Promise<EarningReversalOutcome> {
  let current = row;
  for (let attempt = 0; attempt < 2; attempt++) {
    const alreadyRefunded = current.refundedShareAmount ?? 0;
    // The cap, re-derived against the freshest read on every attempt.
    const take = Math.min(
      requestPaise,
      Math.max(0, current.consultantSharePaise - alreadyRefunded),
    );

    if (take <= 0) {
      return {
        reversedPaise: 0,
        refundedShareAmount: alreadyRefunded,
        fullyRefunded:
          alreadyRefunded >= current.consultantSharePaise ||
          current.status === EarningStatus.REFUNDED,
        lostRace: attempt > 0,
      };
    }

    const nextRefundedShare = alreadyRefunded + take;
    const fullyRefunded = nextRefundedShare >= current.consultantSharePaise;
    if (fullyRefunded && attempt > 0) {
      // The retry is driven by a re-read, so the caller's own assertion (made
      // on its pre-read) no longer covers this transition — re-assert here.
      assertEarningStatusTransitionLegal(
        current.id,
        current.status,
        EarningStatus.REFUNDED,
      );
    }

    const { count } = await db.consultantEarnings.updateMany({
      where: {
        id: current.id,
        status: { in: REFUNDABLE_EARNING_SOURCE },
        refundedShareAmount: alreadyRefunded,
      },
      data: {
        refundedShareAmount: nextRefundedShare,
        ...(fullyRefunded && { status: EarningStatus.REFUNDED }),
      },
    });

    if (count > 0) {
      return {
        reversedPaise: take,
        refundedShareAmount: nextRefundedShare,
        fullyRefunded,
        // attempt > 0 => the first CAS was refused and this is the residual.
        lostRace: attempt > 0,
      };
    }

    const fresh = await db.consultantEarnings.findUnique({
      where: { id: current.id },
      select: { status: true, refundedShareAmount: true },
    });
    if (!fresh) {
      // The row is gone; nothing to reverse and nothing to report against.
      return {
        reversedPaise: 0,
        refundedShareAmount: alreadyRefunded,
        fullyRefunded: false,
        lostRace: true,
      };
    }
    current = {
      id: current.id,
      consultantSharePaise: current.consultantSharePaise,
      refundedShareAmount: fresh.refundedShareAmount ?? 0,
      status: fresh.status,
    };
  }

  // Two refusals in a row: report, never claim a write that did not happen.
  console.warn(
    `Earnings ${row.id}: capped reversal CAS refused twice, leaving ` +
      `${requestPaise} paise unapplied (share ${row.consultantSharePaise}, ` +
      `refunded ${row.refundedShareAmount}).`,
  );
  return {
    reversedPaise: 0,
    refundedShareAmount: row.refundedShareAmount ?? 0,
    fullyRefunded: false,
    lostRace: true,
  };
}

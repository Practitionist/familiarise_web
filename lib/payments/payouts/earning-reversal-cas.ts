/**
 * The ONE CAS writer for an earning's refund — consultant OR organisation.
 *
 * Five call sites move an earning to REFUNDED: `refundEarnings` (capture-time
 * and dispute-driven), `applyRefundCascade` (the refund front door) and
 * `reverseFreeCreditSettlement` (the free-credit rail) on the consultant side,
 * and `applyRefundCascade` / `reverseFreeCreditSettlement` on the
 * `OrganizationEarnings` twin. They were originally near-identical copies, which
 * is precisely the shape that drifts: the org twins were still plain
 * `update({ where: { id } })` with no status predicate and no pinned amount, so
 * two concurrent org reversals could both read READY, both pass
 * `assertEarningStatusTransitionLegal` (an assertion over a value read into JS)
 * and both write. This module makes "one implementation" structural rather than
 * a convention: `OrganizationEarnings` is the same shape under a different name,
 * so it gets a rail descriptor, not a second CAS.
 *
 * It lives outside `earnings-service.ts` deliberately, so the two refund front
 * doors can share it without either importing the other or pulling the whole
 * 2,000-line earnings module into their graph.
 */
import { EarningStatus } from "@prisma/client";

import type { PrismaLike } from "@/lib/prisma";
import { assertEarningStatusTransitionLegal } from "@/lib/payments/payouts/earning-status";

/**
 * The statuses a CONSULTANT earning may legally be moved OUT OF on the way to
 * REFUNDED. Every one of these is accepted because
 * `assertEarningStatusTransitionLegal` only forbids PAID → (anything but
 * REFUNDED); REFUNDED is deliberately ABSENT because it is terminal, so a row
 * some other writer already reversed is never a legal source. This array is the
 * WHERE clause, not a hint.
 */
export const REFUNDABLE_EARNING_SOURCE: EarningStatus[] = [
  EarningStatus.PENDING,
  EarningStatus.PENDING_TRUST,
  EarningStatus.HELD,
  EarningStatus.READY,
  EarningStatus.BATCHED,
  EarningStatus.PAID,
];

/**
 * The same set for `OrganizationEarnings` — spelled out, NOT aliased to the
 * consultant array, so a future divergence between the two tables' legal
 * sources is a one-line diff here rather than an invisible coupling. Verified
 * against `prisma/schema.prisma`: both models carry the SAME `EarningStatus`
 * enum and both are written by the same payout/trust crons, so today they agree
 * on all six non-terminal states. The org twin's amount column is
 * `refundedAmountPaise` (not `refundedShareAmount`) and its cap column is
 * `orgSharePaise` (not `consultantSharePaise`) — that is the whole of the
 * difference.
 *
 * `PENDING_TRUST` is included for the same reason the consultant list includes
 * it: a parked, not-yet-verified host org is still owed a clawback the moment
 * its booking is refunded, and the trust-park cron only moves those rows
 * PENDING, it never makes them un-refundable.
 */
export const REFUNDABLE_ORG_EARNING_SOURCE: EarningStatus[] = [
  EarningStatus.PENDING,
  EarningStatus.PENDING_TRUST,
  EarningStatus.HELD,
  EarningStatus.READY,
  EarningStatus.BATCHED,
  EarningStatus.PAID,
];

export type EarningReversalOutcome = {
  /**
   * Paise this call actually wrote — the ONLY figure a caller may post to the
   * ledger or TDS with. It is `<= requestPaise`: the cap clamps it, and a lost
   * race re-reads and takes only the residual. Posting the requested amount
   * instead books paise the earning never absorbed (EARNINGS_LEDGER_DRIFT at
   * reconcile). 0 means the CAS was refused: post nothing at all — a
   * zero-amount `postLedgerTxn` THROWS (each posting must be positive paise).
   */
  reversedPaise: number;
  /** `refundedShareAmount` as it stands after this call. */
  refundedShareAmount: number;
  /** The row now sits at/over its share (or was already REFUNDED). */
  fullyRefunded: boolean;
  /** A concurrent writer won the CAS; the value here is the re-read state. */
  lostRace: boolean;
};

/** The same outcome, named for the org twin's column. */
export type OrgEarningReversalOutcome = {
  reversedPaise: number;
  /** `refundedAmountPaise` as it stands after this call. */
  refundedAmountPaise: number;
  fullyRefunded: boolean;
  lostRace: boolean;
};

/**
 * The two delegate methods the CAS needs. Deliberately loose: the money column
 * NAMES are supplied by the rail, so a single `where`/`data` construction serves
 * both tables instead of each rail re-deriving the predicates — which is
 * precisely where a copy drifts.
 */
type ReversalDelegate = {
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
  findUnique(args: {
    where: { id: string };
    select: Record<string, boolean>;
  }): Promise<Record<string, unknown> | null>;
};

/** Everything that genuinely differs between the two rails, stated once. */
type ReversalRail = {
  /** Human label for warnings ("Earnings" / "Org earnings"). */
  label: string;
  table: ReversalDelegate;
  /** The CUMULATIVE-reversal column: pinned in the WHERE, written absolutely. */
  reversedColumn: "refundedShareAmount" | "refundedAmountPaise";
  /** The WHERE's status predicate. Explicit per rail, never a hidden default. */
  refundableSource: EarningStatus[];
  assertTransition: (
    id: string,
    from: EarningStatus,
    to: EarningStatus,
  ) => void;
};

/** A caller row, normalised. `total` is the cap; `reversed` is the pin. */
type ReversalInput = {
  id: string;
  status: EarningStatus;
  total: number;
  reversed: number | null;
};

type CappedReversalOutcome = {
  reversedPaise: number;
  /** Neutral spelling of `reversed` after this call, on either table. */
  reversedTotalPaise: number;
  fullyRefunded: boolean;
  lostRace: boolean;
};

const consultantRail = (db: PrismaLike): ReversalRail => ({
  label: "Earnings",
  table: db.consultantEarnings as unknown as ReversalDelegate,
  reversedColumn: "refundedShareAmount",
  refundableSource: REFUNDABLE_EARNING_SOURCE,
  assertTransition: assertEarningStatusTransitionLegal,
});

const organizationRail = (db: PrismaLike): ReversalRail => ({
  label: "Org earnings",
  table: db.organizationEarnings as unknown as ReversalDelegate,
  reversedColumn: "refundedAmountPaise",
  refundableSource: REFUNDABLE_ORG_EARNING_SOURCE,
  assertTransition: assertEarningStatusTransitionLegal,
});

/**
 * CAS-in-WHERE writer for an earning's refund, on either table (the `#CASC`
 * doctrine `refundEarnings`/`payout-service` already follow: repeat the money
 * predicate in the WHERE, never read-then-write).
 *
 * `assertEarningStatusTransitionLegal` asserts on a value read into JS, so it
 * cannot stop two concurrent refund paths (an app refund racing a lost-dispute
 * webhook, or two cascades) from both reading READY, both passing it, and both
 * writing. The conditional write repeats the guard in the database:
 *
 *   status: { in: rail.refundableSource } — the legal sources, and it
 *     refuses an already-REFUNDED (terminal) row outright.
 *   <rail.reversedColumn>: <pre-read>    — the optimistic half, and what
 *     keeps the cap sound: the value written is an ABSOLUTE
 *     `min(total, preRead + request)`, never an `increment`. Two writers can
 *     therefore only ever compose into `min(total, a + b)`; an `increment`
 *     capped from a stale read (the old shape on both tables) could sum past
 *     the share and drive the payout readyAmount negative.
 *
 * `count === 0` is a lost race, never "assume it worked": we re-read once and
 * take whatever the cap still allows, so the reversal converges instead of
 * silently dropping this writer's request (a dropped partial clawback is a real
 * under-clawback). A second refusal, a row already at/over its share, or a row
 * another writer has moved to REFUNDED is left to the winner.
 */
async function applyCappedReversal(
  rail: ReversalRail,
  row: ReversalInput,
  requestPaise: number,
): Promise<CappedReversalOutcome> {
  let current = row;
  for (let attempt = 0; attempt < 2; attempt++) {
    const alreadyRefunded = current.reversed ?? 0;
    // The cap, re-derived against the freshest read on every attempt.
    const take = Math.min(
      requestPaise,
      Math.max(0, current.total - alreadyRefunded),
    );

    if (take <= 0) {
      return {
        reversedPaise: 0,
        reversedTotalPaise: alreadyRefunded,
        fullyRefunded:
          alreadyRefunded >= current.total ||
          current.status === EarningStatus.REFUNDED,
        lostRace: attempt > 0,
      };
    }

    const nextReversed = alreadyRefunded + take;
    const fullyRefunded = nextReversed >= current.total;
    // UNCONDITIONAL, on the first attempt as much as on the retry. This is a
    // shared primitive now, so the guard cannot live in the callers: one that
    // forgets its own assertion would otherwise slip an unguarded
    // PAID → REFUNDED (or REFUNDED → anything) straight through. On attempt 0
    // this re-checks the caller's own pre-read value, so it is idempotent with
    // a caller that did assert; on a retry it covers the re-read, which the
    // caller never saw. Either way it runs BEFORE the write, and it only fires
    // when this call actually moves the status.
    if (fullyRefunded) {
      rail.assertTransition(
        current.id,
        current.status,
        EarningStatus.REFUNDED,
      );
    }

    const { count } = await rail.table.updateMany({
      where: {
        id: current.id,
        status: { in: rail.refundableSource },
        [rail.reversedColumn]: alreadyRefunded,
      },
      data: {
        [rail.reversedColumn]: nextReversed,
        ...(fullyRefunded && { status: EarningStatus.REFUNDED }),
      },
    });

    if (count > 0) {
      return {
        reversedPaise: take,
        reversedTotalPaise: nextReversed,
        fullyRefunded,
        // attempt > 0 => the first CAS was refused and this is the residual.
        lostRace: attempt > 0,
      };
    }

    const fresh = await rail.table.findUnique({
      where: { id: current.id },
      select: { status: true, [rail.reversedColumn]: true },
    });
    if (!fresh) {
      // The row is gone; nothing to reverse and nothing to report against.
      return {
        reversedPaise: 0,
        reversedTotalPaise: alreadyRefunded,
        fullyRefunded: false,
        lostRace: true,
      };
    }
    current = {
      id: current.id,
      total: current.total,
      reversed: (fresh[rail.reversedColumn] as number | null) ?? 0,
      status: fresh.status as EarningStatus,
    };
  }

  // Two refusals in a row: report, never claim a write that did not happen.
  console.warn(
    `${rail.label} ${row.id}: capped reversal CAS refused twice, leaving ` +
      `${requestPaise} paise unapplied (share ${row.total}, ` +
      `refunded ${row.reversed}).`,
  );
  return {
    reversedPaise: 0,
    reversedTotalPaise: row.reversed ?? 0,
    fullyRefunded: false,
    lostRace: true,
  };
}

/** The consultant rail. Signature unchanged — `earnings-service.ts` is a caller. */
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
  const out = await applyCappedReversal(
    consultantRail(db),
    {
      id: row.id,
      status: row.status,
      total: row.consultantSharePaise,
      reversed: row.refundedShareAmount,
    },
    requestPaise,
  );
  return {
    reversedPaise: out.reversedPaise,
    refundedShareAmount: out.reversedTotalPaise,
    fullyRefunded: out.fullyRefunded,
    lostRace: out.lostRace,
  };
}

/**
 * The `OrganizationEarnings` twin. Same CAS, same cap arithmetic, same
 * unconditional status guard — the org sites' only differences are the column
 * names and the payout clawback / audit rows their callers own, which still
 * read `reversedPaise` (never their own request) for the same reason the
 * consultant TDS filing does.
 */
export async function applyCappedOrgEarningReversal(
  db: PrismaLike,
  row: {
    id: string;
    orgSharePaise: number;
    refundedAmountPaise: number;
    status: EarningStatus;
  },
  requestPaise: number,
): Promise<OrgEarningReversalOutcome> {
  const out = await applyCappedReversal(
    organizationRail(db),
    {
      id: row.id,
      status: row.status,
      total: row.orgSharePaise,
      reversed: row.refundedAmountPaise,
    },
    requestPaise,
  );
  return {
    reversedPaise: out.reversedPaise,
    refundedAmountPaise: out.reversedTotalPaise,
    fullyRefunded: out.fullyRefunded,
    lostRace: out.lostRace,
  };
}

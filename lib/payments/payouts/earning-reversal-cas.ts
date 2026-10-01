/**
 * The ONE CAS writer for an earning's refund, consultant or organisation, so
 * every REFUNDED writer shares the same status + amount predicate.
 */
import { EarningStatus } from "@prisma/client";

import type { PrismaLike } from "@/lib/prisma";
import { assertEarningStatusTransitionLegal } from "@/lib/payments/payouts/earning-status";

/** Legal sources for a consultant earning -> REFUNDED. REFUNDED is terminal. */
export const REFUNDABLE_EARNING_SOURCE: EarningStatus[] = [
  EarningStatus.PENDING,
  EarningStatus.PENDING_TRUST,
  EarningStatus.HELD,
  EarningStatus.READY,
  EarningStatus.BATCHED,
  EarningStatus.PAID,
];

/** The same set minus PAID, for callers that must not reverse paid-out money. */
export const REFUNDABLE_UNPAID_EARNING_SOURCE: EarningStatus[] =
  REFUNDABLE_EARNING_SOURCE.filter((s) => s !== EarningStatus.PAID);

/** The org twin's set: spelled out so the two tables can diverge in one line. */
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

/** Everything that differs between the two tables, typed per table. */
type ReversalRail = {
  label: string;
  /** Legal sources; the CAS also pins the exact pre-read status. */
  refundableSource: EarningStatus[];
  cas(
    id: string,
    from: EarningStatus,
    pin: number,
    next: number,
    terminal: boolean,
  ): Promise<number>;
  read(id: string): Promise<{ status: EarningStatus; reversed: number } | null>;
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

const consultantRail = (
  db: PrismaLike,
  refundableSource: EarningStatus[],
): ReversalRail => ({
  label: "Earnings",
  refundableSource,
  cas: async (id, from, pin, next, terminal) =>
    (
      await db.consultantEarnings.updateMany({
        where: { id, status: from, refundedShareAmount: pin },
        data: {
          refundedShareAmount: next,
          ...(terminal && { status: EarningStatus.REFUNDED }),
        },
      })
    ).count,
  read: async (id) => {
    const r = await db.consultantEarnings.findUnique({
      where: { id },
      select: { status: true, refundedShareAmount: true },
    });
    return r && { status: r.status, reversed: Number(r.refundedShareAmount) };
  },
});

const organizationRail = (db: PrismaLike): ReversalRail => ({
  label: "Org earnings",
  refundableSource: REFUNDABLE_ORG_EARNING_SOURCE,
  cas: async (id, from, pin, next, terminal) =>
    (
      await db.organizationEarnings.updateMany({
        where: { id, status: from, refundedAmountPaise: pin },
        data: {
          refundedAmountPaise: next,
          ...(terminal && { status: EarningStatus.REFUNDED }),
        },
      })
    ).count,
  read: async (id) => {
    const r = await db.organizationEarnings.findUnique({
      where: { id },
      select: { status: true, refundedAmountPaise: true },
    });
    return r && { status: r.status, reversed: Number(r.refundedAmountPaise) };
  },
});

/**
 * CAS writer: WHERE pins the exact pre-read status (which must be a legal
 * source) and the cumulative reversal; the write is the absolute
 * `min(total, pre + request)`. A refusal re-reads once and takes the residual.
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
    // Asserted here, not in callers, so no caller can bypass it.
    if (fullyRefunded) {
      assertEarningStatusTransitionLegal(
        current.id,
        current.status,
        EarningStatus.REFUNDED,
      );
    }

    // A row that moved out of the caller's legal sources (e.g. BATCHED -> PAID
    // for a non-force caller) is refused, never reversed.
    if (!rail.refundableSource.includes(current.status)) {
      return {
        reversedPaise: 0,
        reversedTotalPaise: alreadyRefunded,
        fullyRefunded: current.status === EarningStatus.REFUNDED,
        lostRace: attempt > 0,
      };
    }

    const count = await rail.cas(
      current.id,
      current.status,
      alreadyRefunded,
      nextReversed,
      fullyRefunded,
    );

    if (count > 0) {
      return {
        reversedPaise: take,
        reversedTotalPaise: nextReversed,
        fullyRefunded,
        // attempt > 0 => the first CAS was refused and this is the residual.
        lostRace: attempt > 0,
      };
    }

    const fresh = await rail.read(current.id);
    if (!fresh) {
      // The row is gone; nothing to reverse and nothing to report against.
      return {
        reversedPaise: 0,
        reversedTotalPaise: alreadyRefunded,
        fullyRefunded: false,
        lostRace: true,
      };
    }
    current = { ...current, status: fresh.status, reversed: fresh.reversed };
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

/**
 * The consultant rail. Pass `REFUNDABLE_UNPAID_EARNING_SOURCE` from any path
 * that must not reverse a PAID row (no TDS reversal / clawback there).
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
  refundableSource: EarningStatus[] = REFUNDABLE_EARNING_SOURCE,
): Promise<EarningReversalOutcome> {
  const out = await applyCappedReversal(
    consultantRail(db, refundableSource),
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

/** The `OrganizationEarnings` twin: same CAS, different column names. */
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

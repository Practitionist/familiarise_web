/**
 * Read-only ledger auditor.
 *
 * Walks the double-entry journal + derived balances to flag drift across:
 *   1. LedgerTransaction/Entry       ← the authoritative double-entry journal
 *   2. LedgerAccountBalance          ← maintained running-balance snapshot
 *   3. BillingAccount.walletBalance  ← derived cache of the WALLET account
 *   4. ProgramAssignment             ← per-(member, cycle) meters & overage counts
 *   5. BillingSubscription           ← activeSeatCount cache
 *   6. ConsultantEarnings / OrganizationEarnings / Payouts ← settlement & split parity
 *
 * Checks that are 100% enforced by active Postgres CHECK constraints, exclusion
 * constraints, or DEFERRABLE constraint triggers (per-txn Dr=Cr balance,
 * PaymentLeg sum, assignment period overlap, INR-only accounts, invoice tax
 * totals, and safe money ranges) live in `prisma/sql/*.sql` and are not
 * re-scanned here.
 */

import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { sumPaise } from "@/lib/payments/utils/money";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";

export type ReconcileScope = {
  /** Human-readable scope tag, e.g. "full" or "org:<orgId>". */
  scope: string;
  /** When present, limit the audit to a single organization. */
  organizationId?: string;
  /** Membership id that initiated this run (null for scheduled cron). */
  triggeredById?: string;
};

export type Finding = {
  kind:
    | "WALLET_BALANCE_DRIFT"
    | "EARNINGS_LEDGER_DRIFT"
    | "PROGRAM_ASSIGNMENT_ENGAGEMENTS_DRIFT"
    | "ACTIVE_SEAT_COUNT_DRIFT"
    | "ORG_PAYOUT_TOTAL_MISMATCH"
    | "CREDIT_POOL_CONSUMED_DRIFT"
    | "OVERAGE_COUNT_DRIFT"
    | "OVERAGE_CHARGESTATUS_INTEGRITY"
    | "LEDGER_BALANCE_SNAPSHOT_DRIFT"
    | "REFUND_BOOKING_COHERENCE"
    | "REVERSED_EARNING_WITHOUT_REFUND_TXN"
    | "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN"
    | "LEDGER_DUAL_WRITE_GAP"
    | "EARNINGS_WITHOUT_BOOKING_TXN"
    | "SPLIT_SUM_MISMATCH"
    | "OVERAGE_SETTLEMENT_MISMATCH";
  organizationId?: string;
  billingAccountId?: string;
  billingSubscriptionId?: string;
  invoiceId?: string;
  paymentId?: string;
  payoutId?: string;
  programAssignmentId?: string;
  expectedPaise: number;
  actualPaise: number;
  deltaPaise: number;
  details?: Record<string, unknown>;
};

export type ReconcileRunStatus = "RUNNING" | "COMPLETED" | "FAILED";

export type ReconcileCounts = {
  orgsChecked: number;
  accountsChecked: number;
  assignmentsChecked: number;
  subscriptionsChecked: number;
  paymentsChecked: number;
  payoutsChecked: number;
  earningsPaymentsWithoutBookingTxn: number;
};

export type ReconcileReport = {
  id: string;
  runAt: Date;
  scope: string;
  ok: boolean;
  durationMs: number;
  summary: ReconcileCounts & {
    discrepanciesCount: number;
    status?: ReconcileRunStatus;
    calls?: number;
  };
  findings: Finding[];
};

export type ReconcileRunSnapshot = {
  runId: string;
  scope: string;
  status: ReconcileRunStatus;
  progress: {
    step: number;
    cursor: string | null;
    calls: number;
    startedAt: string;
  } | null;
  report: ReconcileReport | null;
  error?: string;
};

/** A RUNNING row older than this is a stuck run and no longer blocks a new kick. */
export const RECONCILE_RUN_STALE_MS = 45 * 60 * 1000;

const CHUNK = 5_000;

/**
 * #1408 — the clawback dual-write gap, compared on AMOUNTS rather than on the
 * presence of a posting. Pure helper so unit tests can drive it directly.
 */
export function clawbackDualWriteGapFindings(
  payouts: {
    id: string;
    organizationId: string;
    clawbackAmountPaise: number | bigint;
  }[],
  postedPaiseByPayout: Map<string, number>,
): Finding[] {
  const out: Finding[] = [];
  for (const po of payouts) {
    const expected = Number(po.clawbackAmountPaise);
    if (!Number.isSafeInteger(expected)) {
      throw new Error(
        `clawbackDualWriteGapFindings: OrganizationPayout ${po.id} has clawbackAmountPaise=${po.clawbackAmountPaise}, outside the safe-integer range — the shortfall comparison would round and could suppress a LEDGER_DUAL_WRITE_GAP.`,
      );
    }
    const actual = postedPaiseByPayout.get(po.id) ?? 0;
    if (actual >= expected) continue;
    out.push({
      kind: "LEDGER_DUAL_WRITE_GAP",
      organizationId: po.organizationId,
      payoutId: po.id,
      expectedPaise: expected,
      actualPaise: actual,
      deltaPaise: expected - actual,
      details: {
        scope: "org-payout-clawback",
        note:
          actual === 0
            ? "OrganizationPayout.clawbackAmountPaise > 0 but no clawback:* ledger transaction against this payout."
            : "OrganizationPayout.clawbackAmountPaise exceeds the summed CASH DEBIT of its clawback:* postings — a later clawback's dual write was lost.",
      },
    });
  }
  return out;
}

const DEFAULT_UNJOURNALED_GRACE_MS = 30 * 60 * 1000;
const configuredGraceMs = Number(process.env.RECONCILE_UNJOURNALED_GRACE_MS);
export const RECONCILE_UNJOURNALED_GRACE_MS =
  Number.isFinite(configuredGraceMs) && configuredGraceMs >= 0
    ? configuredGraceMs
    : DEFAULT_UNJOURNALED_GRACE_MS;

/** Q2 — an unjournaled payment is a finding only once the grace has lapsed. */
export function isPastUnjournaledGrace(
  paymentUpdatedAt: Date,
  now: Date = new Date(),
  graceMs: number = RECONCILE_UNJOURNALED_GRACE_MS,
): boolean {
  return now.getTime() - paymentUpdatedAt.getTime() >= graceMs;
}

type StepCtx = {
  opts: ReconcileScope;
  now: Date;
  findings: Finding[];
  counts: ReconcileCounts;
};

// --- (A): per BillingAccount wallet balance vs derived WALLET account (set-based) ---
async function stepWalletBalance(ctx: StepCtx): Promise<void> {
  const accounts = await prisma.billingAccount.findMany({
    where: ctx.opts.organizationId
      ? { ownerOrgId: ctx.opts.organizationId }
      : {},
    select: {
      id: true,
      walletBalance: true,
      ownerOrgId: true,
      currency: true,
    },
  });
  ctx.counts.accountsChecked = accounts.length;
  if (accounts.length === 0) return;

  const walletLedgerAccounts = await prisma.ledgerAccount.findMany({
    where: {
      kind: "WALLET",
      ...(ctx.opts.organizationId
        ? { organizationId: ctx.opts.organizationId }
        : {}),
    },
    select: { id: true, organizationId: true, currency: true },
  });

  const walletAccountIds = walletLedgerAccounts.map((a) => a.id);
  const netByAccountId = new Map<string, number>();
  for (let i = 0; i < walletAccountIds.length; i += CHUNK) {
    const sums = await prisma.ledgerEntry.groupBy({
      by: ["accountId", "direction"],
      where: { accountId: { in: walletAccountIds.slice(i, i + CHUNK) } },
      _sum: { amountPaise: true },
    });
    for (const row of sums) {
      const amt = sumPaise(row._sum.amountPaise);
      const cur = netByAccountId.get(row.accountId) ?? 0;
      // WALLET is a credit-normal liability: amount owed = Σ CREDIT − Σ DEBIT
      netByAccountId.set(
        row.accountId,
        row.direction === "CREDIT" ? cur + amt : cur - amt,
      );
    }
  }

  const walletTotalByOrgCurrency = new Map<string, number>();
  for (const wa of walletLedgerAccounts) {
    if (!wa.organizationId) continue;
    const key = `${wa.organizationId}:${wa.currency}`;
    walletTotalByOrgCurrency.set(
      key,
      (walletTotalByOrgCurrency.get(key) ?? 0) +
        (netByAccountId.get(wa.id) ?? 0),
    );
  }

  for (const acct of accounts) {
    const walletTotal = acct.ownerOrgId
      ? (walletTotalByOrgCurrency.get(`${acct.ownerOrgId}:${acct.currency}`) ??
        0)
      : 0;
    const bal = acct.walletBalance ?? 0;
    if (walletTotal !== bal) {
      ctx.findings.push({
        kind: "WALLET_BALANCE_DRIFT",
        billingAccountId: acct.id,
        organizationId: acct.ownerOrgId ?? undefined,
        expectedPaise: walletTotal,
        actualPaise: bal,
        deltaPaise: bal - walletTotal,
      });
    }
  }
}

// --- (E): per ProgramAssignment engagement / credit-pool / overage meters (set-based) ---
async function stepAssignmentMeters(ctx: StepCtx): Promise<void> {
  const liveAssignments = await prisma.programAssignment.findMany({
    where: {
      periodEnd: { gte: ctx.now },
      ...(ctx.opts.organizationId
        ? {
            program: {
              contract: { organizationId: ctx.opts.organizationId },
            },
          }
        : {}),
    },
    select: {
      id: true,
      engagementsUsed: true,
      consumedPaise: true,
      overageCount: true,
      program: {
        select: {
          type: true,
          contract: { select: { organizationId: true } },
        },
      },
    },
  });
  ctx.counts.assignmentsChecked = liveAssignments.length;
  if (liveAssignments.length === 0) return;

  const assignmentIds = liveAssignments.map((a) => a.id);
  const usageByAssignment = new Map<
    string,
    { engagements: number; pricePaise: number }
  >();
  const overageByAssignment = new Map<string, number>();

  for (let i = 0; i < assignmentIds.length; i += CHUNK) {
    const slice = assignmentIds.slice(i, i + CHUNK);
    const [usageRows, overageRows] = await Promise.all([
      prisma.usageLedgerEntry.groupBy({
        by: ["programAssignmentId"],
        where: { programAssignmentId: { in: slice } },
        _sum: { engagementsConsumed: true, priceAtBookingPaise: true },
      }),
      prisma.overageEvent.groupBy({
        by: ["programAssignmentId"],
        where: {
          programAssignmentId: { in: slice },
          chargeStatus: { notIn: ["REVERSED", "BLOCKED"] },
        },
        _count: { _all: true },
      }),
    ]);
    for (const u of usageRows) {
      if (!u.programAssignmentId) continue;
      usageByAssignment.set(u.programAssignmentId, {
        engagements: u._sum?.engagementsConsumed ?? 0,
        pricePaise: sumPaise(u._sum?.priceAtBookingPaise),
      });
    }
    for (const o of overageRows) {
      overageByAssignment.set(o.programAssignmentId, o._count._all);
    }
  }

  for (const a of liveAssignments) {
    const usage = usageByAssignment.get(a.id);
    const ledgerTotal = usage?.engagements ?? 0;
    if (ledgerTotal !== a.engagementsUsed) {
      ctx.findings.push({
        kind: "PROGRAM_ASSIGNMENT_ENGAGEMENTS_DRIFT",
        programAssignmentId: a.id,
        organizationId: a.program.contract.organizationId,
        expectedPaise: ledgerTotal,
        actualPaise: a.engagementsUsed,
        deltaPaise: a.engagementsUsed - ledgerTotal,
        details: {
          unit: "engagements",
          note: "ProgramAssignment.engagementsUsed disagrees with sum(UsageLedgerEntry.engagementsConsumed). Investigate via the assignment's UsageLedgerEntry trail and the recordBookingUtilization() write path.",
        },
      });
    }

    if (a.program.type === "CREDIT_POOL") {
      const priceTotal = usage?.pricePaise ?? 0;
      if (priceTotal !== a.consumedPaise) {
        ctx.findings.push({
          kind: "CREDIT_POOL_CONSUMED_DRIFT",
          programAssignmentId: a.id,
          organizationId: a.program.contract.organizationId,
          expectedPaise: priceTotal,
          actualPaise: a.consumedPaise,
          deltaPaise: a.consumedPaise - priceTotal,
          details: {
            unit: "paise",
            note: "ProgramAssignment.consumedPaise disagrees with sum(UsageLedgerEntry.priceAtBookingPaise). Investigate the CREDIT_POOL money-meter write in recordBookingUtilization()/reverseBookingUtilization().",
          },
        });
      }
    }

    const liveOverage = overageByAssignment.get(a.id) ?? 0;
    if (liveOverage !== a.overageCount) {
      ctx.findings.push({
        kind: "OVERAGE_COUNT_DRIFT",
        programAssignmentId: a.id,
        organizationId: a.program.contract.organizationId,
        expectedPaise: liveOverage,
        actualPaise: a.overageCount,
        deltaPaise: a.overageCount - liveOverage,
        details: {
          unit: "events",
          note: "ProgramAssignment.overageCount disagrees with count(OverageEvent where chargeStatus not in REVERSED/BLOCKED). Check the bump in recordBookingUtilization() vs the full-reversal decrement in reverseBookingUtilization(); a charged-then-refunded overage is the expected #716 cause.",
        },
      });
    }
  }
}

// --- (G2) #782: OverageEvent link/state integrity ---
async function stepOverageIntegrity(ctx: StepCtx): Promise<void> {
  const badOverage = await prisma.overageEvent.findMany({
    where: {
      ...(ctx.opts.organizationId
        ? {
            programAssignment: {
              program: {
                contract: { organizationId: ctx.opts.organizationId },
              },
            },
          }
        : {}),
      OR: [
        {
          overageBehavior: "CHARGE_MEMBER",
          chargeStatus: { in: ["PENDING", "FAILED", "CHARGED"] },
          paymentId: null,
        },
        {
          overageBehavior: "CHARGE_ORG",
          chargeStatus: "ACCRUED",
          invoiceLineItemId: null,
        },
        {
          overageBehavior: "CHARGE_ORG",
          chargeStatus: "CHARGED",
          invoiceLineItemId: null,
          OR: [
            { paymentId: null },
            { payment: { legs: { none: { source: "WALLET" } } } },
          ],
        },
        { chargeStatus: "CHARGED", settledAt: null },
      ],
    },
    select: {
      id: true,
      overageBehavior: true,
      chargeStatus: true,
      paymentId: true,
      invoiceLineItemId: true,
      settledAt: true,
      marginalPaise: true,
      programAssignment: {
        select: {
          id: true,
          program: {
            select: { contract: { select: { organizationId: true } } },
          },
        },
      },
    },
    take: 500,
  });
  for (const ev of badOverage) {
    ctx.findings.push({
      kind: "OVERAGE_CHARGESTATUS_INTEGRITY",
      programAssignmentId: ev.programAssignment.id,
      organizationId: ev.programAssignment.program.contract.organizationId,
      expectedPaise: ev.marginalPaise,
      actualPaise: ev.marginalPaise,
      deltaPaise: 0,
      details: {
        unit: "event",
        overageEventId: ev.id,
        overageBehavior: ev.overageBehavior,
        chargeStatus: ev.chargeStatus,
        paymentId: ev.paymentId,
        invoiceLineItemId: ev.invoiceLineItemId,
        settledAt: ev.settledAt,
        note: "OverageEvent link/state invariant violated: CHARGE_MEMBER pending/failed/charged without a side-Payment, CHARGE_ORG accrued without an InvoiceLineItem, CHARGE_ORG charged with neither an InvoiceLineItem nor a booking Payment carrying the WALLET leg that collected it (#1458), or CHARGED without settledAt. Trace the transitionOverage() path that produced this state.",
      },
    });
  }
}

// --- (G): per OrganizationPayout total vs claimed earnings ---
async function stepPayoutTotals(ctx: StepCtx): Promise<void> {
  const ATTACHMENT_EXPECTED_STATUSES = [
    "PENDING",
    "APPROVED",
    "PROCESSING",
    "COMPLETED",
  ] as const;
  const payouts = await prisma.organizationPayout.findMany({
    where: {
      status: { in: [...ATTACHMENT_EXPECTED_STATUSES] },
      ...(ctx.opts.organizationId
        ? { organizationId: ctx.opts.organizationId }
        : {}),
    },
    select: {
      id: true,
      organizationId: true,
      netPayoutPaise: true,
      earnings: {
        select: { orgSharePaise: true, refundedAmountPaise: true },
      },
    },
  });
  for (const p of payouts) {
    const expected = p.earnings.reduce(
      (acc, e) => acc + e.orgSharePaise - e.refundedAmountPaise,
      0,
    );
    if (expected !== p.netPayoutPaise) {
      ctx.findings.push({
        kind: "ORG_PAYOUT_TOTAL_MISMATCH",
        organizationId: p.organizationId,
        payoutId: p.id,
        expectedPaise: expected,
        actualPaise: p.netPayoutPaise,
        deltaPaise: p.netPayoutPaise - expected,
        details: {
          earningsCount: p.earnings.length,
          note: "OrganizationPayout.netPayoutPaise diverges from sum(orgShare - refunds) of attached earnings. Only PENDING/APPROVED/PROCESSING/COMPLETED payouts are checked: FAILED, REVERSED and CANCELLED payouts release their earnings back to READY with orgPayoutId cleared, so a zero-earnings total on those is the designed outcome, not drift (#1471).",
        },
      });
    }
  }
  ctx.counts.payoutsChecked = payouts.length;
}

// --- (F): per BillingSubscription activeSeatCount drift (set-based, status=ACTIVE) ---
async function stepSeatCounts(ctx: StepCtx): Promise<void> {
  const subscriptions = await prisma.billingSubscription.findMany({
    where: ctx.opts.organizationId
      ? { contract: { organizationId: ctx.opts.organizationId } }
      : {},
    select: {
      id: true,
      activeSeatCount: true,
      contractId: true,
      contract: {
        select: { organizationId: true },
      },
    },
  });
  ctx.counts.subscriptionsChecked = subscriptions.length;
  if (subscriptions.length === 0) return;

  const contractIds = subscriptions.map((s) => s.contractId);
  const programs = await prisma.program.findMany({
    where: {
      contractId: { in: contractIds },
      type: "LICENSED_SEAT",
      status: "ACTIVE",
    },
    select: { id: true, contractId: true },
  });

  const contractByProgramId = new Map<string, string>(
    programs.map((p) => [p.id, p.contractId]),
  );
  const programIds = programs.map((p) => p.id);
  const seatsByContract = new Map<string, number>();

  for (let i = 0; i < programIds.length; i += CHUNK) {
    const counts = await prisma.programAssignment.groupBy({
      by: ["programId"],
      where: {
        programId: { in: programIds.slice(i, i + CHUNK) },
        status: "ACTIVE",
        periodEnd: { gte: ctx.now },
      },
      _count: { _all: true },
    });
    for (const row of counts) {
      const contractId = contractByProgramId.get(row.programId);
      if (!contractId) continue;
      seatsByContract.set(
        contractId,
        (seatsByContract.get(contractId) ?? 0) + row._count._all,
      );
    }
  }

  for (const sub of subscriptions) {
    const expected = seatsByContract.get(sub.contractId) ?? 0;
    if (expected !== sub.activeSeatCount) {
      ctx.findings.push({
        kind: "ACTIVE_SEAT_COUNT_DRIFT",
        organizationId: sub.contract.organizationId,
        billingSubscriptionId: sub.id,
        expectedPaise: expected,
        actualPaise: sub.activeSeatCount,
        deltaPaise: sub.activeSeatCount - expected,
        details: {
          unit: "seats",
          note: "BillingSubscription.activeSeatCount disagrees with the count of ACTIVE in-period LICENSED_SEAT ProgramAssignments.",
        },
      });
    }
  }
}

// --- (H2) #776 — LedgerAccountBalance snapshot integrity ---
async function stepLedgerSnapshots(ctx: StepCtx): Promise<void> {
  const entrySums = await prisma.ledgerEntry.groupBy({
    by: ["accountId", "direction"],
    _sum: { amountPaise: true },
  });
  const journalByAccount = new Map<string, number>();
  for (const row of entrySums) {
    const amt = sumPaise(row._sum.amountPaise);
    const cur = journalByAccount.get(row.accountId) ?? 0;
    journalByAccount.set(
      row.accountId,
      row.direction === "DEBIT" ? cur + amt : cur - amt,
    );
  }
  const snapshots = await prisma.ledgerAccountBalance.findMany({
    select: { accountId: true, balancePaise: true },
  });
  const snapshotByAccount = new Map<string, number>(
    snapshots.map((s) => [s.accountId, s.balancePaise]),
  );
  const allAccountIds = new Set<string>(
    Array.from(journalByAccount.keys()).concat(
      Array.from(snapshotByAccount.keys()),
    ),
  );
  for (const accountId of Array.from(allAccountIds)) {
    const journal = journalByAccount.get(accountId) ?? 0;
    const snapshot = snapshotByAccount.get(accountId);
    const snapshotVal = snapshot ?? 0;
    if (snapshotVal !== journal) {
      ctx.findings.push({
        kind: "LEDGER_BALANCE_SNAPSHOT_DRIFT",
        expectedPaise: journal,
        actualPaise: snapshotVal,
        deltaPaise: snapshotVal - journal,
        details: {
          ledgerAccountId: accountId,
          unit: "paise",
          snapshotMissing: snapshot === undefined,
          note: "LedgerAccountBalance snapshot disagrees with the journal-derived balance.",
        },
      });
    }
  }
}

// --- (H3) #776 §C — refund ↔ utilization coherence ---
async function stepRefundCoherence(ctx: StepCtx): Promise<void> {
  const utilizations = await prisma.bookingUtilization.findMany({
    select: {
      id: true,
      paymentId: true,
      reversedAt: true,
      payment: {
        select: {
          amount: true,
          refunds: { select: { amountPaise: true, status: true } },
        },
      },
    },
  });
  for (const u of utilizations) {
    const settledRefunds = u.payment.refunds
      .filter((r) => r.status === "SUCCEEDED")
      .reduce((s, r) => s + r.amountPaise, 0);
    const fullyRefunded =
      u.payment.amount > 0 && settledRefunds >= u.payment.amount;
    const isReversed = u.reversedAt !== null;
    if (fullyRefunded && !isReversed) {
      ctx.findings.push({
        kind: "REFUND_BOOKING_COHERENCE",
        paymentId: u.paymentId,
        expectedPaise: u.payment.amount,
        actualPaise: settledRefunds,
        deltaPaise: settledRefunds - u.payment.amount,
        details: {
          bookingUtilizationId: u.id,
          unit: "paise",
          note: "Payment fully refunded but BookingUtilization not reversed (cap leak).",
        },
      });
    } else if (isReversed && settledRefunds === 0) {
      ctx.findings.push({
        kind: "REFUND_BOOKING_COHERENCE",
        paymentId: u.paymentId,
        expectedPaise: 0,
        actualPaise: u.payment.amount,
        deltaPaise: u.payment.amount,
        details: {
          bookingUtilizationId: u.id,
          unit: "paise",
          note: "BookingUtilization reversed with no SUCCEEDED refund (seat released for free).",
        },
      });
    }
  }
}

// --- (E2) booking-ledger drift (set-based) ---
async function stepEarningsLedger(ctx: StepCtx): Promise<void> {
  const bookingTxns = await prisma.ledgerTransaction.findMany({
    where: {
      kind: "BOOKING",
      paymentId: { not: null },
      ...(ctx.opts.organizationId
        ? { payment: { organizationId: ctx.opts.organizationId } }
        : {}),
    },
    select: { id: true, paymentId: true },
  });
  if (bookingTxns.length === 0) return;

  const txnIds = bookingTxns.map((t) => t.id);
  const paymentIds = Array.from(
    new Set(
      bookingTxns.map((t) => t.paymentId).filter((p): p is string => !!p),
    ),
  );

  const journalByTxnId = new Map<string, number>();
  for (let i = 0; i < txnIds.length; i += CHUNK) {
    const creditSums = await prisma.ledgerEntry.groupBy({
      by: ["transactionId"],
      where: {
        transactionId: { in: txnIds.slice(i, i + CHUNK) },
        direction: "CREDIT",
        account: {
          kind: { in: ["PLATFORM_FEE", "CONSULTANT_PAYABLE", "ORG_PAYABLE"] },
        },
      },
      _sum: { amountPaise: true },
    });
    for (const row of creditSums) {
      journalByTxnId.set(row.transactionId, sumPaise(row._sum.amountPaise));
    }
  }

  const cacheByPaymentId = new Map<string, number>();
  for (let i = 0; i < paymentIds.length; i += CHUNK) {
    const slice = paymentIds.slice(i, i + CHUNK);
    const [ceRows, oeRows] = await Promise.all([
      prisma.consultantEarnings.groupBy({
        by: ["paymentId"],
        where: { paymentId: { in: slice } },
        _sum: { platformFeePaise: true, consultantSharePaise: true },
      }),
      prisma.organizationEarnings.groupBy({
        by: ["paymentId"],
        where: { paymentId: { in: slice } },
        _sum: { orgSharePaise: true },
      }),
    ]);
    for (const ce of ceRows) {
      if (!ce.paymentId) continue;
      cacheByPaymentId.set(
        ce.paymentId,
        (cacheByPaymentId.get(ce.paymentId) ?? 0) +
          sumPaise(ce._sum.platformFeePaise) +
          sumPaise(ce._sum.consultantSharePaise),
      );
    }
    for (const oe of oeRows) {
      if (!oe.paymentId) continue;
      cacheByPaymentId.set(
        oe.paymentId,
        (cacheByPaymentId.get(oe.paymentId) ?? 0) +
          sumPaise(oe._sum.orgSharePaise),
      );
    }
  }

  for (const txn of bookingTxns) {
    if (!txn.paymentId) continue;
    const journalEarnings = journalByTxnId.get(txn.id) ?? 0;
    const cacheEarnings = cacheByPaymentId.get(txn.paymentId) ?? 0;
    if (journalEarnings !== cacheEarnings) {
      ctx.findings.push({
        kind: "EARNINGS_LEDGER_DRIFT",
        paymentId: txn.paymentId,
        expectedPaise: cacheEarnings,
        actualPaise: journalEarnings,
        deltaPaise: journalEarnings - cacheEarnings,
        details: {
          unit: "paise",
          note: "Cached Earnings amounts (ConsultantEarnings.platformFee+consultantShare + OrganizationEarnings.orgShare) do not match the booking journal's PLATFORM_FEE+CONSULTANT_PAYABLE+ORG_PAYABLE credits.",
        },
      });
    }
  }
}

// --- #773/#778 §G — earnings-bearing payments with no booking journal txn ---
async function stepUnjournaledEarnings(ctx: StepCtx): Promise<void> {
  const bookingTxns = await prisma.ledgerTransaction.findMany({
    where: { kind: "BOOKING", paymentId: { not: null } },
    select: { paymentId: true },
  });
  const coveredPaymentIds = new Set(
    bookingTxns.map((t) => t.paymentId).filter((p): p is string => !!p),
  );
  const earningsPaymentRows = await prisma.consultantEarnings.findMany({
    select: { paymentId: true },
    distinct: ["paymentId"],
  });
  const candidates = earningsPaymentRows.filter(
    (e) => e.paymentId && !coveredPaymentIds.has(e.paymentId),
  );
  const candidateRows = await prisma.payment.findMany({
    where: { id: { in: candidates.map((e) => e.paymentId!) } },
    select: { id: true, updatedAt: true },
  });
  const now = new Date();
  const settledIds = new Set(
    candidateRows
      .filter((p) => isPastUnjournaledGrace(p.updatedAt, now))
      .map((p) => p.id),
  );
  const unjournaled = candidates.filter((e) => settledIds.has(e.paymentId!));
  const earningsPaymentsWithoutBookingTxn = unjournaled.length;
  const unjournaledMax = Number(process.env.RECONCILE_UNJOURNALED_MAX ?? 0);
  if (earningsPaymentsWithoutBookingTxn > unjournaledMax) {
    ctx.findings.push({
      kind: "EARNINGS_WITHOUT_BOOKING_TXN",
      expectedPaise: unjournaledMax,
      actualPaise: earningsPaymentsWithoutBookingTxn,
      deltaPaise: earningsPaymentsWithoutBookingTxn - unjournaledMax,
      details: {
        unit: "payments",
        samplePaymentIds: unjournaled.slice(0, 10).map((e) => e.paymentId),
        note: "Earnings-bearing payments older than the post-commit grace window missing a BOOKING ledger transaction exceed the allowed threshold (#773; Q2 grace via RECONCILE_UNJOURNALED_GRACE_MS).",
      },
    });
  }
  ctx.counts.earningsPaymentsWithoutBookingTxn =
    earningsPaymentsWithoutBookingTxn;
}

// --- #812 — a reversed earning with no REFUND ledger transaction ---
async function stepReversedEarnings(ctx: StepCtx): Promise<void> {
  const reversedEarnings = await prisma.consultantEarnings.findMany({
    where: {
      refundedShareAmount: { gt: 0 },
      ...(ctx.opts.organizationId
        ? { payment: { organizationId: ctx.opts.organizationId } }
        : {}),
    },
    select: {
      id: true,
      paymentId: true,
      refundedShareAmount: true,
      payment: { select: { organizationId: true } },
    },
  });
  const reversedPaymentIds = reversedEarnings
    .map((r) => r.paymentId)
    .filter((p): p is string => !!p);
  const refundTxns = await prisma.ledgerTransaction.findMany({
    where: { kind: "REFUND", paymentId: { in: reversedPaymentIds } },
    select: { paymentId: true },
  });
  const refundedPaymentIds = new Set(
    refundTxns.map((t) => t.paymentId).filter((p): p is string => !!p),
  );
  for (const rev of reversedEarnings) {
    if (!rev.paymentId) continue;
    if (!refundedPaymentIds.has(rev.paymentId)) {
      ctx.findings.push({
        kind: "REVERSED_EARNING_WITHOUT_REFUND_TXN",
        paymentId: rev.paymentId,
        organizationId: rev.payment?.organizationId ?? undefined,
        expectedPaise: rev.refundedShareAmount,
        actualPaise: 0,
        deltaPaise: rev.refundedShareAmount,
        details: {
          consultantEarningsId: rev.id,
          note: "ConsultantEarnings.refundedShareAmount > 0 but no REFUND ledger transaction for this payment.",
        },
      });
    }
  }
}

// --- #812 — a COMPLETED OrganizationPayout with no ORG_PAYOUT ledger transaction ---
async function stepCompletedOrgPayouts(ctx: StepCtx): Promise<void> {
  const completedPayouts = await prisma.organizationPayout.findMany({
    where: {
      status: "COMPLETED",
      ...(ctx.opts.organizationId
        ? { organizationId: ctx.opts.organizationId }
        : {}),
    },
    select: { id: true, organizationId: true, netPayoutPaise: true },
  });
  const orgPayoutTxns = await prisma.ledgerTransaction.findMany({
    where: {
      idempotencyKey: {
        in: completedPayouts.map((po) => `orgpayout:${po.id}`),
      },
    },
    select: { idempotencyKey: true },
  });
  const orgPayoutTxnKeys = new Set(orgPayoutTxns.map((t) => t.idempotencyKey));
  for (const po of completedPayouts) {
    if (!orgPayoutTxnKeys.has(`orgpayout:${po.id}`)) {
      ctx.findings.push({
        kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
        organizationId: po.organizationId,
        payoutId: po.id,
        expectedPaise: po.netPayoutPaise,
        actualPaise: 0,
        deltaPaise: po.netPayoutPaise,
        details: {
          scope: "org",
          note: "OrganizationPayout.status=COMPLETED but no ORG_PAYOUT ledger transaction.",
        },
      });
    }
  }
}

// --- #1408 — clawback dual-write gap ---
async function stepClawbackGap(ctx: StepCtx): Promise<void> {
  const clawedBackPayouts = await prisma.organizationPayout.findMany({
    where: {
      clawbackAmountPaise: { gt: 0 },
      ...(ctx.opts.organizationId
        ? { organizationId: ctx.opts.organizationId }
        : {}),
    },
    select: { id: true, organizationId: true, clawbackAmountPaise: true },
  });
  if (clawedBackPayouts.length === 0) return;
  const clawbackPostedByPayout = new Map<string, number>();
  for (let i = 0; i < clawedBackPayouts.length; i += CHUNK) {
    const clawbackTxns = await prisma.ledgerTransaction.findMany({
      where: {
        payoutId: {
          in: clawedBackPayouts.slice(i, i + CHUNK).map((po) => po.id),
        },
        idempotencyKey: { startsWith: "clawback:" },
      },
      select: {
        payoutId: true,
        entries: {
          where: { direction: "DEBIT", account: { kind: "CASH" } },
          select: { amountPaise: true },
        },
      },
    });
    for (const t of clawbackTxns) {
      if (!t.payoutId) continue;
      const posted = t.entries.reduce((sum, e) => {
        const paise = Number(e.amountPaise);
        if (!Number.isSafeInteger(paise)) {
          throw new Error(
            `clawback posting for payout ${t.payoutId} has amountPaise=${e.amountPaise}, outside the safe-integer range.`,
          );
        }
        return sum + paise;
      }, 0);
      clawbackPostedByPayout.set(
        t.payoutId,
        (clawbackPostedByPayout.get(t.payoutId) ?? 0) + posted,
      );
    }
  }
  ctx.findings.push(
    ...clawbackDualWriteGapFindings(clawedBackPayouts, clawbackPostedByPayout),
  );
}

// --- #813 — COMPLETED ConsultantPayout without PAYOUT ledger transaction ---
async function stepConsultantPayouts(ctx: StepCtx): Promise<void> {
  const completedConsultantPayouts = await prisma.consultantPayout.findMany({
    where: { status: "COMPLETED", amount: { gt: 0 } },
    select: { id: true, amount: true },
  });
  const consultantPayoutTxns = await prisma.ledgerTransaction.findMany({
    where: {
      idempotencyKey: {
        in: completedConsultantPayouts.map((p) => `payout:${p.id}`),
      },
    },
    select: { idempotencyKey: true },
  });
  const consultantPayoutTxnKeys = new Set(
    consultantPayoutTxns.map((t) => t.idempotencyKey),
  );
  for (const p of completedConsultantPayouts) {
    if (!consultantPayoutTxnKeys.has(`payout:${p.id}`)) {
      ctx.findings.push({
        kind: "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN",
        payoutId: p.id,
        expectedPaise: p.amount,
        actualPaise: 0,
        deltaPaise: p.amount,
        details: {
          scope: "consultant",
          note: "ConsultantPayout.status=COMPLETED but no PAYOUT ledger transaction.",
        },
      });
    }
  }
}

// --- (P) #778 §C/§G — split-sums-to-the-paise ---
async function stepSplitSums(ctx: StepCtx): Promise<void> {
  const ceAgg = await prisma.consultantEarnings.groupBy({
    by: ["paymentId"],
    _sum: { platformFeePaise: true, consultantSharePaise: true },
    ...(ctx.opts.organizationId
      ? { where: { payment: { organizationId: ctx.opts.organizationId } } }
      : {}),
  });
  const paymentIdsWithCe = ceAgg
    .map((r) => r.paymentId)
    .filter((p): p is string => !!p);
  const oeAgg = await prisma.organizationEarnings.groupBy({
    by: ["paymentId"],
    _sum: { orgSharePaise: true },
    ...(ctx.opts.organizationId
      ? { where: { payment: { organizationId: ctx.opts.organizationId } } }
      : {}),
  });
  const oeByPayment = new Map(
    oeAgg.map((r) => [r.paymentId, sumPaise(r._sum.orgSharePaise)]),
  );
  const grossById = new Map<
    string,
    { id: string; originalAmount: number; organizationId: string | null }
  >();
  for (let i = 0; i < paymentIdsWithCe.length; i += CHUNK) {
    const rows = await prisma.payment.findMany({
      where: { id: { in: paymentIdsWithCe.slice(i, i + CHUNK) } },
      select: { id: true, originalAmount: true, organizationId: true },
    });
    for (const p of rows) grossById.set(p.id, p);
  }
  ctx.counts.paymentsChecked = grossById.size;
  for (const row of ceAgg) {
    if (!row.paymentId) continue;
    const p = grossById.get(row.paymentId);
    if (!p) continue;
    const splitSum =
      sumPaise(row._sum.platformFeePaise) +
      sumPaise(row._sum.consultantSharePaise) +
      (oeByPayment.get(row.paymentId) ?? 0);
    if (splitSum !== p.originalAmount) {
      ctx.findings.push({
        kind: "SPLIT_SUM_MISMATCH",
        paymentId: p.id,
        organizationId: p.organizationId ?? undefined,
        expectedPaise: p.originalAmount,
        actualPaise: splitSum,
        deltaPaise: splitSum - p.originalAmount,
        details: {
          unit: "paise",
          note: "Σ(platform fee + consultant shares + org shares) diverges from Payment.originalAmount — a split leaked or minted paise (#778 §C).",
        },
      });
    }
  }
}

// --- (Q) #775/#782 — CHARGE_MEMBER overage settlement coherence ---
async function stepOverageSettlement(ctx: StepCtx): Promise<void> {
  const memberEvents = await prisma.overageEvent.findMany({
    where: { overageBehavior: "CHARGE_MEMBER" },
    select: {
      id: true,
      chargeStatus: true,
      marginalPaise: true,
      paymentId: true,
      settledAt: true,
      payment: {
        select: {
          paymentStatus: true,
          amount: true,
          parentPaymentId: true,
          organizationId: true,
        },
      },
    },
  });
  const sideIds = memberEvents
    .map((e) => e.paymentId)
    .filter((p): p is string => !!p);
  const txnKeys = new Set<string>();
  for (let i = 0; i < sideIds.length; i += CHUNK) {
    const overageTxns = await prisma.ledgerTransaction.findMany({
      where: {
        idempotencyKey: {
          in: sideIds.slice(i, i + CHUNK).map((id) => `overage:${id}`),
        },
      },
      select: { idempotencyKey: true },
    });
    for (const t of overageTxns) txnKeys.add(t.idempotencyKey);
  }
  for (const ev of memberEvents) {
    const hasTxn = !!ev.paymentId && txnKeys.has(`overage:${ev.paymentId}`);
    const flag = (note: string) =>
      ctx.findings.push({
        kind: "OVERAGE_SETTLEMENT_MISMATCH",
        paymentId: ev.paymentId ?? undefined,
        organizationId: ev.payment?.organizationId ?? undefined,
        expectedPaise: ev.marginalPaise,
        actualPaise: ev.payment?.amount ?? 0,
        deltaPaise: (ev.payment?.amount ?? 0) - ev.marginalPaise,
        details: {
          overageEventId: ev.id,
          chargeStatus: ev.chargeStatus,
          unit: "paise",
          note,
        },
      });
    if (ev.chargeStatus === "CHARGED") {
      if (!ev.paymentId || ev.payment?.paymentStatus !== "SUCCEEDED") {
        flag("CHARGED member overage without a SUCCEEDED side-payment.");
      } else if (!hasTxn) {
        flag(
          "CHARGED member overage but no overage:<sidePaymentId> ledger txn — ORG_PAYABLE was never credited.",
        );
      } else if (ev.payment.amount !== ev.marginalPaise) {
        flag("Side-payment amount diverges from the event's marginalPaise.");
      } else if (!ev.settledAt) {
        flag("CHARGED member overage missing settledAt.");
      }
    } else if (
      (ev.chargeStatus === "PENDING" || ev.chargeStatus === "FAILED") &&
      hasTxn
    ) {
      flag(
        "Un-collected member overage has an overage ledger txn — money posted without a CHARGED event.",
      );
    }
  }
}

const EMPTY_COUNTS: ReconcileCounts = {
  orgsChecked: 0,
  accountsChecked: 0,
  assignmentsChecked: 0,
  subscriptionsChecked: 0,
  paymentsChecked: 0,
  payoutsChecked: 0,
  earningsPaymentsWithoutBookingTxn: 0,
};

/** True when the row belongs to a run that is still being advanced. */
export function isReconcileRunInProgress(row: { summary: unknown }): boolean {
  const s = (row.summary ?? {}) as { status?: string };
  return s.status === "RUNNING";
}

/** The newest full-scope run still RUNNING and younger than the stale window, if any. */
export async function findInFlightReconcileRun(): Promise<string | null> {
  const recent = await prisma.ledgerReconciliationReport.findMany({
    where: {
      scope: "full",
      runAt: { gte: new Date(Date.now() - RECONCILE_RUN_STALE_MS) },
    },
    orderBy: { runAt: "desc" },
    take: 5,
    select: { id: true, summary: true },
  });
  return recent.find(isReconcileRunInProgress)?.id ?? null;
}

/** Open a run as `ok=false` + RUNNING. */
export async function createReconcileRun(
  opts: ReconcileScope,
  id?: string,
): Promise<string> {
  const summary = {
    ...EMPTY_COUNTS,
    status: "RUNNING" as const,
  };
  const row = await prisma.ledgerReconciliationReport.create({
    data: {
      ...(id ? { id } : {}),
      scope: opts.scope,
      ok: false,
      durationMs: 0,
      summary: summary as unknown as Prisma.InputJsonValue,
      findings: [],
      triggeredById: opts.triggeredById ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

/** Close a RUNNING run that can no longer be advanced. */
export async function markReconcileRunFailed(
  runId: string,
  error: string,
): Promise<void> {
  const row = await prisma.ledgerReconciliationReport.findUnique({
    where: { id: runId },
    select: { summary: true },
  });
  if (!row || !isReconcileRunInProgress(row)) return;
  const summary = {
    ...EMPTY_COUNTS,
    ...((row.summary as Record<string, unknown>) ?? {}),
    status: "FAILED" as const,
    error,
  };
  await prisma.ledgerReconciliationReport.update({
    where: { id: runId },
    data: { summary: summary as unknown as Prisma.InputJsonValue },
  });
}

async function executeSteps(opts: ReconcileScope): Promise<{
  ctx: StepCtx;
  durationMs: number;
}> {
  const startedAt = Date.now();
  const ctx: StepCtx = {
    opts,
    now: new Date(startedAt),
    findings: [],
    counts: { ...EMPTY_COUNTS },
  };

  await stepWalletBalance(ctx);
  await stepAssignmentMeters(ctx);
  await stepOverageIntegrity(ctx);
  await stepPayoutTotals(ctx);
  await stepSeatCounts(ctx);
  if (!opts.organizationId) {
    await stepLedgerSnapshots(ctx);
    await stepRefundCoherence(ctx);
  }
  await stepEarningsLedger(ctx);
  await stepUnjournaledEarnings(ctx);
  await stepReversedEarnings(ctx);
  await stepCompletedOrgPayouts(ctx);
  await stepClawbackGap(ctx);
  if (!opts.organizationId) {
    await stepConsultantPayouts(ctx);
  }
  await stepSplitSums(ctx);
  await stepOverageSettlement(ctx);

  return { ctx, durationMs: Date.now() - startedAt };
}

async function runReconcileLedgersUnlocked(
  opts: ReconcileScope,
  existingRunId?: string,
): Promise<ReconcileReport> {
  const runId = existingRunId ?? (await createReconcileRun(opts));
  const { ctx, durationMs } = await executeSteps(opts);
  const ok = ctx.findings.length === 0;
  const summary = {
    ...ctx.counts,
    discrepanciesCount: ctx.findings.length,
    status: "COMPLETED" as const,
    calls: 1,
  };

  const report = await prisma.ledgerReconciliationReport.update({
    where: { id: runId },
    data: {
      ok,
      durationMs,
      summary: summary as unknown as Prisma.InputJsonValue,
      findings: ctx.findings as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    id: report.id,
    runAt: report.runAt,
    scope: opts.scope,
    ok: report.ok,
    durationMs: report.durationMs,
    summary,
    findings: ctx.findings,
  };
}

/** Single-pass wrapper preserving the HTTP cleanup route signature. */
export async function advanceReconcileRun(args: {
  runId: string;
  limit?: number;
  budgetMs?: number;
  createIfMissing?: ReconcileScope;
}): Promise<ReconcileRunSnapshot> {
  return withCronLock(
    "reconcile-ledgers",
    { failMode: "open", ttlMs: LONG_JOB_TTL_MS },
    async () => {
      let row = await prisma.ledgerReconciliationReport.findUnique({
        where: { id: args.runId },
      });
      if (!row && args.createIfMissing) {
        await createReconcileRun(args.createIfMissing, args.runId);
        row = await prisma.ledgerReconciliationReport.findUnique({
          where: { id: args.runId },
        });
      }
      if (!row) throw new Error(`reconcile run ${args.runId} not found`);
      const opts: ReconcileScope = row.scope.startsWith("org:")
        ? {
            scope: row.scope,
            organizationId: row.scope.slice("org:".length),
          }
        : { scope: row.scope };
      const report = await runReconcileLedgersUnlocked(opts, row.id);
      return {
        runId: row.id,
        scope: row.scope,
        status: "COMPLETED",
        progress: null,
        report,
      };
    },
  );
}

export async function runReconcileLedgers(
  opts: ReconcileScope,
): Promise<ReconcileReport> {
  return withCronLock(
    "reconcile-ledgers",
    { failMode: "open", ttlMs: LONG_JOB_TTL_MS },
    () => runReconcileLedgersUnlocked(opts),
  );
}

/**
 * Read-only ledger auditor.
 *
 * Walks the double-entry journal + derived balances to flag drift across:
 *   1. LedgerTransaction/Entry       ← the authoritative double-entry journal
 *   2. BillingAccount.walletBalance  ← derived cache of the WALLET account
 *   3. ProgramAssignment             ← per-(member, cycle) meters & overage counts
 *   4. BillingSubscription           ← activeSeatCount cache
 *   5. ConsultantEarnings / OrganizationEarnings / Payouts ← settlement & split parity
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
import { ledgerAccountId } from "@/lib/payments/ledger/post";
import {
  orgInvoiceGstFindings,
  staleClawbackFindings,
} from "./tax-and-clawback-steps";

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
    | "REFUND_BOOKING_COHERENCE"
    | "REVERSED_EARNING_WITHOUT_REFUND_TXN"
    | "COMPLETED_PAYOUT_WITHOUT_LEDGER_TXN"
    | "LEDGER_DUAL_WRITE_GAP"
    | "EARNINGS_WITHOUT_BOOKING_TXN"
    | "SPLIT_SUM_MISMATCH"
    | "OVERAGE_SETTLEMENT_MISMATCH"
    // An anti-invoice-fraud park older than 24h. Detect-only: age never
    // releases a park.
    | "PENDING_TRUST_PARK_STALE"
    // The referral-credit liability disagrees with the vested, unredeemed credit balance.
    | "REFERRAL_CREDIT_LIABILITY_DRIFT"
    // A settled refund of a parked capture left UNAPPLIED_RECEIPTS non-zero.
    | "UNAPPLIED_RECEIPTS_RESIDUE"
    // An org invoice's output tax differs from the GST_PAYABLE its bookings posted.
    | "ORG_INVOICE_GST_MISMATCH"
    // One per run: clawbacks still unrecovered after the 90-day window.
    | "CLAWBACK_RECEIVABLE_STALE";
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
  // Earnings first: a row and its booking journal commit in one transaction, so
  // any earnings row read here has its journal visible to the read below.
  const earningsPaymentRows = await prisma.consultantEarnings.findMany({
    select: { paymentId: true },
    distinct: ["paymentId"],
  });
  const bookingTxns = await prisma.ledgerTransaction.findMany({
    where: { kind: "BOOKING", paymentId: { not: null } },
    select: { paymentId: true },
  });
  const coveredPaymentIds = new Set(
    bookingTxns.map((t) => t.paymentId).filter((p): p is string => !!p),
  );
  const unjournaled = earningsPaymentRows.filter(
    (e) => e.paymentId && !coveredPaymentIds.has(e.paymentId),
  );
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
        note: "Earnings-bearing payments missing a BOOKING ledger transaction exceed the allowed threshold.",
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

type MemberOverageEventRow = {
  id: string;
  chargeStatus: string;
  basePaise: number;
  marginalPaise: number;
  paymentId: string | null;
  settledAt: Date | null;
  payment: {
    paymentStatus: string;
    amount: number;
    parentPaymentId: string | null;
    organizationId: string | null;
  } | null;
  creditNote?: { subtotalPaise: number | bigint } | null;
};

function inspectOverageEventLedgerState(
  ev: MemberOverageEventRow,
  txnKeys: Set<string>,
  recarveReversalAmounts: Map<string, number>,
  creditNoteByOverageEventId: Map<
    string,
    { id: string; subtotalPaise: number | bigint }
  >,
  findings: StepCtx["findings"],
): void {
  const hasTxn = !!ev.paymentId && txnKeys.has(`overage:${ev.paymentId}`);
  const flag = (
    note: string,
    expected = ev.marginalPaise,
    actual = ev.payment?.amount ?? 0,
  ) =>
    findings.push({
      kind: "OVERAGE_SETTLEMENT_MISMATCH",
      paymentId: ev.paymentId ?? undefined,
      organizationId: ev.payment?.organizationId ?? undefined,
      expectedPaise: expected,
      actualPaise: actual,
      deltaPaise: actual - expected,
      details: {
        overageEventId: ev.id,
        chargeStatus: ev.chargeStatus,
        unit: "paise",
        note,
      },
    });

  if (ev.chargeStatus === "CHARGED") {
    if (ev.payment?.paymentStatus !== "SUCCEEDED") {
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

  if (
    !ev.paymentId ||
    !recarveReversalAmounts.has(`overage-recarve-invoice:${ev.paymentId}`)
  ) {
    return;
  }

  const reversalPaise = recarveReversalAmounts.get(
    `overage-recarve-invoice:${ev.paymentId}`,
  );
  const creditNote =
    ev.creditNote ?? creditNoteByOverageEventId.get(ev.id) ?? null;
  if (reversalPaise === undefined || reversalPaise <= 0) {
    flag(
      "overage-recarve-invoice ledger reversal has non-positive DEBIT sum.",
      ev.basePaise,
      reversalPaise ?? 0,
    );
  } else if (!creditNote) {
    flag(
      "overage-recarve-invoice ledger reversal exists without a corresponding CreditNote on the OverageEvent.",
      reversalPaise,
      0,
    );
  } else if (Number(creditNote.subtotalPaise) !== reversalPaise) {
    flag(
      `CreditNote subtotalPaise (${Number(creditNote.subtotalPaise)}) does not match overage-recarve-invoice ledger reversal (${reversalPaise}).`,
      reversalPaise,
      Number(creditNote.subtotalPaise),
    );
  }
}

async function loadRecarveCreditNotes(
  memberEvents: MemberOverageEventRow[],
  recarveReversalAmounts: Map<string, number>,
): Promise<Map<string, { id: string; subtotalPaise: number | bigint }>> {
  const creditNoteByOverageEventId = new Map<
    string,
    { id: string; subtotalPaise: number | bigint }
  >();
  if (
    recarveReversalAmounts.size === 0 ||
    typeof (prisma as unknown as { creditNote?: { findMany?: unknown } })
      .creditNote?.findMany !== "function"
  ) {
    return creditNoteByOverageEventId;
  }
  const recarveEventIds = memberEvents
    .filter(
      (e) =>
        !!e.paymentId &&
        recarveReversalAmounts.has(`overage-recarve-invoice:${e.paymentId}`),
    )
    .map((e) => e.id);
  if (recarveEventIds.length === 0) return creditNoteByOverageEventId;

  const notes = await prisma.creditNote.findMany({
    where: { overageEventId: { in: recarveEventIds } },
    select: { id: true, overageEventId: true, subtotalPaise: true },
  });
  for (const cn of notes) {
    if (cn.overageEventId) {
      creditNoteByOverageEventId.set(cn.overageEventId, cn);
    }
  }
  return creditNoteByOverageEventId;
}

// --- (Q) #775/#782/#1900 — CHARGE_MEMBER overage settlement coherence ---
async function stepOverageSettlement(ctx: StepCtx): Promise<void> {
  const memberEvents = await prisma.overageEvent.findMany({
    where: { overageBehavior: "CHARGE_MEMBER" },
    select: {
      id: true,
      chargeStatus: true,
      basePaise: true,
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
  const recarveReversalAmounts = new Map<string, number>();
  for (let i = 0; i < sideIds.length; i += CHUNK) {
    const slice = sideIds.slice(i, i + CHUNK);
    const overageTxns = await prisma.ledgerTransaction.findMany({
      where: {
        idempotencyKey: {
          in: [
            ...slice.map((id) => `overage:${id}`),
            ...slice.map((id) => `overage-recarve-invoice:${id}`),
          ],
        },
      },
      select: {
        idempotencyKey: true,
        entries: {
          where: { direction: "DEBIT" },
          select: { amountPaise: true },
        },
      },
    });
    for (const t of overageTxns) {
      if (t.idempotencyKey.startsWith("overage-recarve-invoice:")) {
        const debitSum = t.entries.reduce(
          (s, p) => s + Number(p.amountPaise),
          0,
        );
        recarveReversalAmounts.set(t.idempotencyKey, debitSum);
      } else {
        txnKeys.add(t.idempotencyKey);
      }
    }
  }
  const creditNoteByOverageEventId = await loadRecarveCreditNotes(
    memberEvents,
    recarveReversalAmounts,
  );
  for (const ev of memberEvents) {
    inspectOverageEventLedgerState(
      ev,
      txnKeys,
      recarveReversalAmounts,
      creditNoteByOverageEventId,
      ctx.findings,
    );
  }
}

// --- a parked capture's UNAPPLIED_RECEIPTS balance matches what is still owed back ---
async function stepUnappliedReceipts(ctx: StepCtx): Promise<void> {
  const parked = await prisma.ledgerTransaction.findMany({
    where: { kind: "UNAPPLIED_RECEIPT", paymentId: { not: null } },
    select: { paymentId: true },
    distinct: ["paymentId"],
  });
  const paymentIds = parked
    .map((t) => t.paymentId)
    .filter((p): p is string => !!p);

  for (let i = 0; i < paymentIds.length; i += CHUNK) {
    const slice = paymentIds.slice(i, i + CHUNK);
    const balances = await unappliedBalances(slice);
    const settled = await settledRefundTotals(slice);
    for (const paymentId of slice) {
      const refundedPaise = settled.get(paymentId);
      const balance = balances.get(paymentId);
      if (refundedPaise === undefined || !balance) continue;
      // A recovered capture released its remainder; otherwise each settled refund returned its share.
      const expectedPaise =
        balance.releasedPaise > 0
          ? 0
          : Math.max(0, balance.parkedPaise - refundedPaise);
      if (balance.owedPaise === expectedPaise) continue;
      ctx.findings.push({
        kind: "UNAPPLIED_RECEIPTS_RESIDUE",
        paymentId,
        expectedPaise,
        actualPaise: balance.owedPaise,
        deltaPaise: balance.owedPaise - expectedPaise,
        details: {
          unit: "paise",
          note: "A parked capture's UNAPPLIED_RECEIPTS balance differs from the captured amount less its settled refunds (positive: a settled refund never posted its clearing entry).",
        },
      });
    }
  }
}

type UnappliedBalance = {
  parkedPaise: number;
  releasedPaise: number;
  owedPaise: number;
};

/** Per payment: paise parked, paise released into a booking, and the net still held. */
async function unappliedBalances(
  paymentIds: string[],
): Promise<Map<string, UnappliedBalance>> {
  const entries = await prisma.ledgerEntry.findMany({
    where: {
      account: { kind: "UNAPPLIED_RECEIPTS" },
      transaction: { paymentId: { in: paymentIds } },
    },
    select: {
      direction: true,
      amountPaise: true,
      transaction: { select: { paymentId: true, kind: true } },
    },
  });
  const balances = new Map<string, UnappliedBalance>();
  for (const e of entries) {
    const paymentId = e.transaction.paymentId;
    if (!paymentId) continue;
    const paise = sumPaise(e.amountPaise);
    const b = balances.get(paymentId) ?? {
      parkedPaise: 0,
      releasedPaise: 0,
      owedPaise: 0,
    };
    if (e.direction === "CREDIT") {
      b.parkedPaise += paise;
      b.owedPaise += paise;
    } else {
      if (e.transaction.kind === "UNAPPLIED_RECEIPT") b.releasedPaise += paise;
      b.owedPaise -= paise;
    }
    balances.set(paymentId, b);
  }
  return balances;
}

/** Settled refund paise per payment, only for payments with no refund still in flight. */
async function settledRefundTotals(
  paymentIds: string[],
): Promise<Map<string, number>> {
  const refunds = await prisma.refund.findMany({
    where: { paymentId: { in: paymentIds }, deletedAt: null },
    select: {
      paymentId: true,
      status: true,
      cascadedAt: true,
      amountPaise: true,
    },
  });
  // Credit restorations (0 paise) settle in place and never cascade.
  const inFlight = (r: (typeof refunds)[number]) =>
    r.status === "PENDING" ||
    (r.status === "SUCCEEDED" &&
      r.cascadedAt === null &&
      sumPaise(r.amountPaise) > 0);
  const open = new Set(refunds.filter(inFlight).map((r) => r.paymentId));
  const totals = new Map<string, number>();
  for (const r of refunds) {
    if (r.status !== "SUCCEEDED" || open.has(r.paymentId)) continue;
    totals.set(
      r.paymentId,
      (totals.get(r.paymentId) ?? 0) + sumPaise(r.amountPaise),
    );
  }
  return totals;
}

// --- PENDING_TRUST park watchdog ---
// A park is released only when its sponsor is verified or pays an invoice, so
// one that does neither withholds earnings forever. Report parks older than
// 24h per sponsor (graded on the oldest row's createdAt, which is conservative
// for a row re-parked from HELD). Detect-only: age must never release a park.
export const PENDING_TRUST_PARK_STALE_MS = 24 * 60 * 60 * 1000;

/** One PENDING_TRUST row, normalised across the two earnings tables. */
export type PendingTrustParkRow = {
  earningId: string;
  /** The org that owes the invoice (the park's key), not the host org. */
  sponsorOrganizationId: string;
  amountPaise: number;
  createdAt: Date;
};

export type PendingTrustParkGroup = {
  organizationId: string;
  earningCount: number;
  parkedPaise: number;
  oldestCreatedAt: Date;
  sampleEarningIds: string[];
};

/** Group parked rows by sponsor, largest withheld amount first. */
export function groupPendingTrustParks(
  rows: PendingTrustParkRow[],
): PendingTrustParkGroup[] {
  const byOrg = new Map<string, PendingTrustParkGroup>();
  for (const row of rows) {
    let g = byOrg.get(row.sponsorOrganizationId);
    if (!g) {
      g = {
        organizationId: row.sponsorOrganizationId,
        earningCount: 0,
        parkedPaise: 0,
        oldestCreatedAt: row.createdAt,
        sampleEarningIds: [],
      };
      byOrg.set(row.sponsorOrganizationId, g);
    }
    g.earningCount += 1;
    g.parkedPaise += row.amountPaise;
    if (row.createdAt < g.oldestCreatedAt) g.oldestCreatedAt = row.createdAt;
    if (g.sampleEarningIds.length < 10) g.sampleEarningIds.push(row.earningId);
  }
  return [...byOrg.values()].sort((a, b) => b.parkedPaise - a.parkedPaise);
}

async function stepPendingTrustParks(ctx: StepCtx): Promise<void> {
  const cutoff = new Date(ctx.now.getTime() - PENDING_TRUST_PARK_STALE_MS);
  const [consultantParks, orgParks] = await Promise.all([
    prisma.consultantEarnings.findMany({
      where: {
        status: "PENDING_TRUST",
        createdAt: { lte: cutoff },
        ...(ctx.opts.organizationId
          ? { payment: { organizationId: ctx.opts.organizationId } }
          : {}),
      },
      select: {
        id: true,
        consultantSharePaise: true,
        createdAt: true,
        payment: { select: { organizationId: true } },
      },
    }),
    prisma.organizationEarnings.findMany({
      where: {
        status: "PENDING_TRUST",
        createdAt: { lte: cutoff },
        ...(ctx.opts.organizationId
          ? { organizationId: ctx.opts.organizationId }
          : {}),
      },
      select: {
        id: true,
        organizationId: true,
        orgSharePaise: true,
        createdAt: true,
      },
    }),
  ]);

  const rows: PendingTrustParkRow[] = [];
  for (const ce of consultantParks) {
    // No sponsor org means the gate never parked it.
    if (!ce.payment.organizationId) continue;
    rows.push({
      earningId: ce.id,
      sponsorOrganizationId: ce.payment.organizationId,
      amountPaise: sumPaise(ce.consultantSharePaise),
      createdAt: ce.createdAt,
    });
  }
  for (const oe of orgParks) {
    rows.push({
      earningId: oe.id,
      sponsorOrganizationId: oe.organizationId,
      amountPaise: sumPaise(oe.orgSharePaise),
      createdAt: oe.createdAt,
    });
  }

  for (const g of groupPendingTrustParks(rows)) {
    ctx.findings.push({
      kind: "PENDING_TRUST_PARK_STALE",
      organizationId: g.organizationId,
      expectedPaise: g.parkedPaise,
      actualPaise: 0,
      deltaPaise: g.parkedPaise,
      details: {
        unit: "paise",
        scope: "pending-trust-park",
        earningCount: g.earningCount,
        oldestCreatedAt: g.oldestCreatedAt.toISOString(),
        ageHours: Math.round(
          (ctx.now.getTime() - g.oldestCreatedAt.getTime()) / 3_600_000,
        ),
        sampleEarningIds: g.sampleEarningIds,
        note: "PENDING_TRUST earnings parked past 24h. Never auto-released on age. Unblock by verifying the sponsoring org (status=ACTIVE) or having it pay one invoice; otherwise it needs an operator decision.",
      },
    });
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

// --- referral-credit liability == Σ remaining of VESTED credits that posted a vest journal ---
async function stepReferralCreditLiability(ctx: StepCtx): Promise<void> {
  // One snapshot for both reads, so a vest committing between them is not drift.
  const { sums, vested } = await prisma.$transaction(
    async (tx) => ({
      sums: await tx.ledgerEntry.groupBy({
        by: ["direction"],
        where: {
          accountId: ledgerAccountId({ kind: "REFERRAL_CREDIT_LIABILITY" }),
        },
        _sum: { amountPaise: true },
      }),
      vested: await tx.referralCredit.aggregate({
        where: { state: "VESTED", vestedAt: { not: null } },
        _sum: { remainingAmount: true },
      }),
    }),
    { isolationLevel: "RepeatableRead" },
  );
  let ledgerOwed = 0;
  for (const row of sums) {
    const amt = sumPaise(row._sum.amountPaise);
    ledgerOwed += row.direction === "CREDIT" ? amt : -amt;
  }
  const expected = sumPaise(vested._sum.remainingAmount);
  if (expected !== ledgerOwed) {
    ctx.findings.push({
      kind: "REFERRAL_CREDIT_LIABILITY_DRIFT",
      expectedPaise: expected,
      actualPaise: ledgerOwed,
      deltaPaise: ledgerOwed - expected,
    });
  }
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
  await stepPendingTrustParks(ctx);
  if (!opts.organizationId) {
    await stepReferralCreditLiability(ctx);
    await stepUnappliedReceipts(ctx);
  }
  ctx.findings.push(...(await orgInvoiceGstFindings(opts.organizationId)));
  ctx.findings.push(
    ...(await staleClawbackFindings(ctx.now, opts.organizationId)),
  );

  return { ctx, durationMs: Date.now() - startedAt };
}

async function runReconcileLedgersUnlocked(
  opts: ReconcileScope,
): Promise<ReconcileReport> {
  const row = await prisma.ledgerReconciliationReport.create({
    data: {
      scope: opts.scope,
      ok: false,
      durationMs: 0,
      summary: {
        ...EMPTY_COUNTS,
        status: "RUNNING" as const,
      } as unknown as Prisma.InputJsonValue,
      findings: [],
      triggeredById: opts.triggeredById ?? null,
    },
    select: { id: true },
  });
  const { ctx, durationMs } = await executeSteps(opts);
  const ok = ctx.findings.length === 0;
  const summary = {
    ...ctx.counts,
    discrepanciesCount: ctx.findings.length,
    status: "COMPLETED" as const,
    calls: 1,
  };

  const report = await prisma.ledgerReconciliationReport.update({
    where: { id: row.id },
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

export async function runReconcileLedgers(
  opts: ReconcileScope,
): Promise<ReconcileReport> {
  return withCronLock(
    "reconcile-ledgers",
    { failMode: "open", ttlMs: LONG_JOB_TTL_MS },
    () => runReconcileLedgersUnlocked(opts),
  );
}

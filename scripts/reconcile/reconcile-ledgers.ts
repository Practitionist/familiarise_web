/**
 * Read-only ledger auditor.
 *
 * Walks the three ledgers and derived balances to flag drift:
 *
 *   1. FundingLedgerEntry   ← top-ups / refund credits / adjustments
 *   2. WalletEntry          ← the authoritative wallet journal
 *                             (its sum is the wallet invariant)
 *   3. SettlementLedgerEntry ← invoice issued / paid / payout events
 *   4. OrganizationInvoice  ← ISSUED / PAID / REFUNDED status machine
 *   5. ProgramAssignment    ← per-(member, cycle) engagementsUsed counter
 *
 * Invariants we check:
 *
 *   A. For every BillingAccount:
 *      sum(walletEntry.deltaPaise) === billingAccount.walletBalance
 *      (the "wallet balance drift" check)
 *
 *   B. For every BillingAccount:
 *      sum(walletEntry.deltaPaise WHERE reason in (TOPUP, REFUND, ...))
 *        === sum(fundingLedgerEntry.deltaPaise)
 *      (FundingLedger should mirror the wallet journal's funding rows;
 *      if a top-up webhook forgot to emit FundingLedgerEntry we catch it)
 *
 *   C. For every Organization:
 *      sum(settlementLedgerEntry.amountPaise WHERE kind=INVOICE_ISSUED)
 *        === sum(organizationInvoice.totalPaise WHERE status != VOIDED)
 *      (settlement ledger should carry an INVOICE_ISSUED entry for
 *      every non-voided invoice)
 *
 *   D. For every PAID OrganizationInvoice:
 *      a matching INVOICE_PAID SettlementLedgerEntry exists
 *      (detects invoice-paid webhook that flipped status but failed to
 *      log the settlement row)
 *
 *   E. For every ACTIVE ProgramAssignment (periodEnd >= now):
 *      sum(usageLedgerEntry.engagementsConsumed) === programAssignment.engagementsUsed
 *      (the denormalized counter must match the immutable consumption
 *      ledger; drift means a partial-rollback bug or a manual SQL edit
 *      slipped past the atomic recordBookingUtilization() write)
 *
 *   F. For every BillingSubscription:
 *      billingSubscription.activeSeatCount ===
 *        count(active LICENSED_SEAT ProgramAssignment for that contract
 *              where periodEnd >= now)
 *      (the per-seat invoice line item depends on this counter; before
 *      issue #699 ENT-1 it had no production writer, so drift is the
 *      historical default. Run the backfill SQL migration first, then
 *      this invariant will hold.)
 *
 *   H. For every Payment:
 *      sum(PaymentLeg.amountPaise) === Payment.amount
 *      (LICENSE legs carry amountPaise=0, so the sum still works for
 *      org-license-covered bookings. The hot checkout path log-warns
 *      on mismatch; this invariant is the retroactive detector.)
 *
 *   G. For every OrganizationPayout:
 *      sum(OrganizationEarnings.orgSharePaise - .refundedAmountPaise)
 *        for batched earnings === OrganizationPayout.netPayoutPaise
 *      (drift here means the batch claim updated earnings but didn't
 *      match the payout totals — investigate the
 *      createOrgPayoutBatch tx history)
 *
 * This is READ-ONLY. It never writes to any of the audited tables. It
 * only writes its findings to `LedgerReconciliationReport`.
 *
 * Usage:
 *   import { runReconcileLedgers } from "scripts/reconcile/reconcile-ledgers";
 *   const report = await runReconcileLedgers({ scope: "full" });
 *
 *   // Or scoped to one org:
 *   await runReconcileLedgers({ scope: `org:${orgId}`, organizationId: orgId });
 */

import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { checkPaymentLegsSumToAmount } from "@/lib/payments/payment-legs";

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
    | "FUNDING_LEDGER_MISSING"
    | "SETTLEMENT_MISSING_INVOICE_ISSUED"
    | "SETTLEMENT_MISSING_INVOICE_PAID"
    | "PROGRAM_ASSIGNMENT_ENGAGEMENTS_DRIFT"
    | "ACTIVE_SEAT_COUNT_DRIFT"
    | "PAYMENT_LEG_SUM_MISMATCH"
    | "ORG_PAYOUT_TOTAL_MISMATCH";
  organizationId?: string;
  billingAccountId?: string;
  billingSubscriptionId?: string;
  invoiceId?: string;
  paymentId?: string;
  payoutId?: string;
  programAssignmentId?: string;
  // For engagements-drift + seat-count findings the values are integer
  // counts, not paise. The shared field name keeps the report row compact
  // at the cost of a small abuse of the term — units are documented in
  // each finding's `details.unit`.
  expectedPaise: number;
  actualPaise: number;
  deltaPaise: number;
  details?: Record<string, unknown>;
};

export type ReconcileReport = {
  id: string;
  runAt: Date;
  scope: string;
  ok: boolean;
  durationMs: number;
  summary: {
    orgsChecked: number;
    accountsChecked: number;
    assignmentsChecked: number;
    subscriptionsChecked: number;
    paymentsChecked: number;
    payoutsChecked: number;
    discrepanciesCount: number;
  };
  findings: Finding[];
};

export async function runReconcileLedgers(
  opts: ReconcileScope,
): Promise<ReconcileReport> {
  const startedAt = Date.now();
  const findings: Finding[] = [];

  const orgFilter = opts.organizationId
    ? { id: opts.organizationId }
    : undefined;

  // --- (A) + (B): per BillingAccount wallet balance + funding mirror ---
  const accounts = await prisma.billingAccount.findMany({
    where: orgFilter
      ? { ownerOrgId: orgFilter.id }
      : undefined,
    select: { id: true, walletBalance: true, ownerOrgId: true },
  });

  for (const acct of accounts) {
    const walletSum = await prisma.walletEntry.aggregate({
      where: { billingAccountId: acct.id },
      _sum: { deltaPaise: true },
    });
    const walletTotal = walletSum._sum?.deltaPaise ?? 0;
    const bal = acct.walletBalance ?? 0;

    if (walletTotal !== bal) {
      findings.push({
        kind: "WALLET_BALANCE_DRIFT",
        billingAccountId: acct.id,
        organizationId: acct.ownerOrgId ?? undefined,
        expectedPaise: walletTotal,
        actualPaise: bal,
        deltaPaise: bal - walletTotal,
      });
    }

    // Funding ledger should mirror funding-class wallet entries
    // (TOPUP, REFUND, ADJUSTMENT). Booking debits live on WalletEntry
    // only; they are NOT funding events, so we exclude them here.
    const fundingWalletSum = await prisma.walletEntry.aggregate({
      where: {
        billingAccountId: acct.id,
        reason: { in: ["TOPUP", "REFUND", "ADJUSTMENT"] },
      },
      _sum: { deltaPaise: true },
    });
    const fundingLedgerSum = await prisma.fundingLedgerEntry.aggregate({
      where: { billingAccountId: acct.id },
      _sum: { deltaPaise: true },
    });

    const fundingWalletTotal = fundingWalletSum._sum?.deltaPaise ?? 0;
    const fundingLedgerTotal = fundingLedgerSum._sum?.deltaPaise ?? 0;

    if (fundingWalletTotal !== fundingLedgerTotal) {
      findings.push({
        kind: "FUNDING_LEDGER_MISSING",
        billingAccountId: acct.id,
        organizationId: acct.ownerOrgId ?? undefined,
        expectedPaise: fundingWalletTotal,
        actualPaise: fundingLedgerTotal,
        deltaPaise: fundingLedgerTotal - fundingWalletTotal,
        details: {
          note:
            "FundingLedgerEntry sum differs from funding-class WalletEntry sum. A top-up or refund webhook likely failed to emit the funding ledger row.",
        },
      });
    }
  }

  // --- (C) + (D): per-Organization settlement coverage ---
  const organizations = await prisma.organization.findMany({
    where: orgFilter,
    select: { id: true },
  });

  for (const org of organizations) {
    // (C) INVOICE_ISSUED coverage
    const invoicesNonVoided = await prisma.organizationInvoice.aggregate({
      where: {
        organizationId: org.id,
        status: { not: "VOID" },
      },
      _sum: { totalPaise: true },
    });
    const settlementIssued = await prisma.settlementLedgerEntry.aggregate({
      where: {
        organizationId: org.id,
        kind: "INVOICE_ISSUED",
      },
      _sum: { amountPaise: true },
    });
    const invoicesTotal = invoicesNonVoided._sum?.totalPaise ?? 0;
    const settlementIssuedTotal = settlementIssued._sum?.amountPaise ?? 0;
    if (invoicesTotal !== settlementIssuedTotal) {
      findings.push({
        kind: "SETTLEMENT_MISSING_INVOICE_ISSUED",
        organizationId: org.id,
        expectedPaise: invoicesTotal,
        actualPaise: settlementIssuedTotal,
        deltaPaise: settlementIssuedTotal - invoicesTotal,
        details: {
          note:
            "Sum of non-voided OrganizationInvoice.totalPaise does not match sum of SettlementLedgerEntry(kind=INVOICE_ISSUED). An auto-generated invoice may have skipped its settlement row.",
        },
      });
    }

    // (D) INVOICE_PAID coverage per paid invoice
    const paidInvoices = await prisma.organizationInvoice.findMany({
      where: { organizationId: org.id, status: "PAID" },
      select: { id: true, totalPaise: true },
    });
    for (const inv of paidInvoices) {
      const hasPaidSettlement = await prisma.settlementLedgerEntry.findFirst({
        where: { invoiceId: inv.id, kind: "INVOICE_PAID" },
        select: { id: true },
      });
      if (!hasPaidSettlement) {
        findings.push({
          kind: "SETTLEMENT_MISSING_INVOICE_PAID",
          organizationId: org.id,
          invoiceId: inv.id,
          expectedPaise: inv.totalPaise,
          actualPaise: 0,
          deltaPaise: -inv.totalPaise,
        });
      }
    }
  }

  // --- (E): per ProgramAssignment engagement-counter drift ---
  // engagementsUsed is denormalized for query performance — checkout
  // reads it on every booking to evaluate the per-cycle cap. It's
  // incremented atomically inside recordBookingUtilization() in the
  // same transaction that writes the UsageLedgerEntry, so under correct
  // operation the two never drift. Drift here implies a
  // partial-rollback bug, a manual SQL fix, or a missing-ledger-write
  // code path. Scoped to ACTIVE assignments (periodEnd >= now()) — we
  // don't re-check historical cycles every run. Reversed
  // UsageLedgerEntry rows post a negative engagementsConsumed, so the
  // SUM here naturally accounts for refunds without a separate filter.
  const now = new Date();
  const liveAssignments = await prisma.programAssignment.findMany({
    where: {
      periodEnd: { gte: now },
      ...(opts.organizationId
        ? { program: { contract: { organizationId: opts.organizationId } } }
        : {}),
    },
    select: {
      id: true,
      engagementsUsed: true,
      program: { select: { contract: { select: { organizationId: true } } } },
    },
  });

  for (const a of liveAssignments) {
    const ledgerSum = await prisma.usageLedgerEntry.aggregate({
      where: { programAssignmentId: a.id },
      _sum: { engagementsConsumed: true },
    });
    const ledgerTotal = ledgerSum._sum?.engagementsConsumed ?? 0;
    if (ledgerTotal !== a.engagementsUsed) {
      findings.push({
        kind: "PROGRAM_ASSIGNMENT_ENGAGEMENTS_DRIFT",
        programAssignmentId: a.id,
        organizationId: a.program.contract.organizationId,
        // The shared expected/actual fields hold engagement counts
        // here, not paise. The auditor UI keys on `kind` to render
        // units correctly.
        expectedPaise: ledgerTotal,
        actualPaise: a.engagementsUsed,
        deltaPaise: a.engagementsUsed - ledgerTotal,
        details: {
          unit: "engagements",
          note: "ProgramAssignment.engagementsUsed disagrees with sum(UsageLedgerEntry.engagementsConsumed). Investigate via the assignment's UsageLedgerEntry trail and the recordBookingUtilization() write path.",
        },
      });
    }
  }

  // --- (H): per Payment leg-sum invariant ---
  // The hot checkout path log-warns on mismatch (we don't break booking
  // for a leg-accounting bug); this is the retroactive detector. We only
  // walk Payments associated with org bookings — B2C card-only payments
  // have a single CARD leg whose sum is trivially equal and the read
  // would balloon for no audit value. Org legs (WALLET, INVOICE_ACCRUAL,
  // LICENSE) are the ones that benefit from a sweep.
  const paymentsWithOrgLegs = await prisma.payment.findMany({
    where: {
      organizationId: opts.organizationId ?? { not: null },
    },
    select: { id: true, amount: true, organizationId: true },
  });
  for (const p of paymentsWithOrgLegs) {
    const legs = await prisma.paymentLeg.findMany({
      where: { paymentId: p.id },
      select: { source: true, amountPaise: true },
    });
    const mismatch = checkPaymentLegsSumToAmount({
      paymentAmountPaise: p.amount,
      legs,
    });
    if (mismatch) {
      findings.push({
        kind: "PAYMENT_LEG_SUM_MISMATCH",
        organizationId: p.organizationId ?? undefined,
        paymentId: p.id,
        expectedPaise: p.amount,
        actualPaise: mismatch.legSumPaise,
        deltaPaise: mismatch.deltaPaise,
        details: {
          legs: mismatch.legs,
          note: "Sum of PaymentLeg.amountPaise diverges from Payment.amount. Investigate which leg writer (checkout / wallet / referral) emitted the wrong amount.",
        },
      });
    }
  }

  // --- (G): per OrganizationPayout total vs claimed earnings ---
  // The createOrgPayoutBatch tx claims READY earnings, computes totals,
  // and writes them to the payout in one go. If anything ever diverges
  // (manual SQL, partial migration, future code changes) this catches
  // the drift before the next bank transfer is initiated.
  const payouts = await prisma.organizationPayout.findMany({
    where: opts.organizationId
      ? { organizationId: opts.organizationId }
      : undefined,
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
      findings.push({
        kind: "ORG_PAYOUT_TOTAL_MISMATCH",
        organizationId: p.organizationId,
        payoutId: p.id,
        expectedPaise: expected,
        actualPaise: p.netPayoutPaise,
        deltaPaise: p.netPayoutPaise - expected,
        details: {
          earningsCount: p.earnings.length,
          note: "OrganizationPayout.netPayoutPaise diverges from sum(orgShare - refunds) of attached earnings.",
        },
      });
    }
  }

  // --- (F): per BillingSubscription activeSeatCount drift ---
  // activeSeatCount is denormalized from ProgramAssignment count for
  // billing-cron read efficiency (the invoice cron must compute
  // line-items in O(1) lookups across thousands of subs). It is written
  // by adjustActiveSeatCount() in lib/api/organizations/seat-count.ts on
  // assignment create/delete. Drift means a missed write or manual SQL.
  // We only count assignments whose program is currently ACTIVE — paused
  // / archived programs don't contribute to billable seats.
  const subscriptions = await prisma.billingSubscription.findMany({
    where: opts.organizationId
      ? { contract: { organizationId: opts.organizationId } }
      : undefined,
    select: {
      id: true,
      activeSeatCount: true,
      contractId: true,
      contract: {
        select: { organizationId: true },
      },
    },
  });

  for (const sub of subscriptions) {
    const expected = await prisma.programAssignment.count({
      where: {
        periodEnd: { gte: now },
        program: {
          contractId: sub.contractId,
          type: "LICENSED_SEAT",
          status: "ACTIVE",
        },
      },
    });
    if (expected !== sub.activeSeatCount) {
      findings.push({
        kind: "ACTIVE_SEAT_COUNT_DRIFT",
        organizationId: sub.contract.organizationId,
        billingSubscriptionId: sub.id,
        expectedPaise: expected,
        actualPaise: sub.activeSeatCount,
        deltaPaise: sub.activeSeatCount - expected,
        details: {
          unit: "seats",
          note: "BillingSubscription.activeSeatCount disagrees with the count of in-period LICENSED_SEAT ProgramAssignments. Re-run the backfill migration if this reflects historical drift.",
        },
      });
    }
  }

  const durationMs = Date.now() - startedAt;
  const ok = findings.length === 0;

  const summary = {
    orgsChecked: organizations.length,
    accountsChecked: accounts.length,
    assignmentsChecked: liveAssignments.length,
    subscriptionsChecked: subscriptions.length,
    paymentsChecked: paymentsWithOrgLegs.length,
    payoutsChecked: payouts.length,
    discrepanciesCount: findings.length,
  };

  const report = await prisma.ledgerReconciliationReport.create({
    data: {
      scope: opts.scope,
      ok,
      durationMs,
      summary: summary as unknown as Prisma.InputJsonValue,
      findings: findings as unknown as Prisma.InputJsonValue,
      triggeredById: opts.triggeredById ?? null,
    },
  });

  return {
    id: report.id,
    runAt: report.runAt,
    scope: report.scope,
    ok: report.ok,
    durationMs: report.durationMs,
    summary,
    findings,
  };
}

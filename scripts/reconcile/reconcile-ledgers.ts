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
    | "PROGRAM_ASSIGNMENT_ENGAGEMENTS_DRIFT";
  organizationId?: string;
  billingAccountId?: string;
  invoiceId?: string;
  programAssignmentId?: string;
  // For engagements-drift findings the values are engagement counts,
  // not paise. The shared field name keeps the report row compact at
  // the cost of a small abuse of the term — it's documented on the
  // PROGRAM_ASSIGNMENT_ENGAGEMENTS_DRIFT branch only.
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

  const durationMs = Date.now() - startedAt;
  const ok = findings.length === 0;

  const summary = {
    orgsChecked: organizations.length,
    accountsChecked: accounts.length,
    assignmentsChecked: liveAssignments.length,
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

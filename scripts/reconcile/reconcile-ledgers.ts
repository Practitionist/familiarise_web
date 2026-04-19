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
    | "SETTLEMENT_MISSING_INVOICE_PAID";
  organizationId?: string;
  billingAccountId?: string;
  invoiceId?: string;
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

  const durationMs = Date.now() - startedAt;
  const ok = findings.length === 0;

  const summary = {
    orgsChecked: organizations.length,
    accountsChecked: accounts.length,
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

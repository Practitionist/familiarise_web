/**
 * Read-only ledger auditor.
 *
 * Walks the double-entry journal + derived balances to flag drift. #772
 * collapsed the three single-entry logs (FundingLedgerEntry, WalletEntry,
 * SettlementLedgerEntry) into the LedgerTransaction/LedgerEntry journal, so
 * the legacy mirror checks (B/C/D) are gone — their events now live as
 * balanced journal transactions, guarded by the per-txn imbalance check.
 *
 *   1. LedgerTransaction/Entry  ← the authoritative double-entry journal
 *   2. BillingAccount.walletBalance ← derived cache of the WALLET account
 *   3. OrganizationInvoice  ← ISSUED / PAID / REFUNDED status machine
 *   4. ProgramAssignment    ← per-(member, cycle) engagementsUsed counter
 *
 * Invariants we check:
 *
 *   A. For every BillingAccount:
 *      −balance(WALLET LedgerAccount) === billingAccount.walletBalance
 *      (the "wallet balance drift" check; WALLET is a credit-normal
 *      liability so amount owed = Σ CREDIT − Σ DEBIT)
 *
 *   LEDGER_TXN_IMBALANCE. For every LedgerTransaction:
 *      Σ DEBIT === Σ CREDIT (the double-entry invariant)
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
 *   Note: as of A3 (per-collaborator HOST-org settlement) one Payment
 *   can carry N OrganizationEarnings rows — one per (paymentId, orgId)
 *   pair, capped by the @@unique constraint. The primary expert's org
 *   gets a row whose grossAmountPaise === Payment.originalAmount; each
 *   collaborator-at-different-HOST-org gets a row whose
 *   grossAmountPaise === their slice of the consultant pool. Invariants
 *   here are payout-scoped (G aggregates per OrganizationPayout, not
 *   per Payment) so they remain correct without modification. Don't
 *   assume one OrganizationEarnings per Payment in any future invariant.
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
import { ledgerBalancePaise } from "@/lib/payments/ledger/post";

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
    | "PAYMENT_LEG_SUM_MISMATCH"
    | "ORG_PAYOUT_TOTAL_MISMATCH"
    | "LEDGER_TXN_IMBALANCE";
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
    earningsPaymentsWithoutBookingTxn: number;
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

  // --- (A): per BillingAccount wallet balance vs derived WALLET account ---
  const accounts = await prisma.billingAccount.findMany({
    where: orgFilter ? { ownerOrgId: orgFilter.id } : undefined,
    select: { id: true, walletBalance: true, ownerOrgId: true, currency: true },
  });

  for (const acct of accounts) {
    // #772 B3 — WalletEntry removed; the wallet balance derives from the org's
    // WALLET LedgerAccount. WALLET is a credit-normal liability, so the amount
    // owed = Σ CREDIT − Σ DEBIT = −(signed Dr−Cr balance). The cached
    // walletBalance must equal it. (Funding-mirror check B dropped with
    // FundingLedgerEntry; the journal is the accounting source of truth, guarded
    // by the LEDGER_TXN_IMBALANCE check below.)
    const walletTotal = acct.ownerOrgId
      ? -(await ledgerBalancePaise(prisma, {
          kind: "WALLET",
          organizationId: acct.ownerOrgId,
          currency: acct.currency,
        }))
      : 0;
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
  }

  // --- (C) + (D): per-Organization settlement coverage ---
  const organizations = await prisma.organization.findMany({
    where: orgFilter,
    select: { id: true },
  });

  // #772 B2 — SettlementLedgerEntry removed; settlement coverage checks (C/D)
  // dropped. INVOICE_ISSUED / INVOICE_PAID / PAYOUT events now live in the
  // double-entry journal (LedgerTransaction.kind) + OrgAuditLog. `organizations`
  // is retained for the summary count.
  void organizations.length;

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

  // --- (H) #771 D1/D5 — double-entry invariant: every LedgerTransaction must
  // balance (Σ DEBIT === Σ CREDIT). postLedgerTxn enforces this at write time;
  // this nightly check catches manual SQL edits or a future writer bug. ZERO
  // findings here across a reseed is the GATE that lets the three single-entry
  // logs (Wallet/Funding/Settlement) above be safely removed (#771 cutover).
  // Global integrity check — runs on full scope only.
  if (!opts.organizationId) {
    const ledgerSums = await prisma.ledgerEntry.groupBy({
      by: ["transactionId", "direction"],
      _sum: { amountPaise: true },
    });
    const perTxn = new Map<string, { debit: bigint; credit: bigint }>();
    for (const row of ledgerSums) {
      const cur = perTxn.get(row.transactionId) ?? {
        debit: BigInt(0),
        credit: BigInt(0),
      };
      const amt = row._sum.amountPaise ?? BigInt(0);
      if (row.direction === "DEBIT") cur.debit += amt;
      else cur.credit += amt;
      perTxn.set(row.transactionId, cur);
    }
    perTxn.forEach((sums, transactionId) => {
      if (sums.debit !== sums.credit) {
        findings.push({
          kind: "LEDGER_TXN_IMBALANCE",
          expectedPaise: Number(sums.debit),
          actualPaise: Number(sums.credit),
          deltaPaise: Number(sums.debit - sums.credit),
          details: {
            transactionId,
            unit: "paise",
            note: "Double-entry LedgerTransaction does not balance (Σdebit ≠ Σcredit).",
          },
        });
      }
    });
  }

  // --- (E2) booking-ledger drift (covered payments only) — #772 B4 ----------
  // Earnings amount columns are a reconciled cache; the journal is the source
  // of truth. For every payment that HAS a booking journal txn, the journal's
  // earnings-relevant credits (PLATFORM_FEE + CONSULTANT_PAYABLE + ORG_PAYABLE)
  // must equal the cached Earnings amounts. Payments WITHOUT a booking txn
  // (multi-collaborator runtime path + seed rows) are a tracked coverage gap
  // (#773), counted below for visibility but not flagged here.
  const bookingTxns = await prisma.ledgerTransaction.findMany({
    where: { kind: "BOOKING", paymentId: { not: null } },
    select: { id: true, paymentId: true },
  });
  const coveredPaymentIds = new Set(
    bookingTxns.map((t) => t.paymentId).filter((p): p is string => !!p),
  );
  for (const txn of bookingTxns) {
    if (!txn.paymentId) continue;
    const creditRows = await prisma.ledgerEntry.findMany({
      where: {
        transactionId: txn.id,
        direction: "CREDIT",
        account: {
          kind: { in: ["PLATFORM_FEE", "CONSULTANT_PAYABLE", "ORG_PAYABLE"] },
        },
      },
      select: { amountPaise: true },
    });
    const journalEarnings = creditRows.reduce(
      (s, r) => s + Number(r.amountPaise),
      0,
    );
    const [ce, oe] = await Promise.all([
      prisma.consultantEarnings.aggregate({
        where: { paymentId: txn.paymentId },
        _sum: { platformFeePaise: true, consultantSharePaise: true },
      }),
      prisma.organizationEarnings.aggregate({
        where: { paymentId: txn.paymentId },
        _sum: { orgSharePaise: true },
      }),
    ]);
    const cacheEarnings =
      (ce._sum.platformFeePaise ?? 0) +
      (ce._sum.consultantSharePaise ?? 0) +
      (oe._sum.orgSharePaise ?? 0);
    if (journalEarnings !== cacheEarnings) {
      findings.push({
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

  // Coverage metric (informational, NOT a finding): earnings-bearing payments
  // with no booking journal txn yet — the multi-collaborator + seed gap (#773).
  const earningsPaymentRows = await prisma.consultantEarnings.findMany({
    select: { paymentId: true },
    distinct: ["paymentId"],
  });
  const earningsPaymentsWithoutBookingTxn = earningsPaymentRows.filter(
    (e) => e.paymentId && !coveredPaymentIds.has(e.paymentId),
  ).length;

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
    earningsPaymentsWithoutBookingTxn,
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

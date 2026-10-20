/**
 * What the nightly ledger reconcile does when the auditor finds drift: a system
 * event, a deduplicated Sentry page, and a spend freeze on each wallet whose
 * cache disagrees with the journal. Called by the `reconcile-ledgers` twin,
 * which freezes from the audit's wallet step, before the rest of the audit runs.
 */

import * as Sentry from "@sentry/nextjs";

import { recordSystemEvent } from "@/lib/enterprise/system-events";
import { reportStandingFinding } from "@/lib/observability/standing-finding";
import { freezeWalletSpend } from "@/lib/payments/wallet-freeze";

import type { Finding, ReconcileReport } from "./reconcile-ledgers";

/** A finding set that repeats nightly pages Sentry once a week, or sooner when a new finding appears. */
const LEDGER_FINDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function respondToLedgerDrift(
  report: ReconcileReport,
): Promise<void> {
  const count = report.summary.discrepanciesCount;
  await recordSystemEvent({
    category: "RECONCILE",
    severity: "ERROR",
    message: `Ledger reconciliation found ${count} discrepancies`,
    correlationId: report.id,
    context: {
      reportId: report.id,
      findingsCount: count,
      kinds: Array.from(new Set(report.findings.map((f) => f.kind))),
    },
  });

  const message = `Ledger reconciliation: ${count} discrepancies found`;
  await reportStandingFinding(
    {
      key: "reconcile-ledgers:discrepancies",
      ids: report.findings.map(
        (f) =>
          `${f.kind}:${
            f.billingAccountId ??
            f.paymentId ??
            f.payoutId ??
            f.invoiceId ??
            f.programAssignmentId ??
            f.billingSubscriptionId ??
            f.organizationId ??
            `platform:${f.expectedPaise}:${f.actualPaise}`
          }`,
      ),
      message,
      windowMs: LEDGER_FINDING_WINDOW_MS,
    },
    () =>
      Sentry.captureException(new Error(message), {
        tags: { subsystem: "jobs", job: "reconcile-ledgers" },
        contexts: {
          ledger: { reportId: report.id, discrepancyCount: count },
        },
      }),
  );
}

/** Freezes spend on each WALLET_BALANCE_DRIFT account and pages fatal once; other kinds page but do not gate spend. */
export async function freezeDriftingWallets(
  reportId: string,
  findings: Finding[],
): Promise<void> {
  const walletDrift = findings.filter(
    (f) => f.kind === "WALLET_BALANCE_DRIFT" && f.billingAccountId,
  );
  const frozenWallets: Array<{
    billingAccountId: string | null;
    organizationId: string | null;
    deltaPaise: number;
    newlyFrozen: boolean;
  }> = [];
  const failures: unknown[] = [];
  try {
    for (const f of walletDrift) {
      if (!f.billingAccountId) continue;
      try {
        const froze = await freezeWalletSpend({
          billingAccountId: f.billingAccountId,
          organizationId: f.organizationId ?? null,
          reason: `ledger reconcile ${reportId}: wallet cache ${f.actualPaise}p ≠ journal ${f.expectedPaise}p (Δ${f.deltaPaise}p)`,
        });
        frozenWallets.push({
          billingAccountId: f.billingAccountId,
          organizationId: f.organizationId ?? null,
          deltaPaise: Number(f.deltaPaise),
          newlyFrozen: froze,
        });
      } catch (err) {
        // One failed freeze must not leave the remaining drifting wallets spendable.
        failures.push(err);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Wallet freeze failed for ${failures.length} of ${walletDrift.length} drifting account(s): ${failures
          .map((e) => (e instanceof Error ? e.message : String(e)))
          .join("; ")}`,
      );
    }
  } finally {
    // One fatal per run, keyed on detected drift so a freeze that throws still pages.
    if (walletDrift.length > 0) {
      Sentry.captureException(
        new Error(
          `WALLET_BALANCE_DRIFT — ${walletDrift.length} billing account(s) drifting, spend frozen for ${frozenWallets.length}`,
        ),
        {
          level: "fatal",
          tags: { subsystem: "jobs", job: "reconcile-ledgers" },
          fingerprint: ["reconcile-ledgers-wallet-drift"],
          contexts: {
            wallet: {
              reportId,
              driftingWallets: walletDrift.length,
              frozenWallets: frozenWallets.length,
              sample: frozenWallets.slice(0, 10),
            },
          },
        },
      );
    }
  }
}

/**
 * What the nightly ledger reconcile does when the auditor finds drift: a system
 * event, a deduplicated Sentry page, and a spend freeze on each wallet whose
 * cache disagrees with the journal. Called by the `reconcile-ledgers` twin,
 * which freezes from the audit's wallet step, before the rest of the audit runs.
 */

import * as Sentry from "@sentry/nextjs";

import { recordSystemEvent } from "@/lib/enterprise/system-events";
import { reportStandingFinding } from "@/lib/observability/standing-finding";
import {
  freezeDriftedWallets,
  type FrozenWallet,
} from "@/lib/payments/wallet-freeze";

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
): Promise<FrozenWallet[]> {
  const walletDrift = findings.filter(
    (f) => f.kind === "WALLET_BALANCE_DRIFT" && f.billingAccountId,
  );
  const frozenWallets: FrozenWallet[] = [];
  try {
    await freezeDriftedWallets({ id: reportId, findings }, frozenWallets);
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
  return frozenWallets;
}

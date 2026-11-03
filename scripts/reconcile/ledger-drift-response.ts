/**
 * What scheduled ledger reconciliation does when the auditor finds drift: a system
 * event, a deduplicated Sentry page, and a spend freeze on each wallet whose
 * cache disagrees with the journal. Called by the `reconcile-ledgers` twin,
 * which freezes from the audit's wallet step, before the rest of the audit runs.
 */

import * as Sentry from "@sentry/nextjs";

import { recordSystemEvent } from "@/lib/enterprise/system-events";
import { reportStandingFinding } from "@/lib/observability/standing-finding";
import type { FrozenWallet } from "@/lib/payments/wallet-freeze";

import type { Finding, ReconcileReport } from "./reconcile-ledgers";

/** Repeated findings remind Sentry weekly; new discrepancy identities page sooner. */
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

/** Pages when a billing account newly drifts; an ongoing drift is re-paged only weekly, whatever the report. */
export async function reportWalletDriftFreeze(
  reportId: string,
  findings: Finding[],
  frozenWallets: FrozenWallet[],
): Promise<void> {
  const walletDrift = findings.filter(
    (f) => f.kind === "WALLET_BALANCE_DRIFT" && f.billingAccountId,
  );
  if (walletDrift.length > 0) {
    const message = `WALLET_BALANCE_DRIFT — ${walletDrift.length} billing account(s) drifting, spend frozen for ${frozenWallets.length}`;
    await reportStandingFinding(
      {
        key: "reconcile-ledgers:wallet-drift",
        ids: walletDrift.flatMap((f) =>
          f.billingAccountId ? [f.billingAccountId] : [],
        ),
        message,
        windowMs: LEDGER_FINDING_WINDOW_MS,
      },
      () =>
        Sentry.captureException(new Error(message), {
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
        }),
    );
  }
}

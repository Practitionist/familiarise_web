/**
 * Release PENDING_TRUST earnings — invoice-fraud guard release valve (#687).
 *
 * Promotes both OrganizationEarnings AND ConsultantEarnings rows (#687 E-02)
 * from PENDING_TRUST → PENDING when the sponsoring org has either:
 *   1. transitioned to status=ACTIVE (admin verification), or
 *   2. paid at least one OrganizationInvoice.
 *
 * Once promoted, the existing release-from-hold path takes over (cron
 * flips PENDING → READY when holdUntil lapses, and the regular payout
 * pipeline runs). This cron only handles the trust gate, not the hold.
 *
 * Schedule: hourly. Cheap walk — there's only ever a handful of rows in
 * PENDING_TRUST since the gate disengages quickly for legit orgs.
 *
 * Designed to be safe to run alongside the existing
 * `release-earnings.ts` cron — they touch disjoint rows (PENDING_TRUST
 * here, PENDING with `holdUntil <= now` there).
 *
 * ## The park has no timeout — so this job also WATCHES it
 *
 * The release above is condition-driven only. A sponsor that is never verified
 * and never pays an invoice parks its consultant's earnings forever: no row
 * ages out, no timer fires, and the amount is excluded from
 * `EarningsSummary.totalEarnings`, so the revenue is invisible as well as owed.
 * That is the gap this half of the job closes — it grades every parked row by
 * age and escalates, WITHOUT ever releasing on age. Releasing because a row got
 * old would hand the money straight back to the invoice-fraud case the park
 * exists to prevent, so the severity ladder below is detect-only and the two
 * concerns share no code path.
 *
 * Grades (thresholds + the pure grader live in the reconciler, which owns the
 * PENDING_TRUST_PARK_STALE finding kind, so the alert and the report can never
 * disagree on what "stale" means):
 *   ≥24h → SystemEvent WARN + a non-paging Sentry message
 *   ≥72h → SystemEvent ERROR + `reportSentryError`, which pages
 *
 * The hourly cadence is the throttle: a row crosses each rung once, so there is
 * no dedupe state to keep and nothing to migrate.
 */

// Why: tsx does not auto-load .env when this script runs outside the
// Next.js runtime (e.g. `npx tsx jobs/cleanup/release-pending-trust-earnings.ts`).
// Without dotenv/config, DATABASE_URL is undefined and PrismaClient throws
// on the first query. GitHub Actions workflows load env via repo secrets
// and would still work, but local + emergency manual runs fail — see
// docs/enterprise/50-operations/03-runbooks.md "Running cron jobs locally".
import "dotenv/config";
import prisma from "@/lib/prisma";
import { EarningStatus } from "@prisma/client";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";
import { recordSystemEventSafe } from "@/lib/enterprise/system-events";
import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import { sumPaise } from "@/lib/payments/utils/money";
import {
  groupPendingTrustParks,
  PENDING_TRUST_PARK_PAGE_MS,
  PENDING_TRUST_PARK_WARN_MS,
  type PendingTrustParkRow,
} from "../../scripts/reconcile/reconcile-ledgers";

export interface ReleasePendingTrustResult {
  scanned: number;
  released: number;
  errors: string[];
  /** Rows still parked after this run's release pass (unlocked sponsors). */
  stillParked: number;
  /** Sponsors parked past PENDING_TRUST_PARK_WARN_MS — the operator's to fix. */
  stalledOrgs: number;
  /** Sponsors past PENDING_TRUST_PARK_PAGE_MS; these are the ones that paged. */
  pagedOrgs: number;
  /** Paise still withheld across every stalled sponsor. */
  stalledPaise: number;
}

/**
 * Every currently-parked row, normalised across the two earnings tables so the
 * grader can group it by the sponsor that can unblock it.
 *
 * The park keys on `payment.organizationId` (the org that OWES the invoice),
 * not the expert's host org, so the consultant side joins through the payment —
 * the same join the release pass below uses.
 */
async function readParkedRows(): Promise<PendingTrustParkRow[]> {
  const [consultantParks, orgParks] = await Promise.all([
    prisma.consultantEarnings.findMany({
      where: { status: EarningStatus.PENDING_TRUST },
      select: {
        id: true,
        consultantSharePaise: true,
        createdAt: true,
        payment: { select: { organizationId: true } },
      },
    }),
    prisma.organizationEarnings.findMany({
      where: { status: EarningStatus.PENDING_TRUST },
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
    if (!ce.payment.organizationId) continue;
    rows.push({
      earningId: ce.id,
      table: "ConsultantEarnings",
      sponsorOrganizationId: ce.payment.organizationId,
      amountPaise: sumPaise(ce.consultantSharePaise),
      createdAt: ce.createdAt,
    });
  }
  for (const oe of orgParks) {
    rows.push({
      earningId: oe.id,
      table: "OrganizationEarnings",
      sponsorOrganizationId: oe.organizationId,
      amountPaise: sumPaise(oe.orgSharePaise),
      createdAt: oe.createdAt,
    });
  }
  return rows;
}

/**
 * Grade the parked rows by age and escalate.
 *
 * Writes ONE SystemEvent per stalled sponsor (the operator's durable row, on
 * the same `PAYOUT` category the payout service uses) and one Sentry report
 * per group. NONE of this can release anything: it runs before the release
 * pass, reads a snapshot, and only ever calls observability helpers.
 */
async function auditStalledParks(
  result: ReleasePendingTrustResult,
  now: Date,
): Promise<void> {
  const rows = await readParkedRows();
  result.stillParked = rows.length;

  const stalled = groupPendingTrustParks(rows, now).filter(
    (g) => g.severity !== "NONE",
  );
  if (stalled.length === 0) return;

  result.stalledOrgs = stalled.length;
  for (const g of stalled) {
    if (g.severity === "ERROR") result.pagedOrgs += 1;
    result.stalledPaise += g.parkedPaise;
  }

  // Batched, not per-group fire-and-forget: the deploy env is documented at
  // PG_POOL_MAX=1 (lib/prisma.ts), so one unbounded burst of inserts queues
  // behind each other and loses rows to the connect timeout — and `*Safe`
  // resolves even when the insert fails, which would report success having
  // recorded nothing. Same treatment as sweep-abandoned-overage-charges.
  const WRITE_BATCH = 10;
  const pending: Promise<void>[] = [];
  for (const g of stalled) {
    const ageHours = Math.round(
      (now.getTime() - g.oldestCreatedAt.getTime()) / (60 * 60 * 1000),
    );
    const message =
      `PENDING_TRUST park stale: sponsor ${g.organizationId} is withholding ` +
      `${g.earningCount} earning(s) worth ${g.parkedPaise}p for ${ageHours}h ` +
      `(warn at ${PENDING_TRUST_PARK_WARN_MS / 3_600_000}h, page at ` +
      `${PENDING_TRUST_PARK_PAGE_MS / 3_600_000}h). Not auto-released by age — ` +
      `the anti-invoice-fraud guard still holds. Unblock by verifying the org ` +
      `(status=ACTIVE) or having it pay one invoice.`;
    const context = {
      sponsorOrganizationId: g.organizationId,
      earningCount: g.earningCount,
      parkedPaise: g.parkedPaise,
      oldestCreatedAt: g.oldestCreatedAt.toISOString(),
      ageHours,
      severity: g.severity,
      sampleEarningIds: g.sampleEarningIds,
      warnAfterMs: PENDING_TRUST_PARK_WARN_MS,
      pageAfterMs: PENDING_TRUST_PARK_PAGE_MS,
    };
    // Awaited per batch so the rows are durable before `$disconnect()`.
    pending.push(
      recordSystemEventSafe({
        organizationId: g.organizationId,
        category: "PAYOUT",
        severity: g.severity === "ERROR" ? "ERROR" : "WARN",
        message,
        context,
      }),
    );
    if (g.severity === "ERROR") {
      // expected:false leaves the level unset so Sentry's own error level
      // applies and an alert rule fires — this is the page.
      reportSentryError(new Error(message), {
        subsystem: "jobs",
        op: "pending-trust-park-stale",
        expected: false,
        extra: context,
      });
    } else {
      // A 24h park is a real but not-yet-escalated condition: keep it
      // findable at warning level without opening an incident for it.
      reportSentryMessage("PENDING_TRUST_PARK_STALE", {
        subsystem: "jobs",
        op: "pending-trust-park-stale",
        expected: true,
        level: "warning",
        extra: context,
      });
    }
    if (pending.length >= WRITE_BATCH) {
      await Promise.all(pending);
      pending.length = 0;
    }
  }
  if (pending.length > 0) await Promise.all(pending);

  console.log(
    `[release-pending-trust-earnings] STALLED PENDING_TRUST parks: ` +
      `${stalled.length} sponsor(s) withholding ${result.stalledPaise}p ` +
      `(${result.pagedOrgs} paging) — see SystemEvent category=PAYOUT`,
  );
  Sentry.logger.warn("job:release-pending-trust-earnings stalled parks", {
    stalledOrgs: stalled.length,
    pagedOrgs: result.pagedOrgs,
    stalledPaise: result.stalledPaise,
  });
}

// #476 — fail-closed: the CAS updateMany below is the correctness layer; this
// lock is entry-level mutual exclusion for schedule overlap / manual re-runs.
export async function runReleasePendingTrustEarnings(): Promise<ReleasePendingTrustResult> {
  return withCronLock(
    "release-pending-trust-earnings",
    { failMode: "closed" },
    () => runReleasePendingTrustEarningsUnlocked(),
  );
}

async function runReleasePendingTrustEarningsUnlocked(): Promise<ReleasePendingTrustResult> {
  Sentry.logger.info("job:release-pending-trust-earnings started");
  const result: ReleasePendingTrustResult = {
    scanned: 0,
    released: 0,
    errors: [],
    stillParked: 0,
    stalledOrgs: 0,
    pagedOrgs: 0,
    stalledPaise: 0,
  };

  // Step 0: WATCH the park before anything can return early. `unlockedOrgIds`
  // is empty precisely when no sponsor has verified or paid — which is the
  // stalled case, so any check placed after that short-circuit would never
  // fire in the one situation it exists for.
  const now = new Date();
  await auditStalledParks(result, now);

  // Step 1: orgs that are now ACTIVE (admin verified them).
  const verifiedOrgIds = (
    await prisma.organization.findMany({
      where: { status: "ACTIVE" },
      select: { id: true },
    })
  ).map((o) => o.id);

  // Step 2: orgs that have at least one PAID invoice (paid first
  // invoice — that's enough trust to release prior accruals).
  const paidInvoiceOrgs = await prisma.organizationInvoice.findMany({
    where: { status: "PAID" },
    select: { organizationId: true },
    distinct: ["organizationId"],
  });
  const paidOrgIds = paidInvoiceOrgs.map((p) => p.organizationId);

  const unlockedOrgIds = Array.from(
    new Set([...verifiedOrgIds, ...paidOrgIds]),
  );

  if (unlockedOrgIds.length === 0) {
    // Nothing unlocked, so nothing was released: the snapshot count stands.
    return result;
  }

  // Org rows carry organizationId directly. Consultant rows (#687 E-02) do
  // NOT — the sponsor lives on the Payment, so join through it. Both are
  // parked/released as one booking, so an unlocked sponsor promotes both.
  const [orgCandidates, consultantCandidates] = await Promise.all([
    prisma.organizationEarnings.findMany({
      where: {
        status: EarningStatus.PENDING_TRUST,
        organizationId: { in: unlockedOrgIds },
      },
      select: { id: true },
    }),
    prisma.consultantEarnings.findMany({
      where: {
        status: EarningStatus.PENDING_TRUST,
        payment: { organizationId: { in: unlockedOrgIds } },
      },
      select: { id: true },
    }),
  ]);
  result.scanned = orgCandidates.length + consultantCandidates.length;

  if (result.scanned === 0) {
    return result;
  }
  // CAS on status inside each updateMany so a concurrent refund/hold that
  // moved a row out of PENDING_TRUST between the scan and the write is not
  // clobbered back to PENDING.
  try {
    if (orgCandidates.length > 0) {
      const orgUpdate = await prisma.organizationEarnings.updateMany({
        where: {
          id: { in: orgCandidates.map((c) => c.id) },
          status: EarningStatus.PENDING_TRUST,
        },
        data: { status: EarningStatus.PENDING },
      });
      result.released += orgUpdate.count;
    }
    if (consultantCandidates.length > 0) {
      const consultantUpdate = await prisma.consultantEarnings.updateMany({
        where: {
          id: { in: consultantCandidates.map((c) => c.id) },
          status: EarningStatus.PENDING_TRUST,
        },
        data: { status: EarningStatus.PENDING },
      });
      result.released += consultantUpdate.count;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(message);
    Sentry.captureException(err, {
      tags: { subsystem: "jobs", job: "release-pending-trust-earnings" },
    });
  }

  // The watchdog read every parked row before the release pass; the rows this
  // run released were all in that set, so the remainder is what stayed parked.
  result.stillParked = Math.max(0, result.stillParked - result.released);

  console.log(
    `[release-pending-trust-earnings] scanned=${result.scanned} released=${result.released} still_parked=${result.stillParked} stalled_orgs=${result.stalledOrgs} paged=${result.pagedOrgs} errors=${result.errors.length}`,
  );
  Sentry.logger.info("job:release-pending-trust-earnings finished", {
    scanned: result.scanned,
    released: result.released,
    stillParked: result.stillParked,
    stalledOrgs: result.stalledOrgs,
    pagedOrgs: result.pagedOrgs,
    errors: result.errors.length,
  });
  return result;
}

// CLI entry — `npx tsx jobs/cleanup/release-pending-trust-earnings.ts`
if (require.main === module) {
  runJob("release-pending-trust-earnings", async () => {
    await abortIfMaintenance("release-pending-trust-earnings");
    try {
      const r = await runReleasePendingTrustEarnings();
      if (r.errors.length > 0) process.exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
  });
}

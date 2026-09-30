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
 * ## Each rung fires ONCE per sponsor, not once per run
 *
 * The cadence sets the INTERVAL, not the COUNT. A sponsor that is never
 * verified and never pays an invoice stays parked indefinitely, so its
 * `oldestCreatedAt` is past 72h on every run from the third day onward and the
 * hourly job would re-page 24 times a day, forever. That is precisely how an
 * alert gets muted — and a muted alert is worse than no alert, because the
 * next real incident is muted with it.
 *
 * So the escalation is deduped on the durable row it already writes: the
 * SystemEvent carries `context.parkAlertRung` ("WARN" | "ERROR"), and the next
 * run reads the (organizationId, rung) pair back before alerting. The pair is
 * read against `SystemEvent` itself rather than a new table, so this needs no
 * migration — see `readRaisedParkAlertsSafe` for why the read-then-write pair
 * is atomic here.
 *
 * The park-age detection and the dedupe are deliberately separate concerns:
 * the finding is re-graded and re-reported every run (`stalledOrgs`,
 * `stalledPaise` always describe the current money at risk), and only the
 * ALERT is suppressed. A sponsor that crosses 24h warns once and then crosses
 * 72h and pages once — the ladder still climbs.
 *
 * ## The watchdog can never block the release
 *
 * Detection runs before the `unlockedOrgIds.length === 0` short-circuit,
 * because that short-circuit IS the stalled case. That ordering means the
 * watchdog's own faults — a bad query, a null deref, a failing Sentry client —
 * would abort the run before the release step, and genuinely releasable money
 * would stop being released because the thing watching it broke. So the
 * watchdog is isolated: it throws into `result.errors` and the release runs
 * anyway. A detector that can veto the thing it observes is not a detector.
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
  type PendingTrustParkGroup,
  type PendingTrustParkRow,
} from "../../scripts/reconcile/reconcile-ledgers";

export interface ReleasePendingTrustResult {
  scanned: number;
  released: number;
  errors: string[];
  /** Rows still parked after this run's release pass (unlocked sponsors). */
  stillParked: number;
  /**
   * Sponsors parked past PENDING_TRUST_PARK_WARN_MS — the operator's to fix.
   * Counted on EVERY run, deduped or not: this is the money at risk, and the
   * stall does not stop being a stall because the pager has already been told.
   */
  stalledOrgs: number;
  /**
   * Sponsors that paged THIS run. Drops to 0 on every run after the first one
   * past the page threshold — that is the dedupe working, not a recovery.
   */
  pagedOrgs: number;
  /** Paise still withheld across every stalled sponsor. */
  stalledPaise: number;
  /**
   * Stalled sponsors whose rung fired on this run (i.e. had not been raised
   * for that sponsor before). `stalledOrgs - escalatedOrgs` were suppressed
   * as already-raised; see `dedupedOrgs`.
   */
  escalatedOrgs: number;
  /** Stalled sponsors suppressed because this rung already fired for them. */
  dedupedOrgs: number;
  /**
   * The watchdog threw. The release still ran to completion — this flag is how
   * a reader tells "nothing is parked" apart from "we could not look". While
   * true, `stillParked` / `stalledOrgs` / `stalledPaise` are 0 because they are
   * UNKNOWN, not because they are zero.
   */
  watchdogFailed: boolean;
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

/** Functional bucket the escalation marker lives in, same as the payout service. */
const PARK_ALERT_CATEGORY = "PAYOUT";

/**
 * `SystemEvent.context` key the rung is written under, and the path it is read
 * back by. One constant, two readers, so the write and the dedupe query cannot
 * drift — the same discipline as `SYSTEM_EVENT_WRITE_FAILURE_MARKER` in
 * `lib/observability/report.ts`.
 */
const PARK_ALERT_RUNG_KEY = "parkAlertRung";

/** The two rungs that alert. `NONE` is filtered out before it reaches here. */
type ParkAlertRung = "WARN" | "ERROR";

/**
 * Which rungs have ALREADY been raised for these sponsors, as `orgId:rung`
 * keys.
 *
 * ## Why `SystemEvent` and not a new table
 *
 * The marker is the alert row the job already writes — there is no second
 * write and no second table, so this needs no migration. `SystemEvent` has no
 * unique constraint to make the insert itself the dedupe, so this is an
 * explicit read-before-alert instead; the two failure modes of getting that
 * wrong are asymmetric, which is why it reads first and writes after.
 *
 * ## Why read-then-write is atomic here
 *
 * The whole body runs inside `withCronLock({ failMode: "closed" })`, so no two
 * runs of THIS job overlap and the read-then-write pair cannot interleave with
 * another instance. The reconciler is a separate process that owns the
 * PENDING_TRUST_PARK_STALE finding kind and does not write these rows, so it
 * cannot consume a rung either. A unique index on
 * `(organizationId, context->>'parkAlertRung') WHERE category = 'PAYOUT'`
 * would harden this against a future second writer, and is written up in the
 * change notes — it is not required for correctness today.
 *
 * ## Never rejects — the `*Safe` convention (cf. `recordSystemEventSafe`)
 *
 * A failed read returns an EMPTY set, so the run ALERTS rather than suppresses.
 * Detection fails open, because the two outcomes are not symmetric: silently
 * withholding the alert because the marker table was unreadable would hide a
 * real 72h+ invoice-withholding stall, which is the single thing this watchdog
 * exists to prevent. Re-alerting costs a duplicate page during a database blip
 * that is itself reported — recoverable, and bounded by the blip.
 */
async function readRaisedParkAlertsSafe(
  groups: PendingTrustParkGroup[],
): Promise<Set<string>> {
  const keys = new Set<string>();
  const orgIds = Array.from(new Set(groups.map((g) => g.organizationId)));
  if (orgIds.length === 0) return keys;
  try {
    // ONE query for the whole batch — (organizationId, rung) is a small closed
    // set, and a round trip per sponsor is the same burst the insert batching
    // below exists to avoid (PG_POOL_MAX=1, lib/prisma.ts). The OR'd JSON-path
    // predicates keep this selective: they match the terminal-marker idiom in
    // scripts/cleanup/retry-moderation-enforcement.ts.
    const markers = await prisma.systemEvent.findMany({
      where: {
        organizationId: { in: orgIds },
        category: PARK_ALERT_CATEGORY,
        OR: [
          { context: { path: [PARK_ALERT_RUNG_KEY], equals: "WARN" } },
          { context: { path: [PARK_ALERT_RUNG_KEY], equals: "ERROR" } },
        ],
      },
      select: { organizationId: true, context: true },
    });
    for (const m of markers) {
      if (!m.organizationId) continue;
      // Re-checked in JS rather than trusted from the filter: the where clause
      // narrows, this builds the key the escalation loop matches on.
      const rung = (m.context as Record<string, unknown> | null)?.[
        PARK_ALERT_RUNG_KEY
      ];
      if (rung === "WARN" || rung === "ERROR") {
        keys.add(`${m.organizationId}:${rung}`);
      }
    }
    return keys;
  } catch (err) {
    // `Sentry.logger`, not `reportSentryError`: this is a degradation of the
    // de-duplicator, not a fault in the money path, and paging about a
    // duplicate-page-avoidance read would be the tail wagging the dog. The
    // console line is the durable trace; the file already uses
    // `Sentry.logger.warn` for its run summary.
    console.error(
      `[release-pending-trust-earnings] park-alert dedupe read failed for ` +
        `${orgIds.length} sponsor(s); escalating anyway rather than risking a ` +
        `silenced stall:`,
      err,
    );
    Sentry.logger.warn("job:release-pending-trust-earnings dedupe read failed", {
      sponsorCount: orgIds.length,
      failingOpen: true,
    });
    return keys;
  }
}

/**
 * Grade the parked rows by age and escalate.
 *
 * Writes ONE SystemEvent per stalled sponsor (the operator's durable row, on
 * the same `PAYOUT` category the payout service uses) and one Sentry report
 * per group — but only for rungs that have not already fired for that sponsor;
 * see `readRaisedParkAlertsSafe`. NONE of this can release anything: it runs
 * before the release pass, reads a snapshot, and only ever calls observability
 * helpers.
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

  // Every stalled sponsor counts toward the totals, deduped or not: the money
  // stays withheld regardless of whether the pager has already been told, and
  // this is the number that says the run has something to fix.
  result.stalledOrgs = stalled.length;
  for (const g of stalled) {
    result.stalledPaise += g.parkedPaise;
  }

  const raisedRungs = await readRaisedParkAlertsSafe(stalled);

  // Batched, not per-group fire-and-forget: the deploy env is documented at
  // PG_POOL_MAX=1 (lib/prisma.ts), so one unbounded burst of inserts queues
  // behind each other and loses rows to the connect timeout — and `*Safe`
  // resolves even when the insert fails, which would report success having
  // recorded nothing. Same treatment as sweep-abandoned-overage-charges.
  const WRITE_BATCH = 10;
  const pending: Promise<void>[] = [];
  for (const g of stalled) {
    const rung: ParkAlertRung = g.severity === "ERROR" ? "ERROR" : "WARN";
    if (raisedRungs.has(`${g.organizationId}:${rung}`)) {
      // Already raised at this rung. Suppress the alert AND the marker row —
      // re-writing the marker would reset nothing, since it carries no
      // timestamp this job consults, but it would bury the original one in a
      // weekly PAYOUT event list.
      result.dedupedOrgs += 1;
      continue;
    }
    result.escalatedOrgs += 1;
    if (rung === "ERROR") result.pagedOrgs += 1;
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
      // The dedupe key. Written with the alert, read back by the next run.
      [PARK_ALERT_RUNG_KEY]: rung,
    };
    // Alert BEFORE marking. If the process dies between the two, the failure is
    // a repeated page (recoverable, and it stops as soon as the marker lands)
    // rather than a page that never fires at all — the marker is what makes the
    // alert go quiet, so it must be the thing we are willing to lose.
    if (rung === "ERROR") {
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
    // Awaited per batch so the rows are durable before `$disconnect()`.
    pending.push(
      recordSystemEventSafe({
        organizationId: g.organizationId,
        category: PARK_ALERT_CATEGORY,
        severity: rung,
        message,
        context,
      }),
    );
    if (pending.length >= WRITE_BATCH) {
      await Promise.all(pending);
      pending.length = 0;
    }
  }
  if (pending.length > 0) await Promise.all(pending);

  console.log(
    `[release-pending-trust-earnings] STALLED PENDING_TRUST parks: ` +
      `${stalled.length} sponsor(s) withholding ${result.stalledPaise}p ` +
      `(${result.pagedOrgs} paging, ${result.escalatedOrgs} rung(s) raised, ` +
      `${result.dedupedOrgs} already raised) — see SystemEvent ` +
      `category=${PARK_ALERT_CATEGORY}`,
  );
  Sentry.logger.warn("job:release-pending-trust-earnings stalled parks", {
    stalledOrgs: stalled.length,
    pagedOrgs: result.pagedOrgs,
    escalatedOrgs: result.escalatedOrgs,
    dedupedOrgs: result.dedupedOrgs,
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
    escalatedOrgs: 0,
    dedupedOrgs: 0,
    watchdogFailed: false,
  };

  // Step 0: WATCH the park before anything can return early. `unlockedOrgIds`
  // is empty precisely when no sponsor has verified or paid — which is the
  // stalled case, so any check placed after that short-circuit would never
  // fire in the one situation it exists for.
  //
  // That ordering also means the watchdog can throw before the release pass, so
  // it is isolated here: its faults are REPORTED and the release runs anyway.
  // A detector that can veto the thing it observes is not a detector — a bad
  // query or a failing Sentry client must not stop money that is legitimately
  // releasable from being released. Same idiom as the CAS catch below: push to
  // `errors`, capture to Sentry, carry on.
  const now = new Date();
  try {
    await auditStalledParks(result, now);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.watchdogFailed = true;
    result.errors.push(`watchdog: ${message}`);
    Sentry.captureException(err, {
      tags: { subsystem: "jobs", job: "release-pending-trust-earnings" },
    });
    console.error(
      "[release-pending-trust-earnings] stalled-park watchdog failed; " +
        "continuing to the release pass:",
      err,
    );
  }

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
  // Skipped when the watchdog threw: `stillParked` is then 0 because it is
  // UNKNOWN, and subtracting the release count off a number we never measured
  // would dress that unknown up as a count.
  if (!result.watchdogFailed) {
    result.stillParked = Math.max(0, result.stillParked - result.released);
  }

  console.log(
    `[release-pending-trust-earnings] scanned=${result.scanned} released=${result.released} still_parked=${result.stillParked} stalled_orgs=${result.stalledOrgs} paged=${result.pagedOrgs} raised=${result.escalatedOrgs} deduped=${result.dedupedOrgs} watchdog_failed=${result.watchdogFailed} errors=${result.errors.length}`,
  );
  Sentry.logger.info("job:release-pending-trust-earnings finished", {
    scanned: result.scanned,
    released: result.released,
    stillParked: result.stillParked,
    stalledOrgs: result.stalledOrgs,
    pagedOrgs: result.pagedOrgs,
    escalatedOrgs: result.escalatedOrgs,
    dedupedOrgs: result.dedupedOrgs,
    watchdogFailed: result.watchdogFailed,
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

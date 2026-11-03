/**
 * #779 §A — CHARGE_MEMBER overage TIMEOUT cron. A member-pays overage sits
 * PENDING until the side-payment SUCCEEDS; if the member never settles it,
 * it must time out → FAILED so it stops counting toward the per-cycle
 * circuit-breaker ceiling, and the member gets told the obligation lapsed.
 *
 * Distinct from sweep-abandoned-overage-charges (#785): that sweep FAILs
 * never-*started* side-charges at 7d off the synthetic `overage:` intent to
 * free the ceiling silently. This cron is the hard 14-day wall — it gates on
 * the dedicated `chargeTimedOutAt` stamp + telemetry fields and NOTIFIES the
 * member. The two are idempotent against each other: a row the sweep already
 * moved to FAILED no longer matches `chargeStatus = PENDING` here.
 *
 * Schedule: the ticker's daily window from 23:30 UTC; the 14-day cutoff is
 * measured from the window start so every slice of a window sees one cohort.
 *
 * Idempotent: claims on `chargeTimedOutAt:null` (+ `chargeStatus PENDING`),
 * so a re-run or second replica matches zero rows.
 */

import prisma from "@/lib/prisma";
import { sendOrgOperationalEmail } from "@/lib/email/senders/money";
import { notifyMemberOverageTimedOut } from "@/lib/novu/org-workflows";
import { restoreOverageBaseCarve } from "@/lib/payments/billing/overage-base-carve";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import { createRunFailureReporter } from "@/lib/observability/run-failures";
import { getAppUrl } from "@/lib/url";
import { withCronLock } from "@/lib/cron/with-cron-lock";

// #779 — 14-day window before a never-settled member overage times out.
const TIMEOUT_DAYS = 14;
const TIMEOUT_REASON = "Payment not completed within 14 days";

interface TimeoutStats {
  scanned: number;
  timedOut: number;
  /** Rows whose claim threw; each rolled back and stays PENDING for the next run. */
  errored: number;
}

export async function runTimeoutMemberOverages(opts: {
  limit?: number;
  windowStart?: Date;
}): Promise<TimeoutStats> {
  return withCronLock("timeout-member-overages", { failMode: "closed" }, () =>
    timeoutMemberOverages(opts),
  );
}

async function timeoutMemberOverages(opts: {
  limit?: number;
  windowStart?: Date;
}): Promise<TimeoutStats> {
  const stats: TimeoutStats = { scanned: 0, timedOut: 0, errored: 0 };
  const failures = createRunFailureReporter("jobs");
  const receivables: string[] = [];
  const errors: Array<{ overageEventId: string; error: string }> = [];
  const now = new Date();
  const cutoff = new Date(
    (opts.windowStart ?? now).getTime() - TIMEOUT_DAYS * 86_400_000,
  );

  const stale = await prisma.overageEvent.findMany({
    where: {
      overageBehavior: "CHARGE_MEMBER",
      chargeStatus: "PENDING",
      createdAt: { lt: cutoff },
      chargeTimedOutAt: null,
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit,
    select: {
      id: true,
      marginalPaise: true,
      currency: true,
      programAssignment: {
        select: {
          membership: { select: { userId: true } },
          program: {
            select: {
              name: true,
              contract: {
                select: {
                  organization: { select: { id: true, name: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  stats.scanned = stale.length;

  for (const ev of stale) {
    let claimed: Awaited<ReturnType<typeof restoreOverageBaseCarve>> | null;
    try {
      claimed = await prisma.$transaction(
        async (tx) => {
          // Claim only if still PENDING + un-stamped (PENDING→FAILED is the
          // only legal target; a row the member paid (→CHARGED) or the
          // abandoned-sweep moved (→FAILED) between read and here won't match).
          const claim = await tx.overageEvent.updateMany({
            where: {
              id: ev.id,
              chargeStatus: "PENDING",
              chargeTimedOutAt: null,
            },
            data: {
              chargeStatus: "FAILED",
              chargeTimedOutAt: now,
              chargeFailureReason: TIMEOUT_REASON,
            },
          });
          if (claim.count === 0) return null;
          // #812 §P0 — the member never pays basePaise on a timed-out charge;
          // return it to the org's parent accrual in the same tx.
          return restoreOverageBaseCarve(tx, { overageEventId: ev.id });
        },
        { isolationLevel: "Serializable", maxWait: 10_000, timeout: 15_000 },
      );
    } catch (err) {
      stats.errored += 1;
      errors.push({
        overageEventId: ev.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (claimed === null) continue;
    stats.timedOut += 1;
    if (claimed === "receivable") receivables.push(ev.id);
    if (claimed === "invoiced") {
      // Awaited, not `void`. This is the alert that says a human has to fix
      // the org's billing by hand, and the job can exit immediately after the
      // loop — fire-and-forget here is a coin flip on whether the row lands at
      // all. The line below already awaits, so this costs nothing.
      const invoicedErr = new Error("OVERAGE_BASE_RESTORE_AFTER_INVOICE");
      failures.add("timeout-member-overages.invoiced-skip", invoicedErr, {
        overageEventId: ev.id,
      });
      await recordSystemErrorSafe({
        organizationId: null,
        category: "OVERAGE",
        summary: `Timed-out overage ${ev.id}: basePaise not restorable — parent already invoiced; settle it to the org with POST /api/admin/organizations/<orgId>/overages/${ev.id}/settle-to-org`,
        err: invoicedErr,
        context: { overageEventId: ev.id },
        skipSentry: true,
      });
    }

    const payUrl = `${getAppUrl()}/dashboard/overage?charge=${ev.id}`;
    // Fire-and-forget — committed state, no DB writes in the notify path.
    await Promise.all([
      notifyMemberOverageTimedOut(ev.programAssignment.membership.userId, {
        organizationId: ev.programAssignment.program.contract.organization.id,
        orgName: ev.programAssignment.program.contract.organization.name,
        programName: ev.programAssignment.program.name,
        amountPaise: ev.marginalPaise,
        currency: ev.currency,
        payUrl,
      }),
      sendOrgOperationalEmail({
        recipientUserIds: [ev.programAssignment.membership.userId],
        organizationId:
          ev.programAssignment.program.contract.organization.id ?? "",
        orgName: ev.programAssignment.program.contract.organization.name,
        kind: "MEMBER_OVERAGE_TIMED_OUT",
        programName: ev.programAssignment.program.name,
        amountPaise: ev.marginalPaise,
        currency: ev.currency,
        actionUrl: payUrl,
      }),
    ]).catch((err) =>
      console.error("[timeout-member-overages] notify failed:", err),
    );
  }

  if (receivables.length > 0 || errors.length > 0) {
    await recordSystemErrorSafe({
      organizationId: null,
      category: "OVERAGE",
      summary: `timeout-member-overages: ${receivables.length} timed-out overage(s) booked as ORG_RECEIVABLE (wallet short of the base), ${errors.length} row(s) failed and stay PENDING`,
      err: new Error("OVERAGE_TIMEOUT_RUN_NEEDS_FINANCE"),
      context: { receivableOverageEventIds: receivables, errors },
    });
  }

  failures.flush();
  return stats;
}

/**
 * #779 §A — Cron: advance ProgramAssignment cycles.
 *
 * Schedule: the ticker's daily window from 03:00 UTC, on a slot ahead of
 * auto-renew-contracts and expire-contracts so an assignment whose contract is
 * still ACTIVE rolls into its next period before any contract-side state moves
 * under it.
 *
 * Per assignment whose period has ended (status ACTIVE, rolledAt null,
 * periodEnd<=now) on a live program:
 *   - contract ACTIVE + autoRenew + successor fits the term → ROLL:
 *       claim ACTIVE→ROLLED (+rolledAt) then mint the successor ACTIVE row for
 *       the next cycle (counters reset) and link old.rolledToAssignmentId. The
 *       @unique on rolledToAssignmentId is the double-mint backstop (P2002).
 *   - else → CLOSE: claim ACTIVE→CLOSED, no successor.
 *
 * Concurrency: candidates findMany (bounded) → per-row Serializable
 * $transaction → claim via conditional updateMany (count===0 ⇒ another replica
 * won, skip) → side effects in same tx → OrgAuditLog row. Mirrors
 * jobs/contracts/expire-contracts.ts.
 *
 * Deferred (#777): CREDIT_POOL `minimumCreditsPerPeriod` shortfall billing
 * ("unconsumed commitment rolls into the next invoice") is NOT handled here —
 * it needs a per-program cycle-close concept (assignments roll individually),
 * so it ships with its own design when a customer commits to minimums.
 */

import prisma from "@/lib/prisma";
import type { PrismaLike } from "@/lib/prisma";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { formatAuditDate } from "@/lib/labels/org-labels";
import { releaseSeatsForClosedAssignments } from "@/lib/api/organizations/seat-count";
import {
  decideCycleTransition,
  nextPeriodEnd,
  resolveProgramCycle,
} from "@/lib/enterprise/cycle-engine";
import { Prisma } from "@prisma/client";
import { BILLABLE_ORG_STATUSES, isBillable } from "@/lib/enterprise/org-status";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { createRunFailureReporter } from "@/lib/observability/run-failures";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { EMAIL_BUDGET_MS } from "@/lib/email/config";
import type { StagedRecipientEmail as StagedEmail } from "@/lib/email/send-to-recipients";
import { attemptStaged } from "@/lib/email/send-to-recipients";
import {
  ONBOARDING_EMAIL_TYPES,
  stageOrgContractAndSeatEmail,
} from "@/lib/email/senders/onboarding";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu";
import { notifyOrgSeatRevoked } from "@/lib/novu/org-workflows";
import { getAppUrl } from "@/lib/url";

// Bounded scan; `limit` then caps the claims a run attempts.
const BATCH_SIZE = 500;

interface AdvanceStats {
  scanned: number;
  rolled: number;
  closed: number;
  skipped: number;
  failed: number;
  remaining: number;
}

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

function formatSeatRevokedReason(reason: string): string {
  switch (reason) {
    case "CONTRACT_INACTIVE":
      return "Your organization's contract is no longer active";
    case "AUTORENEW_OFF":
      return "Auto-renewal is disabled for this contract";
    case "CLAMPED":
      return "Your organization's contract term has ended";
    default:
      return reason;
  }
}

async function closeProgramAssignmentInTx(
  tx: TxClient,
  args: {
    assignmentId: string;
    programId: string;
    orgId: string;
    orgName: string;
    programName: string;
    targetUserId?: string;
    reason: string;
    now: Date;
  },
): Promise<
  | { outcome: "skipped" }
  | {
      outcome: "closed";
      stagedBells: StagedTrigger[];
      stagedEmails: StagedEmail[];
    }
> {
  const {
    assignmentId,
    programId,
    orgId,
    orgName,
    programName,
    targetUserId,
    reason,
    now,
  } = args;
  // Claim ACTIVE→CLOSED. Gate doubles as the distributed lock.
  const claim = await tx.programAssignment.updateMany({
    where: { id: assignmentId, status: "ACTIVE", rolledAt: null },
    data: { status: "CLOSED", rolledAt: now },
  });
  if (claim.count === 0) return { outcome: "skipped" };
  // #1744 row 4 — a successorless close gives the billed seat back.
  await releaseSeatsForClosedAssignments(tx, programId, 1);

  await tx.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId: null,
      targetMembershipId: null,
      category: "PROGRAM",
      action: AUDIT_ACTIONS.PROGRAM.PROGRAM_ASSIGNMENT_ROLLED,
      description: `Program assignment for "${programName}" closed with no successor`,
      details: {
        assignmentId,
        programId,
        closed: true,
        reason,
      },
    },
  });

  if (!targetUserId) {
    return {
      outcome: "closed",
      stagedBells: [],
      stagedEmails: [],
    };
  }

  const dashboardUrl = `${getAppUrl()}/dashboard/organization/${orgId}`;
  const humanReason = formatSeatRevokedReason(reason);
  const stagedBells: StagedTrigger[] =
    (await notifyOrgSeatRevoked(
      targetUserId,
      {
        organizationId: orgId,
        orgName,
        programName,
        reason: humanReason,
        dashboardUrl,
      },
      { tx },
    )) ?? [];
  const stagedEmails: StagedEmail[] = await stageOrgContractAndSeatEmail(tx, {
    recipientUserIds: [targetUserId],
    entityId: assignmentId,
    kind: "SEAT_REVOKED",
    orgName,
    programName,
    reason: humanReason,
    dashboardUrl,
  });
  return {
    outcome: "closed",
    stagedBells,
    stagedEmails,
  };
}

async function dispatchClosedSeatNotifications(
  assignmentId: string,
  stagedBells: StagedTrigger[],
  stagedEmails: StagedEmail[],
): Promise<void> {
  try {
    for (const bell of stagedBells) await attemptTrigger(bell);
    if (stagedEmails.length > 0) {
      await attemptStaged(
        stagedEmails,
        ONBOARDING_EMAIL_TYPES.ORG_CONTRACT_AND_SEAT,
        EMAIL_BUDGET_MS.JOB,
      );
    }
  } catch (notifyErr) {
    console.error(
      `[advance-program-cycles] notify failed for assignment ${assignmentId}:`,
      notifyErr,
    );
  }
}

/** Ended periods on live programs of billable orgs; shared by the run and the ticker's idle probe. */
function dueAssignmentWhere(asOf: Date): Prisma.ProgramAssignmentWhereInput {
  return {
    status: "ACTIVE",
    rolledAt: null,
    periodEnd: { lte: asOf },
    program: {
      status: "ACTIVE",
      archivedAt: null,
      contract: {
        organization: { status: { in: BILLABLE_ORG_STATUSES } },
      },
    },
  };
}

/** Ticker idle probe: the cohort at `now` covers any window start at or before it. */
export async function hasAdvanceProgramCyclesWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const row = await db.programAssignment.findFirst({
    where: dueAssignmentWhere(now),
    select: { id: true },
  });
  return row !== null;
}

/** With `windowStart`, only periods ended by it are due, so every slice of a window sees one cohort. */
export async function runAdvanceProgramCycles(opts: {
  limit?: number;
  windowStart?: Date;
}): Promise<AdvanceStats> {
  return withCronLock(
    "advance-program-cycles",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => advanceProgramCycles(opts),
  );
}

async function advanceProgramCycles(opts: {
  limit?: number;
  windowStart?: Date;
}): Promise<AdvanceStats> {
  const failures = createRunFailureReporter("jobs");
  const stats: AdvanceStats = {
    scanned: 0,
    rolled: 0,
    closed: 0,
    skipped: 0,
    failed: 0,
    remaining: 0,
  };
  const now = new Date();
  const asOf = opts.windowStart ?? now;

  // Candidates: ended periods on live programs, not yet processed.
  const due = await prisma.programAssignment.findMany({
    where: dueAssignmentWhere(asOf),
    orderBy: { periodEnd: "asc" },
    take: BATCH_SIZE,
    select: {
      id: true,
      programId: true,
      membershipId: true,
      periodEnd: true,
      membership: { select: { userId: true } },
      program: {
        select: {
          id: true,
          name: true,
          contract: {
            select: {
              id: true,
              organizationId: true,
              status: true,
              autoRenew: true,
              effectiveTo: true,
              organization: { select: { name: true } },
            },
          },
          licensedSeatConfig: { select: { cycle: true } },
          creditPoolConfig: { select: { cycle: true } },
        },
      },
    },
  });
  stats.scanned = due.length;

  let attempted = 0;
  let visited = 0;
  for (const a of due) {
    if (opts.limit !== undefined && attempted >= opts.limit) break;
    visited += 1;
    const cycle = resolveProgramCycle(a.program);
    if (cycle === null) {
      // Malformed program (no money-config) — nothing to compute a period from.
      stats.skipped += 1;
      continue;
    }

    const successorStart = a.periodEnd;
    // S1854 — the scan-time decision was made dead by the wave-3 in-tx
    // recompute; successor bounds are all the loop needs up front.
    const successorEnd = nextPeriodEnd(successorStart, cycle);

    const orgId = a.program.contract.organizationId;

    attempted += 1;
    try {
      // #1132 follow-up — transient P2034 aborts now retry; persistent ones
      // still fall through to the outer catch's skip-with-Sentry semantics.
      const result = await withSerializableRetry(() =>
        prisma.$transaction(
          async (tx) => {
            // Wave-3 TOCTOU closure (#1230) — the ROLL/CLOSE decision above was
            // computed from the candidate SCAN, which auto-renew/supersede can
            // re-point or retire before this tx claims. Serializable cannot
            // protect rows the tx never reads, so re-read the contract facts
            // here and recompute before claiming.
            // CR #1234 r5 — PROGRAM eligibility gets the same treatment: an
            // operator archiving/disabling the program after the scan must not
            // have a successor minted under it (the archive guard in the API
            // route only sees new allocations).
            const liveProgram = await tx.program.findUnique({
              where: { id: a.programId },
              select: { status: true, archivedAt: true },
            });
            if (
              liveProgram?.status !== "ACTIVE" ||
              liveProgram?.archivedAt !== null
            ) {
              // Also covers the not-found case via undefined !== "ACTIVE".
              return { outcome: "skipped" as const };
            }
            const liveContract = await tx.contract.findUnique({
              where: { id: a.program.contract.id },
              select: {
                status: true,
                autoRenew: true,
                effectiveTo: true,
                // CR #1324 — org billability was a scan-time filter only, so an
                // org suspended or deactivated between the scan and this claim
                // still got a fresh successor cycle minted under it. Re-read it
                // here with the contract facts and let a non-billable org take
                // the same CLOSE path a deleted contract takes.
                organization: { select: { status: true } },
              },
            });
            // Contract deleted, or its org no longer billable, between scan and
            // claim ⇒ CLOSE via the engine's own decision table (jobs may not
            // carry free-form audit-action literals).
            const effectiveDecision =
              liveContract && isBillable(liveContract.organization.status)
                ? decideCycleTransition({
                    successorPeriodStart: successorStart,
                    successorPeriodEnd: successorEnd,
                    contractStatus: liveContract.status,
                    contractAutoRenew: liveContract.autoRenew,
                    contractEffectiveTo: liveContract.effectiveTo,
                  })
                : decideCycleTransition({
                    successorPeriodStart: successorStart,
                    successorPeriodEnd: successorEnd,
                    contractStatus: "EXPIRED",
                    contractAutoRenew: false,
                    contractEffectiveTo: null,
                  });
            if (effectiveDecision.action === "CLOSE") {
              return closeProgramAssignmentInTx(tx, {
                assignmentId: a.id,
                programId: a.programId,
                orgId,
                orgName:
                  a.program.contract.organization?.name ?? "Organization",
                programName: a.program.name ?? "Program",
                targetUserId: a.membership?.userId,
                reason: effectiveDecision.reason,
                now,
              });
            }

            // ROLL: claim ACTIVE→ROLLED, then mint the successor for next cycle.
            const claim = await tx.programAssignment.updateMany({
              where: { id: a.id, status: "ACTIVE", rolledAt: null },
              data: { status: "ROLLED", rolledAt: now },
            });
            if (claim.count === 0) return { outcome: "skipped" as const };

            const successor = await tx.programAssignment.create({
              data: {
                programId: a.programId,
                membershipId: a.membershipId,
                periodStart: successorStart,
                periodEnd: successorEnd,
                status: "ACTIVE",
                // Fresh cycle — counters reset.
                engagementsUsed: 0,
                consumedPaise: 0,
                overageCount: 0,
              },
            });

            // Link the chain; @unique on rolledToAssignmentId backstops a
            // double-mint if two replicas slipped past the claim gate.
            await tx.programAssignment.update({
              where: { id: a.id },
              data: { rolledToAssignmentId: successor.id },
            });

            await tx.orgAuditLog.create({
              data: {
                organizationId: orgId,
                actorMembershipId: null,
                targetMembershipId: null,
                category: "PROGRAM",
                action: AUDIT_ACTIONS.PROGRAM.PROGRAM_ASSIGNMENT_ROLLED,
                description: `Program assignment for "${a.program.name ?? "Program"}" rolled into the next period (${formatAuditDate(successorStart)} → ${formatAuditDate(successorEnd)})`,
                details: {
                  assignmentId: a.id,
                  programId: a.programId,
                  successorAssignmentId: successor.id,
                  periodStart: successorStart.toISOString(),
                  periodEnd: successorEnd.toISOString(),
                },
              },
            });
            return { outcome: "rolled" as const, successorId: successor.id };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );

      if (result.outcome === "rolled") {
        stats.rolled += 1;
      } else if (result.outcome === "closed") {
        stats.closed += 1;
        await dispatchClosedSeatNotifications(
          a.id,
          result.stagedBells,
          result.stagedEmails,
        );
      } else {
        stats.skipped += 1;
      }
    } catch (err) {
      // Double-mint backstop: the successor's @@unique([programId,
      // membershipId, periodStart]) or rolledToAssignmentId @unique tripped
      // because another replica already minted. Idempotent — skip cleanly.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        stats.skipped += 1;
        continue;
      }
      console.error(
        `[advance-program-cycles] Failed for assignment ${a.id}:`,
        err,
      );
      failures.add("advance-program-cycles", err, { assignmentId: a.id });
      stats.failed += 1;
    }
  }

  failures.flush();
  stats.remaining = due.length - visited;
  return stats;
}

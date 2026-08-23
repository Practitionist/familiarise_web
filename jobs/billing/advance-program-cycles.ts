/**
 * #779 §A — Cron: advance ProgramAssignment cycles.
 *
 * Schedule: daily at 02:15 UTC (`.github/workflows/advance-program-cycles.yml`)
 * — ahead of auto-renew-contracts (02:30) and expire-contracts (03:00) so an
 * assignment whose contract is still ACTIVE rolls into its next period before
 * any contract-side state moves under it.
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
 * Usage:
 *   npx tsx jobs/billing/advance-program-cycles.ts
 *
 * Deferred (#777): CREDIT_POOL `minimumCreditsPerPeriod` shortfall billing
 * ("unconsumed commitment rolls into the next invoice") is NOT handled here —
 * it needs a per-program cycle-close concept (assignments roll individually),
 * so it ships with its own design when a customer commits to minimums.
 */

import "dotenv/config";
import prisma from "@/lib/prisma";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  decideCycleTransition,
  nextPeriodEnd,
  resolveProgramCycle,
} from "@/lib/enterprise/cycle-engine";
import { Prisma } from "@prisma/client";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

// Bounded scan — one batch per run; the next tick drains the remainder.
const BATCH_SIZE = 500;

interface AdvanceStats {
  scanned: number;
  rolled: number;
  closed: number;
  skipped: number;
}

export async function runAdvanceProgramCycles(): Promise<AdvanceStats> {
  const stats: AdvanceStats = { scanned: 0, rolled: 0, closed: 0, skipped: 0 };
  const now = new Date();

  // Candidates: ended periods on live programs, not yet processed.
  const due = await prisma.programAssignment.findMany({
    where: {
      status: "ACTIVE",
      rolledAt: null,
      periodEnd: { lte: now },
      program: { status: "ACTIVE", archivedAt: null },
    },
    take: BATCH_SIZE,
    select: {
      id: true,
      programId: true,
      membershipId: true,
      periodEnd: true,
      program: {
        select: {
          id: true,
          contract: {
            select: {
              organizationId: true,
              status: true,
              autoRenew: true,
              effectiveTo: true,
            },
          },
          licensedSeatConfig: { select: { cycle: true } },
          creditPoolConfig: { select: { cycle: true } },
        },
      },
    },
  });
  stats.scanned = due.length;

  for (const a of due) {
    const cycle = resolveProgramCycle(a.program);
    if (cycle === null) {
      // Malformed program (no money-config) — nothing to compute a period from.
      stats.skipped += 1;
      continue;
    }

    const successorStart = a.periodEnd;
    const successorEnd = nextPeriodEnd(successorStart, cycle);
    const decision = decideCycleTransition({
      successorPeriodStart: successorStart,
      successorPeriodEnd: successorEnd,
      contractStatus: a.program.contract.status,
      contractAutoRenew: a.program.contract.autoRenew,
      contractEffectiveTo: a.program.contract.effectiveTo,
    });

    const orgId = a.program.contract.organizationId;

    try {
      // #1132 follow-up — transient P2034 aborts now retry; persistent ones
      // still fall through to the outer catch's skip-with-Sentry semantics.
      const result = await withSerializableRetry(() =>
        prisma.$transaction(
        async (tx) => {
          if (decision.action === "CLOSE") {
            // Claim ACTIVE→CLOSED. Gate doubles as the distributed lock.
            const claim = await tx.programAssignment.updateMany({
              where: { id: a.id, status: "ACTIVE", rolledAt: null },
              data: { status: "CLOSED", rolledAt: now },
            });
            if (claim.count === 0) return { outcome: "skipped" as const };

            await tx.orgAuditLog.create({
              data: {
                organizationId: orgId,
                actorMembershipId: null,
                targetMembershipId: null,
                category: "PROGRAM",
                action: AUDIT_ACTIONS.PROGRAM.PROGRAM_ASSIGNMENT_ROLLED,
                description: `ProgramAssignment ${a.id} closed (${decision.reason}); no successor`,
                details: {
                  assignmentId: a.id,
                  programId: a.programId,
                  closed: true,
                  reason: decision.reason,
                },
              },
            });
            return { outcome: "closed" as const };
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
              description: `ProgramAssignment ${a.id} rolled to ${successor.id} (${successorStart.toISOString()} → ${successorEnd.toISOString()})`,
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

      if (result.outcome === "rolled") stats.rolled += 1;
      else if (result.outcome === "closed") stats.closed += 1;
      else stats.skipped += 1;
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
      Sentry.captureException(err, { tags: { subsystem: "jobs", job: "advance-program-cycles" } });
      stats.skipped += 1;
    }
  }

  return stats;
}

async function main() {
  console.log(
    `[advance-program-cycles] Starting at ${new Date().toISOString()}`,
  );
  Sentry.logger.info("job:advance-program-cycles started");
  const stats = await withCronLock(
    "advance-program-cycles",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => runAdvanceProgramCycles(),
  );
  Sentry.logger.info("job:advance-program-cycles finished", {
    scanned: stats.scanned,
    rolled: stats.rolled,
    closed: stats.closed,
    skipped: stats.skipped,
  });
  console.log(
    `[advance-program-cycles] Done. scanned=${stats.scanned} rolled=${stats.rolled} closed=${stats.closed} skipped=${stats.skipped}`,
  );
}

// Self-execute only when invoked directly (importable for unit tests).
if (require.main === module) {
  runJob("advance-program-cycles", () => main().finally(() => prisma.$disconnect()));
}

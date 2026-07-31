/**
 * #779 §A — Cron: auto-renew expiring contracts.
 *
 * Schedule: daily at 02:30 UTC (`.github/workflows/auto-renew-contracts.yml`)
 * — 40 min BEFORE expire-contracts.yml (03:10 UTC). Renewal must win the race
 * with expiry: we stamp the RENEWAL successor + flip the old contract to
 * EXPIRED here, so by the time expire-contracts runs there's nothing left for
 * it to expire (its claim gates on status=ACTIVE, which we've already moved).
 *
 * Per contract due for renewal (status ACTIVE, autoRenew, effectiveTo<=now,
 * autoRenewedAt null):
 *   1. Claim by stamping autoRenewedAt (gate doubles as the distributed lock).
 *   2. Mint the RENEWAL successor (same org/billingAccount/terms; effectiveFrom
 *      = old effectiveTo; effectiveTo = +same duration; status ACTIVE;
 *      autoRenew carried).
 *   3. Set old.supersededByContractId/At + supersessionReason=RENEWAL and flip
 *      old → EXPIRED in the same tx. We expire it here (rather than leaving it
 *      ACTIVE for expire-contracts) because a contract that has been superseded
 *      is, by definition, no longer the governing term — leaving two ACTIVE
 *      contracts on one org would double-count billing.
 *
 * Concurrency: candidates findMany (bounded) → per-row Serializable
 * $transaction → conditional updateMany claim (count===0 ⇒ skip) → side effects
 * in same tx → OrgAuditLog row. Mirrors jobs/contracts/expire-contracts.ts.
 *
 * Usage:
 *   npx tsx jobs/contracts/auto-renew-contracts.ts
 */

import "dotenv/config";
import prisma from "@/lib/prisma";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { Prisma } from "@prisma/client";
import { withCronLock, CronLockHeldError } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";

const BATCH_SIZE = 500;

interface RenewStats {
  scanned: number;
  renewed: number;
  skipped: number;
}

export async function runAutoRenewContracts(): Promise<RenewStats> {
  const stats: RenewStats = { scanned: 0, renewed: 0, skipped: 0 };
  const now = new Date();

  const due = await prisma.contract.findMany({
    where: {
      status: "ACTIVE",
      autoRenew: true,
      autoRenewedAt: null,
      effectiveTo: { lte: now, not: null },
    },
    take: BATCH_SIZE,
    select: {
      id: true,
      organizationId: true,
      billingAccountId: true,
      purchaseOrderId: true,
      effectiveFrom: true,
      effectiveTo: true,
      paymentTermsDays: true,
      autoRenew: true,
      rateCardId: true,
    },
  });
  stats.scanned = due.length;

  for (const c of due) {
    // effectiveTo is guaranteed non-null by the query filter.
    const oldFrom = c.effectiveFrom;
    const oldTo = c.effectiveTo as Date;
    // Same duration: successor runs [oldTo, oldTo + (oldTo - oldFrom)].
    const durationMs = oldTo.getTime() - oldFrom.getTime();
    const newTo = new Date(oldTo.getTime() + durationMs);

    try {
      const result = await prisma.$transaction(
        async (tx) => {
          // Claim: stamp autoRenewedAt only while still ACTIVE + unstamped.
          const claim = await tx.contract.updateMany({
            where: { id: c.id, status: "ACTIVE", autoRenewedAt: null },
            data: { autoRenewedAt: now },
          });
          if (claim.count === 0) return { renewed: false as const };

          const successor = await tx.contract.create({
            data: {
              organizationId: c.organizationId,
              billingAccountId: c.billingAccountId,
              purchaseOrderId: c.purchaseOrderId,
              status: "ACTIVE",
              effectiveFrom: oldTo,
              effectiveTo: newTo,
              paymentTermsDays: c.paymentTermsDays,
              autoRenew: c.autoRenew,
              rateCardId: c.rateCardId,
            },
          });

          // Re-point the old contract's programs to the successor — without
          // this, the cycle engine sees their contract as non-ACTIVE at the
          // next periodEnd and CLOSEs every assignment instead of rolling,
          // which would defeat the renewal. Invoices keep their old
          // contractId (the money trail stays on the term that billed them).
          await tx.program.updateMany({
            where: { contractId: c.id },
            data: { contractId: successor.id },
          });

          // Link supersession chain + retire the old contract. EXPIRED here
          // (not left ACTIVE) so expire-contracts has nothing to do.
          await tx.contract.update({
            where: { id: c.id },
            data: {
              status: "EXPIRED",
              supersededByContractId: successor.id,
              supersededAt: now,
              supersessionReason: "RENEWAL",
            },
          });

          await tx.orgAuditLog.create({
            data: {
              organizationId: c.organizationId,
              actorMembershipId: null,
              targetMembershipId: null,
              category: "CONTRACT",
              action: AUDIT_ACTIONS.CONTRACT.CONTRACT_AUTO_RENEWED,
              description: `Contract ${c.id} auto-renewed to ${successor.id} (${oldTo.toISOString()} → ${newTo.toISOString()})`,
              details: {
                contractId: c.id,
                successorContractId: successor.id,
                effectiveFrom: oldTo.toISOString(),
                effectiveTo: newTo.toISOString(),
              },
            },
          });
          return { renewed: true as const, successorId: successor.id };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

      if (result.renewed) stats.renewed += 1;
      else stats.skipped += 1;
    } catch (err) {
      // supersededByContractId @unique tripped — another replica already
      // renewed this contract. Idempotent; skip cleanly.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        stats.skipped += 1;
        continue;
      }
      Sentry.captureException(err, { tags: { subsystem: "jobs", job: "auto-renew-contracts" } });
      console.error(`[auto-renew-contracts] Failed for contract ${c.id}:`, err);
      stats.skipped += 1;
    }
  }

  return stats;
}

async function main() {
  Sentry.logger.info("job:auto-renew-contracts started");
  console.log(`[auto-renew-contracts] Starting at ${new Date().toISOString()}`);
  const stats = await withCronLock(
    "auto-renew-contracts",
    { failMode: "open" },
    () => runAutoRenewContracts(),
  );
  console.log(
    `[auto-renew-contracts] Done. scanned=${stats.scanned} renewed=${stats.renewed} skipped=${stats.skipped}`,
  );
  Sentry.logger.info("job:auto-renew-contracts finished", { scanned: stats.scanned, renewed: stats.renewed, skipped: stats.skipped });
}

// Self-execute only when invoked directly (importable for unit tests).
if (require.main === module) {
  runJob("auto-renew-contracts", async () => {
    try {
      await main();
    } catch (err) {
      // #476 — lock held = another run is live; skip cleanly (exit 0).
      if (err instanceof CronLockHeldError) {
        Sentry.logger.info("job:auto-renew-contracts lock already held — skipping");
        console.log(`⏭️  ${err.message}`);
        return;
      }
      // Anything else escapes to runJob, which captures it and flushes. (#1066)
      throw err;
    } finally {
      await prisma.$disconnect();
    }
  });
}

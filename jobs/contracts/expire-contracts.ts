/**
 * Cron: transition `Contract.status` from `ACTIVE` to `EXPIRED` for any
 * contract whose `effectiveTo` has passed.
 *
 * Schedule: daily at 03:00 IST (`.github/workflows/expire-contracts.yml`).
 * Quiet slot — does not race with the 00:00 / 01:00 / 02:00 cron clusters.
 *
 * Soft enforcement: contract expiry does NOT take the org offline. The
 * `requireOrgAccess` helper continues to honour the org regardless of
 * contract status — the only effect is:
 *   1. New `OrganizationInvoice` rolls only generate while the contract
 *      is `ACTIVE` (per `jobs/billing/generate-subscription-invoices.ts`).
 *   2. Active `ProgramAssignment` rows are soft-closed (periodEnd = now)
 *      so members stop drawing from program caps, but in-flight bookings
 *      complete normally.
 *   3. The org dashboard renders an "Expired" banner so operators
 *      renew the contract.
 *
 * Idempotent: only flips rows still in `ACTIVE`. Re-running on the same
 * day is a no-op.
 *
 * Usage:
 *   npx tsx jobs/contracts/expire-contracts.ts
 */

import { PrismaClient } from "@prisma/client";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const prisma = new PrismaClient();

interface ExpireStats {
  scanned: number;
  expired: number;
  assignmentsClosed: number;
}

export async function runExpireContracts(): Promise<ExpireStats> {
  const stats: ExpireStats = { scanned: 0, expired: 0, assignmentsClosed: 0 };
  const now = new Date();

  // Find every contract still ACTIVE whose effectiveTo is in the past.
  // `effectiveTo` is optional — null means open-ended, which never
  // expires automatically.
  const due = await prisma.contract.findMany({
    where: {
      status: "ACTIVE",
      effectiveTo: { lte: now, not: null },
    },
    select: { id: true, organizationId: true, effectiveTo: true },
  });
  stats.scanned = due.length;

  for (const c of due) {
    await prisma.$transaction(async (tx) => {
      // Conditional update — claim the row only if still ACTIVE so two
      // cron replicas don't double-process. Doubles as the distributed
      // lock; loser sees `claim.count === 0` and skips.
      const claim = await tx.contract.updateMany({
        where: { id: c.id, status: "ACTIVE" },
        data: { status: "EXPIRED" },
      });
      if (claim.count === 0) return;
      stats.expired += 1;

      // Soft-close active ProgramAssignments scoped to the contract.
      // `Program.contractId → Contract`, then ProgramAssignment.programId
      // resolves up to the contract. We close the period at `now` rather
      // than deleting so engagementsUsed history + UsageLedgerEntry rows
      // stay queryable for reconciliation.
      const programs = await tx.program.findMany({
        where: { contractId: c.id },
        select: { id: true },
      });
      if (programs.length > 0) {
        const programIds = programs.map((p) => p.id);
        const closed = await tx.programAssignment.updateMany({
          where: {
            programId: { in: programIds },
            periodEnd: { gte: now },
          },
          data: { periodEnd: now },
        });
        stats.assignmentsClosed += closed.count;
      }

      await tx.orgAuditLog.create({
        data: {
          organizationId: c.organizationId,
          actorMembershipId: null,
          targetMembershipId: null,
          category: "CONTRACT",
          action: AUDIT_ACTIONS.CONTRACT.CONTRACT_EXPIRED,
          description: `Contract ${c.id} auto-expired (effectiveTo=${c.effectiveTo?.toISOString()})`,
          details: {
            contractId: c.id,
            effectiveTo: c.effectiveTo?.toISOString() ?? null,
          },
        },
      });
    });
  }

  return stats;
}

async function main() {
  console.log(`[expire-contracts] Starting at ${new Date().toISOString()}`);
  const stats = await runExpireContracts();
  console.log(
    `[expire-contracts] Done. scanned=${stats.scanned} expired=${stats.expired} assignmentsClosed=${stats.assignmentsClosed}`,
  );
}

// Only run when invoked directly (allows the function to be imported and
// unit-tested without spinning up the cron entry-point).
if (require.main === module) {
  main()
    .catch((err) => {
      console.error("[expire-contracts] Failed:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

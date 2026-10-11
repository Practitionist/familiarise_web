/**
 * Cron: transition `Contract.status` from `ACTIVE` to `EXPIRED` for any
 * contract whose `effectiveTo` has passed.
 *
 * Schedule: daily at 03:10 UTC / 08:40 IST (`.github/workflows/expire-contracts.yml`, #709 minute map).
 * Quiet slot — does not race with the 00:00 / 01:00 / 02:00 cron clusters.
 *
 * Soft enforcement: contract expiry does NOT take the org offline. The
 * `requireOrgAccess` helper continues to honour the org regardless of
 * contract status — the only effect is:
 *   1. New `OrganizationInvoice` rolls only generate while the contract
 *      is `ACTIVE` (per `jobs/billing/generate-subscription-invoices.ts`).
 *   2. Live `ProgramAssignment` rows (ACTIVE or PAUSED) are closed, an
 *      in-period one ending now, and their billed seats are released, so
 *      members stop drawing from program caps; in-flight bookings
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

import "dotenv/config";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { closeContractSeats } from "@/lib/api/organizations/seat-count";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import * as Sentry from "@sentry/nextjs";
import { runJob } from "@/lib/observability/job-sentry";
import { EMAIL_BUDGET_MS } from "@/lib/email/config";
import type { StagedRecipientEmail as StagedEmail } from "@/lib/email/send-to-recipients";
import { attemptStaged } from "@/lib/email/send-to-recipients";
import {
  ONBOARDING_EMAIL_TYPES,
  stageOrgContractAndSeatEmail,
} from "@/lib/email/senders/onboarding";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu";
import { notifyOrgContractStatusChanged } from "@/lib/novu/org-workflows";
import { getAppUrl } from "@/lib/url";

interface ExpireStats {
  scanned: number;
  expired: number;
  assignmentsClosed: number;
}

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function stageExpiredContractNotifications(
  tx: TxClient,
  contract: {
    id: string;
    organizationId: string;
    effectiveTo: Date | null;
    organization: { name: string } | null;
  },
): Promise<{
  stagedBells: StagedTrigger[];
  stagedEmails: StagedEmail[];
}> {
  const orgName = contract.organization?.name ?? "Organization";
  const dashboardUrl = `${getAppUrl()}/dashboard/organization/${contract.organizationId}/billing`;
  const operatorRows = tx.membership?.findMany
    ? await tx.membership.findMany({
        where: {
          organizationId: contract.organizationId,
          status: "ACTIVE",
          role: { in: ["OWNER", "MAINTAINER"] },
        },
        select: { userId: true },
      })
    : [];
  const stagedBells =
    (await notifyOrgContractStatusChanged(
      contract.organizationId,
      {
        orgName,
        status: "EXPIRED",
        effectiveDate: contract.effectiveTo?.toISOString(),
        dashboardUrl,
      },
      tx.notificationOutbox ? { tx } : undefined,
    )) ?? [];
  const stagedEmails = await stageOrgContractAndSeatEmail(tx, {
    recipientUserIds: operatorRows.map((r) => r.userId),
    entityId: contract.id,
    kind: "CONTRACT_ENDED",
    orgName,
    effectiveDate: contract.effectiveTo ?? undefined,
    dashboardUrl,
  });
  return { stagedBells, stagedEmails };
}

async function notifyExpiredContract(
  contractId: string,
  stagedBells: StagedTrigger[],
  stagedEmails: StagedEmail[],
): Promise<void> {
  for (const bell of stagedBells) {
    try {
      await attemptTrigger(bell);
    } catch (err) {
      console.error(
        `[expire-contracts] Bell dispatch failed for contract ${contractId}:`,
        err,
      );
    }
  }
  if (stagedEmails.length > 0) {
    try {
      await attemptStaged(
        stagedEmails,
        ONBOARDING_EMAIL_TYPES.ORG_CONTRACT_AND_SEAT,
        EMAIL_BUDGET_MS.JOB,
      );
    } catch (err) {
      console.error(
        `[expire-contracts] Email dispatch failed for contract ${contractId}:`,
        err,
      );
    }
  }
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
    select: {
      id: true,
      organizationId: true,
      effectiveTo: true,
      organization: { select: { name: true } },
    },
  });
  stats.scanned = due.length;

  for (const c of due) {
    // #1132 — 01-concurrency-and-idempotency.md states each nightly lifecycle
    // cron runs Serializable; no isolation level was passed, so this ran at
    // READ COMMITTED. The CAS claim below is the real correctness guard, but
    // the documented behaviour should be true of the code.
    //
    // Raising the isolation level introduces P2034: a concurrent write can
    // abort the transaction, and an unretried abort would throw out of the
    // whole loop and leave every later contract unprocessed until tomorrow.
    // withSerializableRetry retries ONLY P2034, so business rejections still
    // propagate. `claimed` is returned rather than mutating stats inside the
    // callback — a retried callback would otherwise double-count.
    const claimed = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // Conditional update — claim the row only if still ACTIVE so two
          // cron replicas don't double-process. Doubles as the distributed
          // lock; loser sees `claim.count === 0` and skips.
          const claim = await tx.contract.updateMany({
            where: { id: c.id, status: "ACTIVE" },
            data: { status: "EXPIRED" },
          });
          if (claim.count === 0) {
            return {
              expired: false,
              assignmentsClosed: 0,
              stagedBells: [] as StagedTrigger[],
              stagedEmails: [] as StagedEmail[],
            };
          }
          // #1846 SM-C14 — the same seat close the manual TERMINATED/EXPIRED
          // PATCH runs: programs → EXPIRED, ACTIVE and PAUSED seats → CLOSED
          // through the assignment CAS, in-period seats end now, billed seats
          // released, one audit row per seat. History (engagementsUsed,
          // UsageLedgerEntry) stays queryable because nothing is deleted.
          const assignmentsClosed = await closeContractSeats(tx, {
            contractId: c.id,
            organizationId: c.organizationId,
            actorMembershipId: null,
            contractStatus: "EXPIRED",
            now,
          });

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

          const { stagedBells, stagedEmails } =
            await stageExpiredContractNotifications(tx, c);

          return {
            expired: true,
            assignmentsClosed,
            stagedBells,
            stagedEmails,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    if (claimed.expired) {
      stats.expired += 1;
      await notifyExpiredContract(
        c.id,
        claimed.stagedBells,
        claimed.stagedEmails,
      );
    }
    stats.assignmentsClosed += claimed.assignmentsClosed;
  }

  return stats;
}

async function main() {
  await abortIfMaintenance("expire-contracts");
  Sentry.logger.info("job:expire-contracts started");
  console.log(`[expire-contracts] Starting at ${new Date().toISOString()}`);
  // fail-closed since #1169 lists it as financial: expiry withdraws the
  // sponsorship the checkout resolver reads.
  const stats = await withCronLock(
    "expire-contracts",
    { failMode: "closed" },
    () => runExpireContracts(),
  );
  console.log(
    `[expire-contracts] Done. scanned=${stats.scanned} expired=${stats.expired} assignmentsClosed=${stats.assignmentsClosed}`,
  );
  Sentry.logger.info("job:expire-contracts finished", {
    scanned: stats.scanned,
    expired: stats.expired,
    assignmentsClosed: stats.assignmentsClosed,
  });
}

// Only run when invoked directly (allows the function to be imported and
// unit-tested without spinning up the cron entry-point).
if (require.main === module) {
  runJob("expire-contracts", () => main().finally(() => prisma.$disconnect()));
}

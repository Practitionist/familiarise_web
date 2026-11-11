/**
 * Releases consultant and host-organisation earnings from their hold to READY,
 * so a refund or dispute lands before the money is payable. The core of the
 * `release-earnings` registry job, dispatched only through `/api/cleanup/[job]`
 * and the admin system-jobs runner.
 */

import { AWAITING_HUMAN, EARNINGS_HOLDING_MISS } from "@/lib/booking/misses";
import {
  EarningStatus,
  OccurrenceCompletionStatus,
  Prisma,
  RefundStatus,
} from "@prisma/client";
import prisma, { type PrismaLike } from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";

/**
 * Result structure for release operations
 */
export interface ReleaseResult {
  success: boolean;
  /** Consultant earnings moved PENDING → READY. Unchanged in meaning (#1471). */
  releasedCount: number;
  /**
   * #1471 — host-organization earnings moved PENDING → READY. A separate
   * field rather than a widened `releasedCount`, so every existing consumer
   * (GitHub Actions outputs, the cleanup summary, the admin runner) keeps
   * reporting the number it always reported.
   */
  organizationEarningsReleased: number;
  errorCount: number;
  errors: string[];
}

export interface ReleaseEarningsOptions {
  /** #1356 — caps the batch for the Netlify ticker; undefined releases the
   * whole PENDING/past-hold set, as today.
   *
   * #1471 — the cap applies to EACH table independently, matching the #1390
   * decision for the ticker: a run bounded at 200 may release up to 200
   * consultant rows and up to 200 organization rows. */
  limit?: number;
}

export const UNDELIVERED_OCCURRENCE = {
  deletedAt: null,
  completionStatus: {
    in: [
      OccurrenceCompletionStatus.SCHEDULED,
      OccurrenceCompletionStatus.RESCHEDULED,
    ],
  },
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/**
 * Release earnings that have passed their hold period
 *
 * Finds earnings with:
 * - Status: PENDING
 * - holdUntil: Past current time
 *
 * Updates them to READY status for payout processing.
 *
 * @returns ReleaseResult with counts and error details
 */
/**
 * #1775 P-2 — an earning whose payment has a refund still in flight is not
 * released: the clawback cascade sizes itself when that refund settles, and a
 * READY (or paid-out) row would pay the consultant money that is leaving.
 * Repeated in the claim's WHERE so a refund opened mid-run keeps the row.
 */
/**
 * #1569 D10 — NO_UNSETTLED_MISS rides the same payment filter: a booking owing
 * a make-up or a refund for a host-cancelled or voided session, or holding a
 * session parked for ops, keeps its earning PENDING (a hold, not a clawback).
 * A subscription's misses do not hold it (`EARNINGS_HOLDING_MISS`).
 */
export const RELEASABLE_PAYMENT = {
  refunds: { none: { status: RefundStatus.PENDING, deletedAt: null } },
  // A refund some door still owes (retrying, or spent and waiting on support)
  // holds every earning on the payment until the marker clears.
  refundOwedKey: null,
  NOT: {
    appointment: {
      occurrences: { some: UNDELIVERED_OCCURRENCE },
    },
  },
  OR: [
    { appointmentId: null },
    {
      appointment: {
        AND: [
          { occurrences: { none: EARNINGS_HOLDING_MISS } },
          { occurrences: { none: AWAITING_HUMAN } },
        ],
      },
    },
  ],
} satisfies Prisma.PaymentWhereInput;

const NO_OPEN_REFUND: Prisma.ConsultantEarningsWhereInput = {
  payment: RELEASABLE_PAYMENT,
};

/** The same guards on the host-organisation arm (#1775 P-2, #1569). */
const NO_OPEN_REFUND_ORG: Prisma.OrganizationEarningsWhereInput = {
  payment: RELEASABLE_PAYMENT,
};

/** Consultant earnings past their hold; shared with the ticker's idle probe. */
function releasableEarningsWhere(
  now: Date,
): Prisma.ConsultantEarningsWhereInput {
  return {
    status: EarningStatus.PENDING,
    holdUntil: { lte: now },
    ...NO_OPEN_REFUND,
  };
}

/** Host-organisation earnings past their hold; shared with the ticker's idle probe. */
function releasableOrgEarningsWhere(
  now: Date,
): Prisma.OrganizationEarningsWhereInput {
  return {
    status: EarningStatus.PENDING,
    holdUntil: { lte: now },
    ...NO_OPEN_REFUND_ORG,
  };
}

/** True when either earnings table holds a row the run would release. */
export async function hasReleasableEarningsWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const consultant = await db.consultantEarnings.findFirst({
    where: releasableEarningsWhere(now),
    select: { id: true },
  });
  if (consultant) return true;
  if (outOfTime()) return true;
  const org = await db.organizationEarnings.findFirst({
    where: releasableOrgEarningsWhere(now),
    select: { id: true },
  });
  return org !== null;
}

// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function releaseEarningsFromHold(
  opts: ReleaseEarningsOptions = {},
): Promise<ReleaseResult> {
  return withCronLock("release-earnings", { failMode: "closed" }, () =>
    releaseEarningsFromHoldUnlocked(opts),
  );
}

async function releaseEarningsFromHoldUnlocked(
  opts: ReleaseEarningsOptions = {},
): Promise<ReleaseResult> {
  console.log("💰 Starting earnings release from hold...");

  const result: ReleaseResult = {
    success: false,
    releasedCount: 0,
    organizationEarningsReleased: 0,
    errorCount: 0,
    errors: [],
  };

  try {
    const now = new Date();

    // #776 — read the snapshot and claim the rows inside one Serializable tx so an
    // overlapping cron run can't observe the same PENDING set and double-count the
    // release in logs/metrics. The updateMany predicate is the real money guard
    // (already-READY rows are skipped); the transaction keeps the logged snapshot
    // equal to what was actually transitioned. A serialization conflict aborts this
    // run; the next hourly run reaps the rows.
    //
    // #1356 — the read is capped with `take: opts.limit` for the Netlify
    // ticker, so the claim below updates by the same id set the read
    // returned rather than repeating the open-ended predicate; otherwise a
    // capped read would under-report a release that actually touched every
    // matching row.
    const { earningsToRelease, releasedCount } = await prisma.$transaction(
      async (tx) => {
        const rows = await tx.consultantEarnings.findMany({
          where: releasableEarningsWhere(now),
          include: {
            consultantProfile: {
              include: {
                user: { select: { name: true, email: true } },
              },
            },
            payment: { select: { id: true, amount: true } },
          },
          take: opts.limit,
        });

        const updated = await tx.consultantEarnings.updateMany({
          where: {
            id: { in: rows.map((r) => r.id) },
            status: EarningStatus.PENDING,
            ...NO_OPEN_REFUND,
          },
          data: {
            status: EarningStatus.READY,
          },
        });

        return { earningsToRelease: rows, releasedCount: updated.count };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      },
    );

    console.log(
      `📊 Found ${earningsToRelease.length} consultant earnings ready for release`,
    );
    result.releasedCount = releasedCount;

    for (const earning of earningsToRelease) {
      console.log(
        `✅ Released consultant earning ${earning.id}: ₹${(earning.consultantSharePaise / 100).toFixed(2)} for ${earning.consultantProfile.user.name || "Unknown"}`,
      );
    }

    // #1471 — the host-organization arm, deliberately a SEPARATE Serializable
    // transaction rather than a widened one. The two tables share nothing but
    // the predicate, and a serialization conflict on one should not throw away
    // a release the other already claimed. The `limit` is applied again here so
    // each table gets its own full budget (#1390).
    const { orgEarningsToRelease, orgReleasedCount } =
      await prisma.$transaction(
        async (tx) => {
          const rows = await tx.organizationEarnings.findMany({
            where: releasableOrgEarningsWhere(now),
            select: {
              id: true,
              orgSharePaise: true,
              organization: { select: { name: true } },
            },
            orderBy: { holdUntil: "asc" },
            take: opts.limit,
          });

          // CAS-in-WHERE: `status: PENDING` is re-stated on the claim so a row
          // another writer moved (a dispute freeze, a refund cascade) between
          // the read and the update is skipped rather than dragged to READY.
          const updated = await tx.organizationEarnings.updateMany({
            where: {
              id: { in: rows.map((r) => r.id) },
              status: EarningStatus.PENDING,
              ...NO_OPEN_REFUND_ORG,
            },
            data: {
              status: EarningStatus.READY,
            },
          });

          return {
            orgEarningsToRelease: rows,
            orgReleasedCount: updated.count,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 15_000,
        },
      );

    console.log(
      `📊 Found ${orgEarningsToRelease.length} organization earnings ready for release`,
    );
    result.organizationEarningsReleased = orgReleasedCount;

    for (const earning of orgEarningsToRelease) {
      console.log(
        `✅ Released organization earning ${earning.id}: ₹${(earning.orgSharePaise / 100).toFixed(2)} for ${earning.organization.name}`,
      );
    }

    result.success = true;

    // Summary
    console.log(`\n📈 Release Summary:`);
    console.log(`   ✅ Released: ${result.releasedCount} consultant earnings`);
    console.log(
      `   💰 Consultant total: ₹${(earningsToRelease.reduce((sum, e) => sum + e.consultantSharePaise, 0) / 100).toFixed(2)}`,
    );
    console.log(
      `   ✅ Released: ${result.organizationEarningsReleased} organization earnings`,
    );
    console.log(
      `   💰 Organization total: ₹${(orgEarningsToRelease.reduce((sum, e) => sum + e.orgSharePaise, 0) / 100).toFixed(2)}`,
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Release job failed:", errorMessage);
    result.errors.push(`Job failed: ${errorMessage}`);
    result.success = false;
    result.errorCount++;
  }

  return result;
}

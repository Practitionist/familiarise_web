#!/usr/bin/env node

/**
 * Release Earnings Script
 *
 * Releases both consultant AND host-organization earnings from their hold
 * period to READY status. Earnings are held for a period after payment so a
 * refund or dispute lands before the money is payable.
 *
 * Both arms run in one pass, so a host organisation's retained share reaches
 * READY for `createOrgPayoutBatch` like a consultant's.
 *
 * Registered as `release-earnings` in lib/cron/cleanup-registry.ts and run by
 * the ticker every 15 minutes (`TARGET_EVERY_MINUTES` in lib/cron/schedule.ts).
 */

import {
  AWAITING_HUMAN,
  EARNINGS_HOLDING_MISS,
  UNCONFIRMED_LEARNER_ABSENT,
} from "@/lib/booking/misses";
import {
  EarningStatus,
  OccurrenceCompletionStatus,
  Prisma,
  RefundStatus,
} from "@prisma/client";
import prisma, { type PrismaLike, type Tx } from "@/lib/prisma";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import { sumPaise } from "@/lib/payments/utils/money";
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
 * A cash refund that is PENDING, or SUCCEEDED with its cascade not yet applied.
 * A zero-amount credit restoration never cascades and never gates.
 */
const REFUND_IN_FLIGHT = {
  amountPaise: { gt: 0 },
  status: { notIn: [RefundStatus.FAILED, RefundStatus.CANCELLED] },
  OR: [{ status: RefundStatus.PENDING }, { cascadedAt: null }],
} satisfies Prisma.RefundWhereInput;

const ACTIVE_DISPUTE = {
  status: { notIn: DISPUTE_INACTIVE_FOR_GATING },
} satisfies Prisma.DisputeWhereInput;

/**
 * Money owed back on a payment, one clause per reason. A payment matching any
 * clause funds no payout: release, batching and both claim gates read these.
 */
export const MONEY_OWED_PAYMENT = {
  refundInFlight: { refunds: { some: REFUND_IN_FLIGHT } },
  activeDispute: { disputes: { some: ACTIVE_DISPUTE } },
  refundOwed: { refundOwedKey: { not: null } },
} satisfies Record<string, Prisma.PaymentWhereInput>;

/** The same three clauses negated: nothing is owed back on the payment. */
export const NO_MONEY_OWED_PAYMENT = {
  refunds: { none: REFUND_IN_FLIGHT },
  disputes: { none: ACTIVE_DISPUTE },
  refundOwedKey: null,
} satisfies Prisma.PaymentWhereInput;

/** Every live session of the booking has been delivered. */
const EVERY_SESSION_DELIVERED = {
  NOT: {
    appointment: {
      occurrences: { some: UNDELIVERED_OCCURRENCE },
    },
  },
} satisfies Prisma.PaymentWhereInput;

/**
 * The release gates that do not depend on delivery: no money owed back, and no
 * session owing a make-up, parked for a human or carrying an unconfirmed
 * learner-absent verdict. A subscription's misses do not hold it
 * (`EARNINGS_HOLDING_MISS`).
 */
const RELEASE_GATES_BESIDE_DELIVERY = {
  ...NO_MONEY_OWED_PAYMENT,
  OR: [
    { appointmentId: null },
    {
      appointment: {
        AND: [
          { occurrences: { none: EARNINGS_HOLDING_MISS } },
          { occurrences: { none: AWAITING_HUMAN } },
          // A learner-absent verdict pays the expert only once it is confirmed.
          { occurrences: { none: UNCONFIRMED_LEARNER_ABSENT } },
        ],
      },
    },
  ],
} satisfies Prisma.PaymentWhereInput;

/**
 * A payment whose PENDING earnings may be released: every gate above, and every
 * live session delivered. The claim's WHERE repeats it, so a gate that appears
 * mid-run keeps the row.
 */
export const RELEASABLE_PAYMENT = {
  ...RELEASE_GATES_BESIDE_DELIVERY,
  ...EVERY_SESSION_DELIVERED,
} satisfies Prisma.PaymentWhereInput;

/**
 * The gate on one consultant earning. A plan tranche is dated only when its
 * cycle is delivered and loses the date when a void un-delivers it, so a dated
 * tranche does not wait for the plan's later sessions; every other gate holds
 * it. Any other earning waits for every live session of its booking.
 */
const RELEASABLE_CONSULTANT_EARNING = {
  payment: RELEASE_GATES_BESIDE_DELIVERY,
  OR: [{ cycleOrdinal: { not: null } }, { payment: EVERY_SESSION_DELIVERED }],
} satisfies Prisma.ConsultantEarningsWhereInput;

/** The payment gate on the host-organisation arm: a plan's one earning waits for the whole plan. */
const RELEASABLE_ORG_EARNING: Prisma.OrganizationEarningsWhereInput = {
  payment: RELEASABLE_PAYMENT,
};

export type IncidentWindow = { startsAt: Date; endsAt: Date };

/** Declared incidents whose enumeration has not yet decided every overlapping session. */
export function undecidedIncidents(
  db: Pick<Tx, "platformIncident">,
): Promise<IncidentWindow[]> {
  return db.platformIncident.findMany({
    where: { enumeratedAt: null },
    select: { startsAt: true, endsAt: true },
  });
}

/**
 * Holds a payment whose booking has a session inside one of these incident
 * windows (the enumerator's own overlap test), until the enumeration decides
 * the session. Empty when no incident is undecided.
 */
export function clearOfIncidents(incidents: IncidentWindow[]): {
  AND?: [{ payment: Prisma.PaymentWhereInput }];
} {
  if (incidents.length === 0) return {};
  const overlapping = {
    isTentative: false,
    deletedAt: null,
    OR: incidents.map((incident) => ({
      startsAt: { lt: incident.endsAt },
      endsAt: { gt: incident.startsAt },
    })),
  } satisfies Prisma.AppointmentOccurrenceWhereInput;
  return {
    AND: [
      {
        payment: {
          NOT: { appointment: { occurrences: { some: overlapping } } },
        },
      },
    ],
  };
}

/** Consultant earnings past their hold; shared by the read, the claim and, without incidents, the ticker's idle probe. */
function releasableEarningsWhere(
  now: Date,
  incidents: IncidentWindow[],
): Prisma.ConsultantEarningsWhereInput {
  return {
    status: EarningStatus.PENDING,
    holdUntil: { lte: now },
    ...RELEASABLE_CONSULTANT_EARNING,
    ...clearOfIncidents(incidents),
  };
}

/** Host-organisation earnings past their hold; shared by the read, the claim and, without incidents, the ticker's idle probe. */
function releasableOrgEarningsWhere(
  now: Date,
  incidents: IncidentWindow[],
): Prisma.OrganizationEarningsWhereInput {
  return {
    status: EarningStatus.PENDING,
    holdUntil: { lte: now },
    ...RELEASABLE_ORG_EARNING,
    ...clearOfIncidents(incidents),
  };
}

/** True when either earnings table holds a row the run would release. */
export async function hasReleasableEarningsWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  // The probe skips the incident read: at worst it dispatches a run that an undecided incident then holds.
  const consultant = await db.consultantEarnings.findFirst({
    where: releasableEarningsWhere(now, []),
    select: { id: true },
  });
  if (consultant) return true;
  if (outOfTime()) return true;
  const org = await db.organizationEarnings.findFirst({
    where: releasableOrgEarningsWhere(now, []),
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
        const incidents = await undecidedIncidents(tx);
        const rows = await tx.consultantEarnings.findMany({
          where: releasableEarningsWhere(now, incidents),
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

        // The whole gate again, date included: a void that cleared a tranche's date since the read keeps the row.
        const updated = await tx.consultantEarnings.updateMany({
          where: {
            id: { in: rows.map((r) => r.id) },
            ...releasableEarningsWhere(now, incidents),
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
          const incidents = await undecidedIncidents(tx);
          const rows = await tx.organizationEarnings.findMany({
            where: releasableOrgEarningsWhere(now, incidents),
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
              ...RELEASABLE_ORG_EARNING,
              ...clearOfIncidents(incidents),
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

/**
 * Get statistics about pending earnings
 */
export async function getPendingEarningsStats(): Promise<{
  pendingCount: number;
  pendingAmount: number;
  readyCount: number;
  readyAmount: number;
}> {
  const [pending, ready] = await Promise.all([
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.PENDING },
      _sum: { consultantSharePaise: true },
      _count: true,
    }),
    prisma.consultantEarnings.aggregate({
      where: { status: EarningStatus.READY },
      _sum: { consultantSharePaise: true },
      _count: true,
    }),
  ]);

  return {
    pendingCount: pending._count,
    pendingAmount: sumPaise(pending._sum.consultantSharePaise),
    readyCount: ready._count,
    readyAmount: sumPaise(ready._sum.consultantSharePaise),
  };
}

/**
 * Run the release task and print stats
 */
export async function runReleaseTask(): Promise<ReleaseResult> {
  const startTime = Date.now();
  console.log(
    `🚀 Starting earnings release job at ${new Date().toISOString()}`,
  );

  try {
    // Get pre-release stats
    const preStats = await getPendingEarningsStats();
    console.log(`\n📊 Pre-release Stats:`);
    console.log(
      `   ⏳ Pending: ${preStats.pendingCount} earnings (₹${(preStats.pendingAmount / 100).toFixed(2)})`,
    );
    console.log(
      `   ✅ Ready: ${preStats.readyCount} earnings (₹${(preStats.readyAmount / 100).toFixed(2)})`,
    );

    // Run release
    const result = await releaseEarningsFromHold();

    // Get post-release stats
    const postStats = await getPendingEarningsStats();
    console.log(`\n📊 Post-release Stats:`);
    console.log(
      `   ⏳ Pending: ${postStats.pendingCount} earnings (₹${(postStats.pendingAmount / 100).toFixed(2)})`,
    );
    console.log(
      `   ✅ Ready: ${postStats.readyCount} earnings (₹${(postStats.readyAmount / 100).toFixed(2)})`,
    );

    const duration = (Date.now() - startTime) / 1000;
    console.log(`\n⏱️ Job completed in ${duration.toFixed(2)} seconds`);

    return result;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Disconnect from the database
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

// Run the release if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runReleaseTask()
    .then((result) => {
      if (result.success) {
        console.log("🎉 Earnings release job completed successfully");
        process.exit(0);
      } else {
        console.error("❌ Earnings release job completed with errors");
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error("💥 Earnings release job failed:", error);
      process.exit(1);
    });
}

/**
 * Captured-but-uncredited wallet top-up reconciler (#785, task #23).
 *
 * confirmTopUp's body is a single $transaction (claim PENDING→CONFIRMED + wallet
 * credit + ledger post). If the ledger post fails the whole tx rolls back, so a
 * gateway-CAPTURED top-up reverts to PENDING and the gateway won't resend. Before
 * #785 the abandoned-cleanup cron then hard-deleted it, losing the org's money.
 *
 * confirmTopUp now stamps `capturedAt` + `providerPaymentId` OUTSIDE the tx, so a
 * captured-but-uncredited top-up keeps those even after a rollback. This job finds
 * those rows and re-runs the (idempotent) confirm to land the credit.
 */
import type { Prisma } from "@prisma/client";
import prisma, { type PrismaLike } from "@/lib/prisma";
import { confirmTopUp } from "@/lib/api/organizations/wallet";
import { withCronLock } from "@/lib/cron/with-cron-lock";

export interface TopupCaptureSweepResult {
  success: boolean;
  scanned: number;
  recredited: number;
  stillFailing: number;
  errors: string[];
}

export interface TopupCaptureSweepOptions {
  /** Let confirmTopUp's own in-request path settle first. */
  graceMinutes?: number;
  /** Long tail — the money is real; don't silently drop very old captures. */
  maxAgeHours?: number;
  limit?: number;
}

const DEFAULT_GRACE_MINUTES = 5;
const DEFAULT_MAX_AGE_HOURS = 720; // 30 days

/** Shared by the sweep's query and the ticker's idle probe. */
function orphanedTopupCaptureWhere(
  captureBefore: Date,
  tooOld: Date,
): Prisma.WalletTopUpWhereInput {
  return {
    // FAILED is an abandoned row whose order captured late.
    status: { in: ["PENDING", "FAILED"] },
    providerPaymentId: { not: null },
    capturedAt: { lt: captureBefore, gte: tooOld },
  };
}

/** True when the sweep's default-window query would find at least one top-up. */
export async function hasOrphanedTopupCaptureWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const row = await db.walletTopUp.findFirst({
    where: orphanedTopupCaptureWhere(
      new Date(now.getTime() - DEFAULT_GRACE_MINUTES * 60_000),
      new Date(now.getTime() - DEFAULT_MAX_AGE_HOURS * 3_600_000),
    ),
    select: { id: true },
  });
  return row !== null;
}

// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function sweepOrphanedTopupCaptures(
  opts: TopupCaptureSweepOptions = {},
): Promise<TopupCaptureSweepResult> {
  return withCronLock(
    "sweep-orphaned-topup-captures",
    { failMode: "closed" },
    () => sweepOrphanedTopupCapturesUnlocked(opts),
  );
}

async function sweepOrphanedTopupCapturesUnlocked(
  opts: TopupCaptureSweepOptions = {},
): Promise<TopupCaptureSweepResult> {
  const graceMinutes = opts.graceMinutes ?? DEFAULT_GRACE_MINUTES;
  const maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const limit = opts.limit ?? 200;
  const now = Date.now();
  const captureBefore = new Date(now - graceMinutes * 60_000);
  const tooOld = new Date(now - maxAgeHours * 3_600_000);

  // Captured (capturedAt + providerPaymentId set outside the tx) but not
  // CONFIRMED ⇒ the confirm/ledger post rolled back. `lt/gte` on capturedAt also
  // excludes null (null never satisfies a comparison in Postgres).
  const orphans = await prisma.walletTopUp.findMany({
    where: orphanedTopupCaptureWhere(captureBefore, tooOld),
    select: {
      providerOrderId: true,
      providerPaymentId: true,
      amountPaise: true,
    },
    orderBy: { capturedAt: "asc" },
    take: limit,
  });

  const errors: string[] = [];
  let recredited = 0;
  let stillFailing = 0;

  for (const t of orphans) {
    try {
      const result = await confirmTopUp(prisma, {
        providerOrderId: t.providerOrderId,
        providerPaymentId: t.providerPaymentId!,
        amountPaise: t.amountPaise,
      });
      // confirmed=false ⇒ a concurrent path already CONFIRMED it (not stuck).
      if (result.confirmed) {
        recredited++;
        console.log(`✅ Re-credited captured top-up ${t.providerOrderId}`);
      }
    } catch (e) {
      stillFailing++;
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${t.providerOrderId}: ${msg}`);
    }
  }

  return {
    success: true,
    scanned: orphans.length,
    recredited,
    stillFailing,
    errors,
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

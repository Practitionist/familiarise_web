/**
 * Abandoned Organization Wallet Top-Up Cleanup — Core Logic
 *
 * Settles pending `WalletTopUp` rows older than the grace window against the
 * gateway: a captured order is handed to `confirmTopUp`, an order holding no
 * payment is hard-deleted (`providerOrderId @unique` would otherwise block a
 * retry under the same client key), and anything else is kept.
 *
 * Never deletes a top-up whose gateway order is not proven empty: a row with no
 * minted order id is never a candidate, and a gateway failure skips the row.
 *
 * Reached through the `abandoned-org-top-ups` cleanup twin, which the ticker
 * runs in its daily window from 03:00 UTC.
 */

import { startDeadline } from "@/lib/cron/run-deadline";
import { LEAST_RECENTLY_RECONCILED } from "@/lib/payments/payouts/reconcile-cursor";
import prisma from "../../lib/prisma";
import type { PrismaLike } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import {
  confirmTopUp,
  parseMintedOrderId,
} from "@/lib/api/organizations/wallet";
import { readRazorpayOrderHolding } from "@/lib/payments/core/razorpay";

const DEFAULT_GRACE_HOURS = 48; // exceeds Razorpay 24h webhook exponential retry SLA

/** Pending minted top-ups created before `cutoff`; shared by the run and the ticker's idle probe. */
function abandonedTopUpWhere(cutoff: Date): Prisma.WalletTopUpWhereInput {
  return {
    status: "PENDING",
    providerPaymentId: null,
    // A captured row whose confirm rolled back belongs to sweep-orphaned-topup-captures.
    capturedAt: null,
    createdAt: { lt: cutoff },
    // Only a minted order can be proven empty; the rest never leave the table.
    notes: { contains: "razorpay_order=order_" },
  };
}

/** Ticker idle probe at the ticker's default grace window. */
export async function hasAbandonedOrgTopUpWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - DEFAULT_GRACE_HOURS * 60 * 60 * 1000);
  if (outOfTime()) return true;
  const row = await db.walletTopUp.findFirst({
    where: abandonedTopUpWhere(cutoff),
    select: { id: true },
  });
  return row !== null;
}

export interface AbandonedOrgTopUpCleanupResult {
  success: boolean;
  reaped: number;
  /** Captured at the gateway and credited by this run. */
  confirmed: number;
  /** Left in place: a payment still live at the gateway, or a row that changed underneath. */
  kept: number;
  graceHours: number;
  cutoff: string;
  errors: string[];
  timestamp: string;
}

export interface AbandonedOrgTopUpCleanupOptions {
  /** Override the grace window (hours). Defaults to 48h. */
  graceHours?: number;
  /** Oldest-first cap on the placeholders one run settles. */
  limit?: number;
  startedAt?: number;
}

/**
 * Settle pending wallet top-up placeholders older than the grace window.
 */
// Locked at the core so every entry shares one mutual exclusion; fail-closed.
export async function cleanupAbandonedOrgTopUps(
  options: AbandonedOrgTopUpCleanupOptions = {},
): Promise<AbandonedOrgTopUpCleanupResult> {
  return withCronLock(
    "cleanup-abandoned-org-top-ups",
    { failMode: "closed" },
    () => cleanupAbandonedOrgTopUpsUnlocked(options),
  );
}

type Outcome = "reaped" | "confirmed" | "kept";

async function settleOne(c: {
  id: string;
  providerOrderId: string;
  amountPaise: number;
  notes: string | null;
}): Promise<Outcome> {
  const orderId = parseMintedOrderId(c.notes);
  if (!orderId) return "kept";
  const holding = await readRazorpayOrderHolding(orderId);
  if (holding.kind === "captured") {
    const { confirmed } = await confirmTopUp(prisma, {
      providerOrderId: c.providerOrderId,
      providerPaymentId: holding.paymentId,
      amountPaise: holding.amountPaise,
    });
    return confirmed ? "confirmed" : "kept";
  }
  if (holding.kind === "live") return "kept";
  // The predicate rides the DELETE so a webhook confirming in between wins.
  const deleted = await prisma.walletTopUp.deleteMany({
    where: {
      id: c.id,
      status: "PENDING",
      providerPaymentId: null,
      capturedAt: null,
    },
  });
  return deleted.count === 1 ? "reaped" : "kept";
}

async function cleanupAbandonedOrgTopUpsUnlocked(
  options: AbandonedOrgTopUpCleanupOptions = {},
): Promise<AbandonedOrgTopUpCleanupResult> {
  const pastDeadline = startDeadline(options.startedAt);
  const graceHours = options.graceHours ?? DEFAULT_GRACE_HOURS;
  const cutoff = new Date(Date.now() - graceHours * 60 * 60 * 1000);
  const errors: string[] = [];
  const counts: Record<Outcome, number> = { reaped: 0, confirmed: 0, kept: 0 };

  try {
    const candidates = await prisma.walletTopUp.findMany({
      where: abandonedTopUpWhere(cutoff),
      orderBy: [LEAST_RECENTLY_RECONCILED, { id: "asc" }],
      take: options.limit ?? 25,
      select: {
        id: true,
        billingAccountId: true,
        providerOrderId: true,
        amountPaise: true,
        notes: true,
      },
    });

    for (const c of candidates) {
      if (pastDeadline()) break;
      try {
        const outcome = await settleOne(c);
        counts[outcome] += 1;
        console.log(
          `   WalletTopUp ${c.id} (billingAccount ${c.billingAccountId}, order ${c.providerOrderId}): ${outcome}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${c.providerOrderId}: ${message}`);
      } finally {
        try {
          await prisma.$executeRaw`UPDATE "WalletTopUp" SET "lastReconciledAt" = now() WHERE id = ${c.id}`;
        } catch (error) {
          errors.push(
            `Polling cursor WalletTopUp ${c.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`Cleanup failed: ${message}`);
    console.error(`   Error: ${message}`);
  }

  return {
    success: errors.length === 0,
    ...counts,
    graceHours,
    cutoff: cutoff.toISOString(),
    errors,
    timestamp: new Date().toISOString(),
  };
}

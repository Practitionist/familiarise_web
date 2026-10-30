/**
 * Recover standalone sales (digital products and replays) whose capture never
 * reached us: a PENDING purchase older than 15 minutes is checked against its
 * Razorpay order, a captured payment is routed to its handler exactly as the
 * webhook would, and an order still empty after 24 hours is marked FAILED.
 */
import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import {
  fetchRazorpayOrder,
  readRazorpayOrderHolding,
} from "@/lib/payments/core/razorpay";
import { routeCapturedPayment } from "@/app/api/webhooks/razorpay-dispatch";
import { reportSentryError } from "@/lib/observability/report";

const STANDALONE_ORDER_TYPES: ReadonlySet<string> = new Set([
  "recording_purchase",
  "digital_product_purchase",
]);

/**
 * Ask Razorpay what a standalone sale order holds and route a captured payment
 * to its handler exactly as the webhook would. Throws when the gateway cannot answer.
 */
export async function recoverStandaloneOrder(
  orderId: string,
): Promise<"captured" | "live" | "empty"> {
  const holding = await readRazorpayOrderHolding(orderId);
  if (holding.kind !== "captured") return holding.kind;
  const order = await fetchRazorpayOrder(orderId);
  if (!order) throw new Error("RAZORPAY_NOT_INITIALIZED");
  // The notes pick the handler; anything else would reach the booking pipeline.
  if (!STANDALONE_ORDER_TYPES.has(order.notes.type ?? "")) {
    throw new Error(`Order ${orderId} is not a standalone sale order`);
  }
  await routeCapturedPayment({
    orderId,
    notes: order.notes,
    amountPaise: holding.amountPaise,
    gatewayPaymentId: holding.paymentId,
  });
  return "captured";
}

export interface ReconcileStandalonePurchasesResult {
  success: boolean;
  scanned: number;
  /** Captures routed to their handler this run. */
  recovered: number;
  /** Purchases marked FAILED after 24 hours with nothing captured for them. */
  expired: number;
  errors: number;
  timestamp: string;
}

const DEFAULT_LIMIT = 5;
/** Leaves the webhook and the client verify their own chance first. */
const GRACE_MS = 15 * 60_000;
const EXPIRE_AFTER_MS = 24 * 60 * 60_000;

type Rail = "digital" | "replay";
interface Candidate {
  rail: Rail;
  id: string;
  orderId: string;
  createdAt: Date;
}

async function pendingCandidates(
  limit: number,
  graceCutoff: Date,
): Promise<Candidate[]> {
  // Oldest-touched first, so a row left PENDING rotates behind fresh ones.
  const [digital, replay] = await Promise.all([
    prisma.digitalProductPurchase.findMany({
      where: {
        status: "PENDING",
        gatewayOrderId: { not: null },
        createdAt: { lt: graceCutoff },
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { id: true, gatewayOrderId: true, createdAt: true },
    }),
    prisma.recordingPurchase.findMany({
      where: { status: "PENDING", createdAt: { lt: graceCutoff } },
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { id: true, gatewayOrderId: true, createdAt: true },
    }),
  ]);
  return [
    ...digital.flatMap((row) =>
      row.gatewayOrderId
        ? [
            {
              rail: "digital" as const,
              id: row.id,
              orderId: row.gatewayOrderId,
              createdAt: row.createdAt,
            },
          ]
        : [],
    ),
    ...replay.map((row) => ({
      rail: "replay" as const,
      id: row.id,
      orderId: row.gatewayOrderId,
      createdAt: row.createdAt,
    })),
  ];
}

/** CAS on the PENDING row: FAILED once expired, otherwise touched so it rotates. */
async function settleStillPending(
  candidate: Candidate,
  expired: boolean,
): Promise<boolean> {
  const where = { id: candidate.id, status: "PENDING" as const };
  const data = expired
    ? { status: "FAILED" as const }
    : { updatedAt: new Date() };
  const res =
    candidate.rail === "digital"
      ? await prisma.digitalProductPurchase.updateMany({ where, data })
      : await prisma.recordingPurchase.updateMany({ where, data });
  return expired && res.count === 1;
}

async function reconcileUnlocked(
  limit: number,
): Promise<ReconcileStandalonePurchasesResult> {
  const now = new Date();
  const result: ReconcileStandalonePurchasesResult = {
    success: true,
    scanned: 0,
    recovered: 0,
    expired: 0,
    errors: 0,
    timestamp: now.toISOString(),
  };
  const candidates = await pendingCandidates(
    limit,
    new Date(now.getTime() - GRACE_MS),
  );
  result.scanned = candidates.length;

  // One Sentry event per run, never per row.
  const failedIds: string[] = [];
  let firstError: unknown;
  for (const candidate of candidates) {
    try {
      const holding = await recoverStandaloneOrder(candidate.orderId);
      if (holding === "captured") result.recovered += 1;
      // A capture the handler refunded leaves the row PENDING; a live (authorized) payment may still capture.
      const expired =
        holding !== "live" &&
        now.getTime() - candidate.createdAt.getTime() > EXPIRE_AFTER_MS;
      if (await settleStillPending(candidate, expired)) result.expired += 1;
    } catch (error) {
      result.errors += 1;
      firstError ??= error;
      failedIds.push(candidate.id);
    }
  }
  if (failedIds.length > 0) {
    reportSentryError(firstError, {
      subsystem: "payments",
      op: "reconcile-standalone-purchases",
      fingerprint: ["reconcile-standalone-purchases"],
      extra: { failed: failedIds.length, sample: failedIds.slice(0, 10) },
    });
  }
  result.success = result.errors === 0;
  return result;
}

/** Fail-closed: the sweep settles captures and the auto-refunds they stage. */
export async function reconcileStandalonePurchases(
  opts: { limit?: number } = {},
): Promise<ReconcileStandalonePurchasesResult> {
  return withCronLock(
    "reconcile-standalone-purchases",
    { failMode: "closed" },
    () => reconcileUnlocked(opts.limit ?? DEFAULT_LIMIT),
  );
}

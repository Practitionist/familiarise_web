/**
 * Recover standalone sales (digital products and replays) whose capture never
 * reached us: a PENDING purchase older than 15 minutes, or a FAILED one under
 * 7 days old, is checked against its Razorpay order and a captured payment is
 * routed to its handler exactly as the webhook would. A PENDING order still
 * empty 24 hours after creation is marked FAILED; REFUNDED is never read.
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
/** A failed attempt's order can still capture a retry or a late authorisation. */
export const FAILED_RECOVERY_MS = 7 * 24 * 60 * 60_000;

type Rail = "digital" | "replay";
type RecoverableStatus = "PENDING" | "FAILED";
interface Candidate {
  rail: Rail;
  id: string;
  orderId: string;
  status: RecoverableStatus;
  createdAt: Date;
}

/** PENDING past the grace period, or FAILED inside the recovery window. */
function recoverableWhere(now: Date) {
  return {
    OR: [
      {
        status: "PENDING" as const,
        createdAt: { lt: new Date(now.getTime() - GRACE_MS) },
      },
      {
        status: "FAILED" as const,
        createdAt: { gt: new Date(now.getTime() - FAILED_RECOVERY_MS) },
      },
    ],
  };
}

async function recoverableCandidates(
  limit: number,
  now: Date,
): Promise<Candidate[]> {
  // Least recently checked first: every check stamps reconciledAt, so failures rotate too.
  const orderBy = [
    { reconciledAt: { sort: "asc" as const, nulls: "first" as const } },
    { createdAt: "asc" as const },
  ];
  const select = {
    id: true,
    gatewayOrderId: true,
    status: true,
    createdAt: true,
  } as const;
  const [digital, replay] = await Promise.all([
    prisma.digitalProductPurchase.findMany({
      where: { ...recoverableWhere(now), gatewayOrderId: { not: null } },
      orderBy,
      take: limit,
      select,
    }),
    prisma.recordingPurchase.findMany({
      where: recoverableWhere(now),
      orderBy,
      take: limit,
      select,
    }),
  ]);
  const candidates: Candidate[] = [];
  for (const row of digital) {
    if (row.gatewayOrderId && isRecoverable(row.status)) {
      candidates.push({
        rail: "digital",
        id: row.id,
        orderId: row.gatewayOrderId,
        status: row.status,
        createdAt: row.createdAt,
      });
    }
  }
  for (const row of replay) {
    if (isRecoverable(row.status)) {
      candidates.push({
        rail: "replay",
        id: row.id,
        orderId: row.gatewayOrderId,
        status: row.status,
        createdAt: row.createdAt,
      });
    }
  }
  return candidates;
}

function isRecoverable(status: string): status is RecoverableStatus {
  return status === "PENDING" || status === "FAILED";
}

/**
 * Stamp the check by CAS on the status it was read in, keeping the order and
 * createdAt; a PENDING row past 24 hours with nothing live moves to FAILED.
 */
async function markChecked(
  candidate: Candidate,
  now: Date,
  expire: boolean,
): Promise<boolean> {
  const where = { id: candidate.id, status: candidate.status };
  const data = expire
    ? { status: "FAILED" as const, reconciledAt: now }
    : { reconciledAt: now };
  const res =
    candidate.rail === "digital"
      ? await prisma.digitalProductPurchase.updateMany({ where, data })
      : await prisma.recordingPurchase.updateMany({ where, data });
  return expire && res.count === 1;
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
  const candidates = await recoverableCandidates(limit, now);
  result.scanned = candidates.length;

  // One Sentry event per run, never per row.
  const failedIds: string[] = [];
  let firstError: unknown;
  for (const candidate of candidates) {
    try {
      const holding = await recoverStandaloneOrder(candidate.orderId);
      if (holding === "captured") result.recovered += 1;
      // A capture the handler refunded leaves the row unsettled; a live (authorized) payment may still capture.
      const expire =
        candidate.status === "PENDING" &&
        holding !== "live" &&
        now.getTime() - candidate.createdAt.getTime() > EXPIRE_AFTER_MS;
      if (await markChecked(candidate, now, expire)) result.expired += 1;
    } catch (error) {
      result.errors += 1;
      firstError ??= error;
      failedIds.push(candidate.id);
      await markChecked(candidate, now, false).catch(() => false);
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

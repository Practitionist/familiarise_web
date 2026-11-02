/**
 * Recover standalone sales (digital products and replays) whose capture never
 * reached us: a PENDING purchase older than 15 minutes, or a FAILED one under
 * 7 days old, is checked against its Razorpay order and a captured payment is
 * routed to its handler exactly as the webhook would. PENDING and FAILED rows
 * have separate slices per rail, PENDING checked first. A PENDING order still
 * empty 24 hours after creation is marked FAILED; REFUNDED is never read. Then
 * receipts still owed on settled digital product purchases are staged.
 */
import prisma, { type PrismaLike } from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import {
  fetchRazorpayOrder,
  readRazorpayOrderHolding,
} from "@/lib/payments/core/razorpay";
import { routeCapturedPayment } from "@/app/api/webhooks/razorpay-dispatch";
import { reportSentryError } from "@/lib/observability/report";
import {
  owedReceiptWhere,
  stageOwedDigitalProductReceipts,
} from "@/lib/digital-products/purchase-email";

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
  /** Purchases a routed capture settled this run; a refunded re-route is not one. */
  recovered: number;
  /** Purchases marked FAILED after 24 hours with nothing captured for them. */
  expired: number;
  /** Owed digital product receipts staged (or deliberately skipped) this run. */
  receipts: number;
  errors: number;
  timestamp: string;
}

const DEFAULT_LIMIT = 5;
/** FAILED rows rarely capture late, so a smaller slice of their own never crowds out PENDING. */
const FAILED_LIMIT = 2;
const OWED_RECEIPT_LIMIT = 3;
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

/** Only a paid digital purchase has a gateway order to check. */
const paidOrderWhere = { gatewayOrderId: { not: null } };

function pendingWhere(now: Date) {
  return {
    status: "PENDING" as const,
    createdAt: { lt: new Date(now.getTime() - GRACE_MS) },
  };
}

function failedWhere(now: Date) {
  return {
    status: "FAILED" as const,
    createdAt: { gt: new Date(now.getTime() - FAILED_RECOVERY_MS) },
  };
}

/** True when either rail has a recoverable purchase or a receipt is still owed. */
export async function hasStandalonePurchaseWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  const select = { id: true } as const;
  if (outOfTime()) return true;
  const digital = await db.digitalProductPurchase.findFirst({
    where: {
      OR: [
        {
          AND: [paidOrderWhere, { OR: [pendingWhere(now), failedWhere(now)] }],
        },
        owedReceiptWhere(now),
      ],
    },
    select,
  });
  if (digital) return true;
  if (outOfTime()) return true;
  const replay = await db.recordingPurchase.findFirst({
    where: { OR: [pendingWhere(now), failedWhere(now)] },
    select,
  });
  return replay !== null;
}

async function recoverableCandidates(
  limit: number,
  now: Date,
): Promise<Candidate[]> {
  const pending = pendingWhere(now);
  const failed = failedWhere(now);
  const [pendingRows, failedRows] = await Promise.all([
    recoverableRows(pending, limit),
    recoverableRows(failed, FAILED_LIMIT),
  ]);
  return [...toCandidates(pendingRows), ...toCandidates(failedRows)];
}

/** One status's slice of both rails, least recently checked first so failures rotate. */
async function recoverableRows(
  where: { status: RecoverableStatus; createdAt: { lt: Date } | { gt: Date } },
  take: number,
) {
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
      where: { ...where, ...paidOrderWhere },
      orderBy,
      take,
      select,
    }),
    prisma.recordingPurchase.findMany({ where, orderBy, take, select }),
  ]);
  return { digital, replay };
}

function toCandidates({
  digital,
  replay,
}: Awaited<ReturnType<typeof recoverableRows>>): Candidate[] {
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

/** Whether the row reads SUCCEEDED after its capture was routed. */
async function isSettled(candidate: Candidate): Promise<boolean> {
  const select = { status: true } as const;
  const row =
    candidate.rail === "digital"
      ? await prisma.digitalProductPurchase.findUnique({
          where: { id: candidate.id },
          select,
        })
      : await prisma.recordingPurchase.findUnique({
          where: { id: candidate.id },
          select,
        });
  return row?.status === "SUCCEEDED";
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
    receipts: 0,
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
      if (holding === "captured" && (await isSettled(candidate))) {
        result.recovered += 1;
      }
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
  try {
    const owed = await stageOwedDigitalProductReceipts(OWED_RECEIPT_LIMIT, now);
    result.receipts = owed.handled;
    if (owed.failedIds.length > 0) {
      result.errors += owed.failedIds.length;
      firstError ??=
        owed.firstError ??
        new Error("Owed digital product receipt not prepared");
      failedIds.push(...owed.failedIds);
    }
  } catch (error) {
    result.errors += 1;
    firstError ??= error;
    failedIds.push("owed-receipts");
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

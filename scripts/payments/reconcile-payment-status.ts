/**
 * Payment Status Reconciliation - Core Logic
 *
 * Reconciles payment status with Razorpay.
 * Finds PENDING payments and queries gateways for actual status, and re-reads
 * orders we closed in the last 72 hours so a capture there is refunded.
 *
 * This catches cases where:
 * - Payment webhook was missed or delayed
 * - DB update failed after gateway processed payment
 * - Network timeout during payment confirmation
 *
 * This module exports the core reconciliation function.
 * It is imported by:
 * - jobs/reconcile-payment-status.ts (GitHub Actions)
 * - app/api/cleanup/reconcile-payment-status/route.ts (API endpoint)
 *
 * Schedule: Every 30 minutes
 */

import { PRE_MINT_INTENT_PREFIX } from "@/lib/payments/pre-mint-intent";
import {
  startDeadline,
  SWEEP_START_DEADLINE_MS,
} from "@/lib/cron/run-deadline";
import {
  compareLeastRecentlyReconciled,
  LEAST_RECENTLY_RECONCILED,
} from "@/lib/payments/payouts/reconcile-cursor";
import prisma, { type PrismaLike } from "../../lib/prisma";
import { PaymentStatus, PaymentGateway, Prisma } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { routeCapturedPayment } from "@/app/api/webhooks/razorpay-dispatch";
import { retireOrphanPendingPayment } from "./cleanup-abandoned-payments";
import { reverseCreditsForPayment } from "@/lib/referrals/service";
import { returnDiscountUse } from "@/lib/payments/checkout/discount-use";
import { reverseBookingUtilization } from "@/lib/api/organizations/program-helpers";
import {
  recordSystemErrorSafe,
  recordSystemEvent,
} from "@/lib/enterprise/system-events";
import { reportSentryMessage } from "@/lib/observability/report";
import { reportStandingFinding } from "@/lib/observability/standing-finding";
import { razorpayNotesSchema } from "@/schemas/webhooks/razorpay";
import { z } from "zod";

// Only reconcile payments older than 5 minutes (give webhooks time)
const MIN_AGE_MINUTES = 5;

// Don't reconcile payments older than 7 days
const MAX_AGE_DAYS = 7;

// A gateway read is not started with less budget than this left; the row stays unstamped and first.
const GATEWAY_READ_HEADROOM_MS = 3_000;

// #1757 — a PENDING row this old whose id the gateway does not know is retired,
// not re-reported every tick; younger ones may still be gateway lag.
const DEFAULT_ORPHAN_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// A row no sweep can read or cancel is stamped with the marker the orphan sweeps
// already exclude, so it leaves every cohort once instead of failing each run.
const MANUAL_RECOVERY_PREFIX = "REQUIRES_MANUAL_RECOVERY:";
const notManualRecoveryWhere = {
  OR: [
    { description: null },
    { NOT: { description: { startsWith: MANUAL_RECOVERY_PREFIX } } },
  ],
} satisfies Prisma.PaymentWhereInput;

const RAZORPAY_ORDER_PREFIX = "order_";

// Pre-mint rows belong to the approval pay-link sweep until their hold lapses,
// and blank intents have nothing to look up.
const reconcilableIntentWhere = {
  NOT: [
    { paymentIntent: "" },
    { paymentIntent: { startsWith: PRE_MINT_INTENT_PREFIX } },
  ],
} satisfies Prisma.PaymentWhereInput;

/** The stale-window cohort; shared with the ticker's idle probe. */
function stalePendingPaymentWhere(
  minAge: Date,
  maxAge: Date,
): Prisma.PaymentWhereInput {
  return {
    paymentStatus: PaymentStatus.PENDING,
    paymentGateway: PaymentGateway.RAZORPAY,
    createdAt: {
      lt: minAge,
      gte: maxAge,
    },
    AND: [reconcilableIntentWhere, notManualRecoveryWhere],
  };
}

// Razorpay late authorisation polls the bank for up to 3 days, so an order we closed is re-read that long.
const CLOSED_ORDER_REREAD_MS = 72 * 60 * 60 * 1000;
// An order past its 72 hours still gets one read after them, if it comes within this grace.
const CLOSED_ORDER_FINAL_READ_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Real gateway orders we closed (EXPIRED) with no capture recorded: closed in the last 72 hours, or past
 * them but not read since. `updatedAt` is never earlier than the close: every EXPIRED writer is a Prisma
 * write, and the poll stamp is raw SQL.
 */
function closedOrderSql(now: Date): Prisma.Sql {
  const horizon = new Date(now.getTime() - CLOSED_ORDER_REREAD_MS);
  const floor = new Date(horizon.getTime() - CLOSED_ORDER_FINAL_READ_GRACE_MS);
  return Prisma.sql`"paymentStatus" = 'EXPIRED'
    AND "paymentGateway" = 'RAZORPAY'
    AND starts_with("paymentIntent", ${RAZORPAY_ORDER_PREFIX})
    AND "capturedAt" IS NULL
    AND ("description" IS NULL OR NOT starts_with("description", ${MANUAL_RECOVERY_PREFIX}))
    AND "updatedAt" >= ${floor}
    AND (
      "updatedAt" >= ${horizon}
      OR "lastReconciledAt" IS NULL
      OR "lastReconciledAt" < "updatedAt" + make_interval(secs => ${CLOSED_ORDER_REREAD_MS / 1000})
    )`;
}

/** A superset of {@link closedOrderSql} for the idle probe. */
function closedOrderProbeWhere(now: Date): Prisma.PaymentWhereInput {
  return {
    paymentStatus: PaymentStatus.EXPIRED,
    paymentGateway: PaymentGateway.RAZORPAY,
    paymentIntent: { startsWith: RAZORPAY_ORDER_PREFIX },
    capturedAt: null,
    updatedAt: {
      gte: new Date(
        now.getTime() -
          CLOSED_ORDER_REREAD_MS -
          CLOSED_ORDER_FINAL_READ_GRACE_MS,
      ),
    },
    AND: [reconcilableIntentWhere, notManualRecoveryWhere],
  };
}

/**
 * Closed orders, first-come first-served: an order not read since its close queues at its close time,
 * one already read at its last read, so new closes never displace a repeat read.
 */
async function readClosedOrderCohort(now: Date, limit: number) {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Payment"
    WHERE ${closedOrderSql(now)}
    ORDER BY GREATEST("lastReconciledAt", "updatedAt") ASC, id ASC
    LIMIT ${limit}`;
  if (ids.length === 0) return [];
  const rows = await prisma.payment.findMany({
    where: { id: { in: ids.map((r) => r.id) } },
    include: {
      user: { select: { email: true, name: true } },
      appointment: { select: { id: true, appointmentType: true } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((r) => byId.get(r.id) ?? []);
}

/** Alternates the lists so each gets its share of `limit`, a list with fewer rows giving its share to the other. */
function interleave<T>(lists: T[][], limit: number): T[] {
  const out: T[] = [];
  for (let i = 0; out.length < limit; i++) {
    const round = lists.map((l) => l[i]).filter((x) => x !== undefined);
    if (round.length === 0) break;
    out.push(...round);
  }
  return out.slice(0, limit);
}

/** PENDING rows past the orphan age; shared with the ticker's idle probe. */
function orphanPendingCandidateWhere(
  orphanCutoff: Date,
): Prisma.PaymentWhereInput {
  return {
    paymentStatus: PaymentStatus.PENDING,
    createdAt: { lt: orphanCutoff },
    AND: [reconcilableIntentWhere, notManualRecoveryWhere],
  };
}

/** True when either cohort the run reads holds a payment. */
export async function hasPaymentStatusReconcileWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  const t = now.getTime();
  if (outOfTime()) return true;
  const row = await db.payment.findFirst({
    where: {
      OR: [
        stalePendingPaymentWhere(
          new Date(t - MIN_AGE_MINUTES * 60 * 1000),
          new Date(t - MAX_AGE_DAYS * 24 * 60 * 60 * 1000),
        ),
        orphanPendingCandidateWhere(
          new Date(t - DEFAULT_ORPHAN_PENDING_MAX_AGE_MS),
        ),
        closedOrderProbeWhere(now),
      ],
    },
    select: { id: true },
  });
  return row !== null;
}

export interface PaymentReconciliationResult {
  success: boolean;
  totalProcessed: number;
  reconciledCount: number;
  succeededCount: number;
  failedCount: number;
  expiredCount: number;
  skippedCount: number;
  /** #1708 — PENDING rows whose gateway id the gateway does not know. */
  unresolvableCount: number;
  unresolvable: string[];
  /** #1757 — unknown-id rows past the orphan age, retired PENDING → EXPIRED. */
  retiredCount: number;
  retired: string[];
  /** Rows on a gateway no sweep can read, stamped for manual recovery; not a run failure. */
  deadLettered: number;
  /** Closed orders read again at the gateway this run. */
  closedOrdersRead: number;
  /** Closed orders found captured and sent to the late-capture refund. */
  lateCaptures: string[];
  errors: string[];
  timestamp: string;
}

// #1708 — `unknown_id` (the gateway has no record of the id; terminal per row)
// is kept apart from `gateway_error` (unreachable, down or bad auth; retried).
type GatewayLookup =
  | {
      kind: "status";
      status: string;
      failureMessage?: string;
      paymentId?: string;
      /** `notes` off the captured payment — selects the handler in routeCapturedPayment. */
      notes?: Record<string, string>;
      /** Captured amount in paise, for the parity check. */
      amountPaise?: number;
    }
  | { kind: "unknown_id"; detail: string }
  | { kind: "gateway_error"; detail: string };

export interface ReconcilePaymentStatusOptions {
  /** Maximum candidates examined per run across both cohorts; defaults to 50. */
  limit?: number;
  startedAt?: number;
}

/**
 * Query Razorpay for order/payment status
 */
async function getRazorpayPaymentStatus(
  orderId: string,
  deadlineAt: number,
): Promise<GatewayLookup> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_SECRET;

  if (!keyId || !keySecret) {
    console.warn("Razorpay credentials not configured");
    return {
      kind: "gateway_error",
      detail: "Razorpay credentials not configured",
    };
  }

  try {
    // First get the order
    const orderResponse = await fetch(
      `https://api.razorpay.com/v1/orders/${orderId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
      },
    );

    if (!orderResponse.ok) {
      // Razorpay answers 400 BAD_REQUEST_ERROR, not 404, for an order id it
      // has no record of; 401/403 is our key, anything else is their side.
      const { status } = orderResponse;
      const description = await razorpayErrorDescription(orderResponse);
      if (status === 400 || status === 404) {
        return { kind: "unknown_id", detail: `${status} ${description}` };
      }
      console.error(`Razorpay order API error: ${status} ${description}`);
      return { kind: "gateway_error", detail: `${status} ${description}` };
    }

    const order = await orderResponse.json();

    // If order is paid, get the payment details
    if (order.status === "paid") {
      const paymentsResponse = await fetch(
        `https://api.razorpay.com/v1/orders/${orderId}/payments`,
        {
          method: "GET",
          headers: {
            Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
          },
          signal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
        },
      );

      if (paymentsResponse.ok) {
        const payments = await paymentsResponse.json();
        const capturedPayment = payments.items?.find(
          (p: { status: string }) => p.status === "captured",
        );
        if (capturedPayment) {
          return {
            kind: "status",
            status: "captured",
            paymentId: capturedPayment.id,
            notes: Object.fromEntries(
              Object.entries(capturedPayment.notes ?? {}).map(([k, v]) => [
                k,
                String(v),
              ]),
            ),
            amountPaise: Number(capturedPayment.amount),
          };
        }
      }
    }

    return { kind: "status", status: order.status };
  } catch (error) {
    console.error(`Failed to get Razorpay payment status: ${error}`);
    return {
      kind: "gateway_error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

const orderPaymentsSchema = z.object({
  items: z.array(
    z
      .object({
        id: z.string(),
        status: z.string(),
        amount: z.number().int().positive(),
        amount_refunded: z.number().int().nonnegative().optional(),
        notes: razorpayNotesSchema,
      })
      .passthrough(),
  ),
});

const paymentRefundsSchema = z.object({
  items: z.array(
    z
      .object({
        id: z.string(),
        amount: z.number().int().positive(),
        currency: z.string(),
        status: z.string(),
        notes: razorpayNotesSchema,
      })
      .passthrough(),
  ),
});

/** What a closed order holds at the gateway; an authorisation alone is left to Razorpay's own auto-refund. */
type ClosedOrderLookup =
  | {
      kind: "captured";
      paymentId: string;
      notes: Record<string, string>;
      amountPaise: number;
      /** Refunded at the gateway already, for example from the Razorpay dashboard. */
      refundedPaise: number;
    }
  | { kind: "authorized" }
  | { kind: "nothing" }
  | { kind: "gateway_error"; detail: string };

/** A Razorpay GET; `null` when the id is unknown (400 or 404). Throws when the gateway cannot answer. */
async function razorpayGet(path: string, deadlineAt: number): Promise<unknown> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("Razorpay credentials not configured");
  }
  const credentials = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const res = await fetch(`https://api.razorpay.com/v1/${path}`, {
    method: "GET",
    headers: { Authorization: `Basic ${credentials}` },
    signal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
  });
  if (res.ok) return res.json();
  const description = await razorpayErrorDescription(res);
  if (res.status === 400 || res.status === 404) return null;
  throw new Error(`${res.status} ${description}`);
}

/** GET /v1/orders/:id/payments for an order we closed; an id Razorpay does not know holds nothing. */
async function readClosedOrder(
  orderId: string,
  deadlineAt: number,
): Promise<ClosedOrderLookup> {
  try {
    const body = await razorpayGet(
      `orders/${encodeURIComponent(orderId)}/payments`,
      deadlineAt,
    );
    if (body === null) return { kind: "nothing" };
    const { items } = orderPaymentsSchema.parse(body);
    const captured = items.find((p) => p.status === "captured");
    if (captured) {
      return {
        kind: "captured",
        paymentId: captured.id,
        notes: captured.notes,
        amountPaise: captured.amount,
        refundedPaise: captured.amount_refunded ?? 0,
      };
    }
    return items.some((p) => p.status === "authorized")
      ? { kind: "authorized" }
      : { kind: "nothing" };
  } catch (error) {
    return {
      kind: "gateway_error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

// Captures these notes route to settle rows other than a booking's Payment; a closed order never carries them.
const NON_BOOKING_CAPTURE_TYPES: ReadonlySet<string> = new Set([
  "credit_purchase",
  "invoice_payment",
  "recording_purchase",
  "digital_product_purchase",
]);

/**
 * Records a closed booking order's capture and refunds what the gateway still holds. Refunds already made at
 * the gateway are recorded first by provider id, so only the rest is refunded. Returns false when another door
 * recorded the capture first; throws when a gateway refund could not be recorded or the refund failed.
 */
async function refundClosedOrderCapture(
  payment: { id: string; paymentIntent: string },
  held: Extract<ClosedOrderLookup, { kind: "captured" }>,
  deadlineAt: number,
): Promise<boolean> {
  // Dynamic, as Request again's re-check imports them: the capture handlers reach back into booking.
  const { handlePaymentSuccess, refundLateCapture, settleAutoRefundMarker } =
    await import("@/lib/payments/webhooks/handlers");
  const { handleRefundCreated, DeferSignal } =
    await import("@/app/api/webhooks/utils");
  const outcome = await handlePaymentSuccess(
    payment.paymentIntent,
    held.notes,
    held.amountPaise,
    held.paymentId,
    { deferLateCaptureRefund: true },
  );
  if (outcome !== "captured_after_release") return false;
  if (held.refundedPaise > 0) {
    const body = await razorpayGet(
      `payments/${encodeURIComponent(held.paymentId)}/refunds`,
      deadlineAt,
    );
    const { items } = paymentRefundsSchema.parse(body ?? { items: [] });
    for (const refund of items) {
      const recorded = await handleRefundCreated(
        refund.id,
        payment.paymentIntent,
        refund.amount,
        refund.currency,
        refund.status,
        held.paymentId,
        refund.notes,
      );
      if (recorded instanceof DeferSignal) throw new Error(recorded.reason);
    }
  }
  const owedPaise = held.amountPaise - held.refundedPaise;
  if (owedPaise > 0) {
    await refundLateCapture({
      paymentId: payment.id,
      amountPaise: owedPaise,
      releasedBy: `payment ${PaymentStatus.EXPIRED}`,
      gatewayPaymentId: held.paymentId,
      failureReportedByCaller: true,
    });
  } else {
    await settleAutoRefundMarker(payment.id);
  }
  return true;
}

/** Razorpay's error body is `{ error: { code, description } }`; tolerate anything else. */
async function razorpayErrorDescription(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: { code?: unknown; description?: unknown };
    };
    const code = body?.error?.code;
    const description = body?.error?.description;
    return [code, description]
      .filter((v): v is string => typeof v === "string")
      .join(": ");
  } catch {
    return "";
  }
}

/**
 * Map gateway payment status to our PaymentStatus
 */
function mapGatewayStatus(
  gateway: PaymentGateway,
  status: string,
): PaymentStatus | null {
  if (gateway === PaymentGateway.RAZORPAY) {
    switch (status) {
      case "paid":
      case "captured":
        return PaymentStatus.SUCCEEDED;
      case "created":
      case "attempted":
        return PaymentStatus.PENDING;
      case "expired":
        return PaymentStatus.EXPIRED;
      case "failed":
        return PaymentStatus.FAILED;
      default:
        return null;
    }
  }

  return null;
}

/**
 * Find and reconcile stale PENDING payments
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function reconcilePaymentStatus(
  opts: ReconcilePaymentStatusOptions = {},
): Promise<PaymentReconciliationResult> {
  return withCronLock(
    "reconcile-payment-status",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => reconcilePaymentStatusUnlocked(opts),
  );
}

async function reconcilePaymentStatusUnlocked(
  opts: ReconcilePaymentStatusOptions = {},
): Promise<PaymentReconciliationResult> {
  const startedAt = opts.startedAt ?? Date.now();
  const pastDeadline = startDeadline(startedAt);
  const limit = opts.limit ?? 50;
  const errors: string[] = [];
  let reconciledCount = 0;
  let succeededCount = 0;
  let failedCount = 0;
  let expiredCount = 0;
  let skippedCount = 0;
  let unresolvableCount = 0;
  const unresolvable: string[] = [];
  let retiredCount = 0;
  const retired: string[] = [];
  const deadLetteredIds: string[] = [];

  const minAge = new Date(Date.now() - MIN_AGE_MINUTES * 60 * 1000);
  const maxAge = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  const orphanCutoff = new Date(Date.now() - DEFAULT_ORPHAN_PENDING_MAX_AGE_MS);

  // Find stale PENDING payments
  const stalePendingPayments = await prisma.payment.findMany({
    where: stalePendingPaymentWhere(minAge, maxAge),
    include: {
      user: { select: { email: true, name: true } },
      appointment: { select: { id: true, appointmentType: true } },
    },
    orderBy: [LEAST_RECENTLY_RECONCILED, { id: "asc" }],
    take: limit,
  });

  // #1757 — the terminal cohort: PENDING rows older than the orphan age, which
  // the window above never reaches. Only an unknown-id answer acts on them.
  const orphanCandidates = await prisma.payment.findMany({
    where: orphanPendingCandidateWhere(orphanCutoff),
    include: {
      user: { select: { email: true, name: true } },
      appointment: { select: { id: true, appointmentType: true } },
    },
    orderBy: [LEAST_RECENTLY_RECONCILED, { id: "asc" }],
    take: limit,
  });
  const orphanCandidateIds = new Set(orphanCandidates.map((p) => p.id));

  // Orders we closed: a capture there after a lost webhook is found here and refunded.
  const closedOrders = await readClosedOrderCohort(new Date(), limit);
  const closedOrderIds = new Set(closedOrders.map((p) => p.id));

  const pendingCohort = [
    ...stalePendingPayments,
    ...orphanCandidates.filter(
      (p) => !stalePendingPayments.some((s) => s.id === p.id),
    ),
  ].sort(compareLeastRecentlyReconciled);
  // Pending work and closed orders share the limit half and half, so neither starves the other.
  const cohort = interleave(
    [
      pendingCohort,
      closedOrders.filter((p) => !pendingCohort.some((q) => q.id === p.id)),
    ],
    limit,
  );
  let closedOrdersRead = 0;
  const lateCaptures: string[] = [];
  const lateCaptureRefundFailures: string[] = [];
  let totalProcessed = 0;

  const razorpayConfigured = !!(
    process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_SECRET
  );
  if (!razorpayConfigured) {
    console.warn(
      "⚠️ Razorpay credentials not configured — Razorpay records will be skipped",
    );
  }

  console.log(
    `Found ${stalePendingPayments.length} stale PENDING payments to reconcile, ${orphanCandidates.length} orphan candidate(s) past the orphan age, ${closedOrders.length} closed order(s) to re-read`,
  );

  const gatewayDeadlineAt = startedAt + SWEEP_START_DEADLINE_MS;
  for (const payment of cohort) {
    if (pastDeadline()) break;
    const needsGatewayRead =
      payment.paymentGateway === PaymentGateway.RAZORPAY &&
      !!payment.paymentIntent &&
      razorpayConfigured;
    if (
      needsGatewayRead &&
      gatewayDeadlineAt - Date.now() < GATEWAY_READ_HEADROOM_MS
    ) {
      break;
    }
    totalProcessed++;
    try {
      // #1861 P4b — every key is written each row ("none" when unknown), so a
      // captured error never carries a previous row's ids.
      Sentry.getCurrentScope().setTags({
        paymentId: payment.id,
        appointmentId: payment.appointment?.id ?? "none",
        gatewayOrderId: payment.paymentIntent ?? "none",
      });
      console.log(`\nReconciling payment ${payment.id}`);
      console.log(`   Gateway: ${payment.paymentGateway}`);
      console.log(`   Payment Intent: ${payment.paymentIntent}`);
      console.log(`   User: ${payment.user?.name || "Unknown"}`);
      console.log(`   Created: ${payment.createdAt.toISOString()}`);

      // Skip if no payment intent
      if (!payment.paymentIntent) {
        console.log(`   Skipping - no payment intent`);
        skippedCount++;
        continue;
      }

      if (
        payment.paymentStatus === PaymentStatus.EXPIRED &&
        closedOrderIds.has(payment.id)
      ) {
        if (!razorpayConfigured) {
          skippedCount++;
          continue;
        }
        closedOrdersRead++;
        const held = await readClosedOrder(
          payment.paymentIntent,
          gatewayDeadlineAt,
        );
        if (held.kind === "gateway_error") {
          errors.push(
            `Payment ${payment.id}: Could not re-read closed order (${held.detail})`,
          );
          continue;
        }
        if (held.kind !== "captured") {
          console.log(`   Closed order holds ${held.kind} - nothing to do`);
          skippedCount++;
          continue;
        }
        const flow = held.notes.type;
        if (
          (flow && NON_BOOKING_CAPTURE_TYPES.has(flow)) ||
          (flow === "overage_member" && payment.parentPaymentId !== null)
        ) {
          errors.push(
            `Payment ${payment.id}: closed order ${payment.paymentIntent} holds a ${flow} capture no handler refunds here; refund by hand`,
          );
          continue;
        }
        try {
          if (flow === "overage_member") {
            // A replaced overage order's tombstone: its handler parks the capture and refunds it.
            await routeCapturedPayment({
              orderId: payment.paymentIntent,
              notes: held.notes,
              amountPaise: held.amountPaise,
              gatewayPaymentId: held.paymentId,
            });
            reconciledCount++;
          } else if (
            await refundClosedOrderCapture(payment, held, gatewayDeadlineAt)
          ) {
            lateCaptures.push(payment.id);
            reconciledCount++;
          } else {
            skippedCount++;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(
            `Payment ${payment.id}: late capture not refunded: ${msg}`,
          );
          lateCaptureRefundFailures.push(payment.id);
        }
        continue;
      }

      // Query gateway for actual status. Razorpay's `notes`/`amountPaise` ride
      // along so a SUCCEEDED reconcile can drive the confirmation pipeline
      // instead of writing the status (ADR 21).
      let lookup: GatewayLookup;

      if (payment.paymentGateway === PaymentGateway.RAZORPAY) {
        if (!razorpayConfigured) {
          console.log(`   Skipping - Razorpay credentials not configured`);
          skippedCount++;
          continue;
        }
        lookup = await getRazorpayPaymentStatus(
          payment.paymentIntent,
          gatewayDeadlineAt,
        );
      } else if (payment.paymentGateway !== PaymentGateway.STRIPE) {
        // Permanent: neither this sweep nor the retire path can read this gateway.
        const stamped = await prisma.payment.updateMany({
          where: {
            id: payment.id,
            paymentStatus: PaymentStatus.PENDING,
            ...notManualRecoveryWhere,
          },
          data: {
            description: `${MANUAL_RECOVERY_PREFIX} unsupported gateway ${payment.paymentGateway}; its state cannot be read or cancelled.${payment.description ? ` Was: ${payment.description}` : ""}`,
          },
        });
        if (stamped.count === 1) {
          deadLetteredIds.push(payment.id);
        } else {
          skippedCount++;
        }
        continue;
      } else if (payment.createdAt < orphanCutoff) {
        lookup = {
          kind: "unknown_id",
          detail: `unsupported legacy gateway ${payment.paymentGateway}`,
        };
      } else {
        console.log(
          `   Skipping - unsupported gateway: ${payment.paymentGateway}`,
        );
        skippedCount++;
        continue;
      }

      // #1708 — an id the gateway does not know is terminal for this row, not a
      // run failure. #1757 — past the orphan age it is retired through the
      // abandoned-payments unit (expire, credits, hold); younger rows are only
      // reported, since the gateway may still be lagging.
      if (lookup.kind === "unknown_id") {
        if (payment.createdAt < orphanCutoff) {
          try {
            const { outcome, errors: retireErrors } =
              await retireOrphanPendingPayment(payment.id);
            errors.push(...retireErrors);
            if (outcome === "retired") {
              console.warn(
                `   Gateway does not know ${payment.paymentIntent} (${lookup.detail}) - retired PENDING → EXPIRED`,
              );
              retiredCount++;
              retired.push(payment.id);
              await recordSystemEvent({
                category: "PAYMENT",
                severity: "WARN",
                message: `PAYMENT_ORPHAN_RETIRED: ${payment.id} (${payment.paymentGateway} ${payment.paymentIntent}): ${lookup.detail}`,
                context: {
                  paymentId: payment.id,
                  paymentGateway: payment.paymentGateway,
                  paymentIntent: payment.paymentIntent,
                  createdAt: payment.createdAt.toISOString(),
                },
              });
            } else {
              console.log(
                `   Skipped: payment ${payment.id} already transitioned by another writer`,
              );
              skippedCount++;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`   Retire failed for ${payment.id}: ${msg}`);
            errors.push(`Payment ${payment.id}: ${msg}`);
          }
          continue;
        }
        console.warn(
          `   Gateway does not know ${payment.paymentIntent} (${lookup.detail}) - reported, not retried as a failure`,
        );
        unresolvableCount++;
        unresolvable.push(payment.id);
        continue;
      }

      if (lookup.kind === "gateway_error") {
        console.log(`   Could not get status from gateway - skipping`);
        errors.push(
          `Payment ${payment.id}: Could not query gateway status (${lookup.detail})`,
        );
        skippedCount++;
        continue;
      }

      const gatewayStatus = lookup;

      // An orphan candidate the gateway does know is outside the reconcile
      // window above; it is left for that window's rules, not acted on here.
      if (
        orphanCandidateIds.has(payment.id) &&
        !stalePendingPayments.some((s) => s.id === payment.id)
      ) {
        console.log(
          `   Gateway knows the id (${gatewayStatus.status}) - outside the reconcile window, skipping`,
        );
        skippedCount++;
        continue;
      }

      console.log(`   Gateway status: ${gatewayStatus.status}`);

      // Map gateway status to our status
      const mappedStatus = mapGatewayStatus(
        payment.paymentGateway,
        gatewayStatus.status,
      );

      if (!mappedStatus) {
        console.log(`   Unknown gateway status - skipping`);
        skippedCount++;
        continue;
      }

      // Update if status changed
      if (mappedStatus !== payment.paymentStatus) {
        // SUCCEEDED goes through routeCapturedPayment, never a raw status write,
        // so confirmation, auto-refund guards, earnings and journaling all run.
        if (mappedStatus === PaymentStatus.SUCCEEDED) {
          const notes: Record<string, string> = {
            ...gatewayStatus.notes,
          };
          if (payment.appointment?.id) {
            if (!notes.userId && payment.userId) {
              notes.userId = payment.userId;
            }
            if (!notes.appointmentType && payment.appointment.appointmentType) {
              notes.appointmentType = payment.appointment.appointmentType;
            }
          }
          const isStandaloneFlow =
            notes.type === "credit_purchase" ||
            notes.type === "invoice_payment" ||
            notes.type === "overage_member" ||
            notes.type === "recording_purchase";
          if (
            !isStandaloneFlow &&
            !payment.appointment?.id &&
            !notes.appointmentType
          ) {
            const msg = `Cannot reconcile booking payment ${payment.id} to SUCCEEDED without linked appointment or creation notes`;
            console.error(`   ${msg}`);
            const missingCtxCorrelationId = `reconcile-missing-context:${payment.id}`;
            const alreadyReportedMissingCtx =
              typeof prisma.systemEvent?.findFirst === "function"
                ? await prisma.systemEvent
                    .findFirst({
                      where: {
                        correlationId: missingCtxCorrelationId,
                        createdAt: {
                          gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
                        },
                      },
                      select: { id: true },
                    })
                    .catch(() => null)
                : null;
            if (!alreadyReportedMissingCtx) {
              await recordSystemEvent({
                category: "PAYMENT",
                severity: "ERROR",
                message: `PAYMENT_RECONCILE_MISSING_BOOKING_CONTEXT: ${msg}`,
                correlationId: missingCtxCorrelationId,
                context: {
                  paymentId: payment.id,
                  paymentGateway: payment.paymentGateway,
                  paymentIntent: payment.paymentIntent,
                },
              });
            }
            errors.push(`Payment ${payment.id}: ${msg}`);
            continue;
          }
          try {
            await routeCapturedPayment({
              orderId: payment.paymentIntent,
              notes,
              amountPaise: gatewayStatus.amountPaise,
              gatewayPaymentId: gatewayStatus.paymentId,
            });
            console.log(`   Confirmed via pipeline: ${payment.id}`);
            reconciledCount++;
            succeededCount++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`   Pipeline failed for ${payment.id}: ${msg}`);
            errors.push(`Payment ${payment.id}: ${msg}`);
          }
          continue;
        }

        // #776 — guard on the status we read. A webhook can transition this
        // payment (e.g. PENDING→SUCCEEDED) between the findMany and here; without
        // the predicate the reconcile would clobber that real transition back to
        // EXPIRED/FAILED. updateMany lets us add the guard; count===0 means another
        // writer already moved it — skip rather than overwrite.
        // A failed give-back (an engagement counter that cannot absorb it) rolls this payment
        // back and is collected; the rest of the cohort still runs.
        let claimed: { count: number };
        try {
          claimed = await prisma.$transaction(async (tx) => {
            const res = await tx.payment.updateMany({
              where: { id: payment.id, paymentStatus: payment.paymentStatus },
              data: {
                paymentStatus: mappedStatus,
              },
            });
            if (
              res.count > 0 &&
              (mappedStatus === PaymentStatus.FAILED ||
                mappedStatus === PaymentStatus.EXPIRED)
            ) {
              await reverseCreditsForPayment(payment.id, tx);
              if (payment.paymentStatus === PaymentStatus.PENDING) {
                await returnDiscountUse(tx, payment.id);
                await reverseBookingUtilization(tx, {
                  paymentId: payment.id,
                  reason: `Gateway reports ${mappedStatus}`,
                });
              }
            }
            return res;
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`   Expiry failed for ${payment.id}: ${msg}`);
          errors.push(`Payment ${payment.id}: ${msg}`);
          continue;
        }

        if (claimed.count === 0) {
          console.log(
            `   Skipped: payment ${payment.id} already transitioned by another writer`,
          );
          skippedCount++;
          continue;
        }

        console.log(
          `   Updated status: ${payment.paymentStatus} → ${mappedStatus}`,
        );
        reconciledCount++;

        if (mappedStatus === PaymentStatus.EXPIRED) {
          expiredCount++;
        } else if (mappedStatus === PaymentStatus.FAILED) {
          failedCount++;
        }
      } else {
        console.log(`   Status unchanged (${mappedStatus})`);
      }
    } finally {
      try {
        // Attempted timeouts rotate too; an unstarted candidate never reaches this block.
        await prisma.$executeRaw`UPDATE "Payment" SET "lastReconciledAt" = now() WHERE id = ${payment.id}`;
      } catch (error) {
        errors.push(
          `Polling cursor Payment ${payment.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Summary
  console.log("\n📊 Payment Reconciliation Summary:");
  console.log(`   Total processed: ${cohort.length}`);
  console.log(`   Reconciled: ${reconciledCount}`);
  console.log(`   Succeeded (needs review): ${succeededCount}`);
  console.log(`   Failed: ${failedCount}`);
  console.log(`   Expired: ${expiredCount}`);
  console.log(`   Skipped: ${skippedCount}`);
  console.log(
    `   Unresolvable (gateway does not know the id): ${unresolvableCount}`,
  );
  console.log(`   Retired (orphan past the age cutoff): ${retiredCount}`);
  console.log(
    `   Dead-lettered (unsupported gateway): ${deadLetteredIds.length}`,
  );
  console.log(
    `   Closed orders re-read: ${closedOrdersRead}, late captures refunded: ${lateCaptures.length}`,
  );

  if (deadLetteredIds.length > 0) {
    await recordSystemErrorSafe({
      category: "PAYMENT",
      summary: `reconcile-payment-status: ${deadLetteredIds.length} PENDING payment(s) on an unsupported gateway stamped for manual recovery`,
      err: new Error("UNSUPPORTED_GATEWAY_DEAD_LETTERED"),
      context: { paymentIds: deadLetteredIds },
    });
  }

  // One report per run for late captures left unrefunded; `retry-auto-refunds` drives each marker.
  if (lateCaptureRefundFailures.length > 0) {
    reportSentryMessage(
      `reconcile-payment-status: ${lateCaptureRefundFailures.length} late capture(s) on closed orders not refunded`,
      {
        subsystem: "payments",
        op: "reconcile-payment-status",
        level: "error",
        extra: { paymentIds: lateCaptureRefundFailures },
      },
    );
  }

  // One expected warning per run listing the ids, never one per row (#1757).
  if (retiredCount > 0) {
    reportSentryMessage(
      `reconcile-payment-status: retired ${retiredCount} orphan PENDING payment(s) the gateway does not know`,
      {
        subsystem: "payments",
        op: "reconcile-payment-status",
        expected: true,
        level: "warning",
        extra: { retired },
      },
    );
  }

  // The stuck ids come from a moving cohort, so dedupe on ids already
  // reported inside the window, not on the exact set. `expected: "true"` is
  // the tag the pager rule filters on.
  if (unresolvableCount > 0) {
    const message = `reconcile-payment-status: ${unresolvableCount} pending payments have gateway ids the gateway does not know`;
    await reportStandingFinding(
      {
        key: "reconcile-payment-status:unresolvable",
        ids: unresolvable,
        message,
      },
      () =>
        Sentry.captureMessage(message, {
          level: "warning",
          fingerprint: ["reconcile-payment-status", "unresolvable"],
          tags: { subsystem: "payments", expected: "true" },
          extra: { unresolvable },
        }),
    );
  }

  if (succeededCount > 0) {
    console.log(
      `\n⚠️ WARNING: ${succeededCount} payments were found to have succeeded!`,
    );
    console.log("   These may need manual appointment creation.");
  }

  return {
    success: errors.length === 0,
    totalProcessed,
    reconciledCount,
    succeededCount,
    failedCount,
    expiredCount,
    skippedCount,
    unresolvableCount,
    unresolvable,
    retiredCount,
    retired,
    deadLettered: deadLetteredIds.length,
    closedOrdersRead,
    lateCaptures,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

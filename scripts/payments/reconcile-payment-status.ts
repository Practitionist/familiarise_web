/**
 * Payment Status Reconciliation - Core Logic
 *
 * Reconciles payment status with payment gateways (Stripe/Razorpay).
 * Finds PENDING payments and queries gateways for actual status.
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

import { createHash } from "node:crypto";
import prisma from "../../lib/prisma";
import { PaymentStatus, PaymentGateway } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { routeCapturedPayment } from "@/app/api/webhooks/razorpay-dispatch";
import { retireOrphanPendingPayment } from "./cleanup-abandoned-payments";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import { reportSentryMessage } from "@/lib/observability/report";

// #1822 — Q-4: the same stuck ids re-fire this warning every tick until the
// row resolves or ages into #1757's retire path. Dedupe by a hash of the id
// set via SystemEvent.correlationId instead of a Redis key — Redis is the
// scarce resource this fix exists to protect.
const UNRESOLVABLE_REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

function unresolvableCorrelationId(ids: string[]): string {
  const hash = createHash("sha256")
    // Code-unit order, not localeCompare: a dedupe key must not vary by collation.
    .update([...ids].sort((a, b) => Number(a > b) - Number(a < b)).join(","))
    .digest("hex")
    .slice(0, 16);
  return `reconcile-payment-status:unresolvable:${hash}`;
}

// Only reconcile payments older than 5 minutes (give webhooks time)
const MIN_AGE_MINUTES = 5;

// Don't reconcile payments older than 7 days
const MAX_AGE_DAYS = 7;

// #1757 — a PENDING row this old whose id the gateway does not know is retired,
// not re-reported every tick; younger ones may still be gateway lag.
const DEFAULT_ORPHAN_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function orphanPendingMaxAgeMs(): number {
  const raw = Number(process.env.RECONCILE_ORPHAN_PENDING_MAX_AGE_MS);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_ORPHAN_PENDING_MAX_AGE_MS;
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

// Matched on the error's own fields, not `instanceof` against the lazily
// imported SDK — the same posture as cleanup-abandoned-payments (#1464).
function isStripeUnknownId(error: unknown): boolean {
  const e = error as { code?: unknown; statusCode?: unknown } | null;
  return e?.code === "resource_missing" || e?.statusCode === 404;
}

export interface ReconcilePaymentStatusOptions {
  /** #1356 — caps the batch for the Netlify ticker; undefined keeps the
   * unbounded GitHub Actions behaviour. */
  limit?: number;
}

/**
 * Query Stripe for payment intent status
 */
async function getStripePaymentStatus(
  paymentIntent: string,
): Promise<GatewayLookup> {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    console.warn("Stripe credentials not configured");
    return {
      kind: "gateway_error",
      detail: "Stripe credentials not configured",
    };
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(stripeSecretKey);

    // Checkout-flow payments store the cs_ session id as the payment ref
    // (the cancel path in lib/payments/core/stripe.ts handles the same
    // split). Passing a cs_ id to paymentIntents.retrieve throws "No such
    // payment_intent", which used to poison every run with the same two
    // stale rows. Resolve the session to its intent; a session that never
    // produced one maps on its own state — expired → canceled (the row
    // finally EXPIREs), open → processing (Stripe auto-expires within 24h,
    // the next sweep settles it).
    if (paymentIntent.startsWith("cs_")) {
      const session = await stripe.checkout.sessions.retrieve(paymentIntent);
      const intentRef = session.payment_intent;
      if (!intentRef) {
        return {
          kind: "status",
          status: session.status === "expired" ? "canceled" : "processing",
        };
      }
      const pi =
        typeof intentRef === "string"
          ? await stripe.paymentIntents.retrieve(intentRef)
          : intentRef;
      return {
        kind: "status",
        status: pi.status,
        failureMessage: pi.last_payment_error?.message ?? undefined,
      };
    }

    const pi = await stripe.paymentIntents.retrieve(paymentIntent);
    return {
      kind: "status",
      status: pi.status,
      failureMessage: pi.last_payment_error?.message,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (isStripeUnknownId(error)) {
      return { kind: "unknown_id", detail };
    }
    console.error(`Failed to get Stripe payment status: ${error}`);
    return { kind: "gateway_error", detail };
  }
}

/**
 * Query Razorpay for order/payment status
 */
async function getRazorpayPaymentStatus(
  orderId: string,
): Promise<GatewayLookup> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  // #677 PM-1 — prod env defines RAZORPAY_SECRET (the canonical name the
  // core lib reads); reading only RAZORPAY_KEY_SECRET silently disabled
  // this reconciliation in production while it looked green.
  const keySecret =
    process.env.RAZORPAY_SECRET ?? process.env.RAZORPAY_KEY_SECRET;

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
  if (gateway === PaymentGateway.STRIPE) {
    switch (status) {
      case "succeeded":
        return PaymentStatus.SUCCEEDED;
      case "processing":
        return PaymentStatus.PENDING;
      case "requires_payment_method":
        return PaymentStatus.FAILED;
      case "requires_confirmation":
        return PaymentStatus.PENDING;
      case "requires_action":
        return PaymentStatus.PENDING;
      case "canceled":
        return PaymentStatus.EXPIRED;
      default:
        return null;
    }
  } else if (gateway === PaymentGateway.RAZORPAY) {
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

  const minAge = new Date(Date.now() - MIN_AGE_MINUTES * 60 * 1000);
  const maxAge = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  const orphanCutoff = new Date(Date.now() - orphanPendingMaxAgeMs());

  // Find stale PENDING payments
  const stalePendingPayments = await prisma.payment.findMany({
    where: {
      paymentStatus: PaymentStatus.PENDING,
      createdAt: {
        lt: minAge,
        gte: maxAge,
      },
      // Only payments with gateway reference - not an empty string
      NOT: {
        paymentIntent: "",
      },
    },
    include: {
      user: { select: { email: true, name: true } },
      appointment: { select: { id: true } },
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit,
  });

  // #1757 — the terminal cohort: PENDING rows older than the orphan age, which
  // the window above never reaches. Only an unknown-id answer acts on them.
  const orphanCandidates = await prisma.payment.findMany({
    where: {
      paymentStatus: PaymentStatus.PENDING,
      createdAt: { lt: orphanCutoff },
      paymentGateway: { in: [PaymentGateway.STRIPE, PaymentGateway.RAZORPAY] },
      NOT: { paymentIntent: "" },
    },
    include: {
      user: { select: { email: true, name: true } },
      appointment: { select: { id: true } },
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit,
  });
  const orphanCandidateIds = new Set(orphanCandidates.map((p) => p.id));
  const cohort = [
    ...stalePendingPayments,
    ...orphanCandidates.filter(
      (p) => !stalePendingPayments.some((s) => s.id === p.id),
    ),
  ];

  const razorpayConfigured = !!(
    process.env.RAZORPAY_KEY_ID &&
    (process.env.RAZORPAY_SECRET ?? process.env.RAZORPAY_KEY_SECRET)
  );
  if (!razorpayConfigured) {
    console.warn(
      "⚠️ Razorpay credentials not configured — Razorpay records will be skipped",
    );
  }

  console.log(
    `Found ${stalePendingPayments.length} stale PENDING payments to reconcile, ${orphanCandidates.length} orphan candidate(s) past the orphan age`,
  );

  for (const payment of cohort) {
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

    // Query gateway for actual status. Razorpay's `notes`/`amountPaise` ride
    // along so a SUCCEEDED reconcile can drive the confirmation pipeline
    // instead of writing the status (ADR 21).
    let lookup: GatewayLookup;

    if (payment.paymentGateway === PaymentGateway.STRIPE) {
      lookup = await getStripePaymentStatus(payment.paymentIntent);
    } else if (payment.paymentGateway === PaymentGateway.RAZORPAY) {
      if (!razorpayConfigured) {
        console.log(`   Skipping - Razorpay credentials not configured`);
        skippedCount++;
        continue;
      }
      // For Razorpay, paymentIntent might be orderId
      lookup = await getRazorpayPaymentStatus(payment.paymentIntent);
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
      // ADR 21 — a payment that reconciles to SUCCEEDED must go through the
      // confirmation pipeline, not a status write.
      //
      // This job exists precisely because a `payment.captured` was missed, so
      // it is the LEAST safe place to write the status directly: setting
      // SUCCEEDED here poisons handlePaymentSuccess's already-SUCCEEDED guard,
      // and Razorpay's redelivery (it retries for 24h) then no-ops. The legacy
      // appointment-creation path and all three auto-refund guards
      // (amount-mismatch, captured-after-terminal, double-booking-loser) are
      // skipped permanently — and none of those are covered by another cron.
      // The old code even logged "may need manual appointment creation!"
      // instead of just creating it.
      // Razorpay only: routeCapturedPayment is the Razorpay dispatch's router,
      // and Stripe successes are confirmed by their own webhook handler. A
      // Stripe row still takes the CAS below, which is the pre-existing
      // behaviour for that gateway.
      if (
        mappedStatus === PaymentStatus.SUCCEEDED &&
        payment.paymentGateway === PaymentGateway.RAZORPAY
      ) {
        try {
          await routeCapturedPayment({
            orderId: payment.paymentIntent,
            notes: gatewayStatus.notes ?? {},
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
      const claimed = await prisma.payment.updateMany({
        where: { id: payment.id, paymentStatus: payment.paymentStatus },
        data: {
          paymentStatus: mappedStatus,
        },
      });

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

  // One issue that counts up, not one event per row per tick.
  // FAMILIARISE_WEB-4P — recurrence means new orphans, not a new defect, so
  // the pager must exclude it: `expected: "true"` (same tag convention as
  // reportSentryError) is the stable key the alert rule filters on. The
  // signal stays in logs/Sentry; only the page goes away.
  //
  // #1822 Q-4 — that de-duplication was by ISSUE, not by EVENT: the same
  // stuck row set still minted a fresh Sentry event (and burned budget) on
  // every run until it aged into #1757's retire path. Report at most once
  // per 24h per distinct id set, tracked via a SystemEvent correlationId.
  if (unresolvableCount > 0) {
    const correlationId = unresolvableCorrelationId(unresolvable);
    const alreadyReportedToday = await prisma.systemEvent.findFirst({
      where: {
        correlationId,
        createdAt: {
          gte: new Date(Date.now() - UNRESOLVABLE_REPORT_WINDOW_MS),
        },
      },
      select: { id: true },
    });

    if (!alreadyReportedToday) {
      await recordSystemEvent({
        category: "CRON",
        severity: "WARN",
        message: `reconcile-payment-status: ${unresolvableCount} pending payments have gateway ids the gateway does not know`,
        context: { unresolvable },
        correlationId,
      });
      Sentry.captureMessage(
        `reconcile-payment-status: ${unresolvableCount} pending payments have gateway ids the gateway does not know`,
        {
          level: "warning",
          fingerprint: ["reconcile-payment-status", "unresolvable"],
          tags: { subsystem: "payments", expected: "true" },
          extra: { unresolvable },
        },
      );
    }
  }

  if (succeededCount > 0) {
    console.log(
      `\n⚠️ WARNING: ${succeededCount} payments were found to have succeeded!`,
    );
    console.log("   These may need manual appointment creation.");
  }

  return {
    success: errors.length === 0,
    totalProcessed: cohort.length,
    reconciledCount,
    succeededCount,
    failedCount,
    expiredCount,
    skippedCount,
    unresolvableCount,
    unresolvable,
    retiredCount,
    retired,
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

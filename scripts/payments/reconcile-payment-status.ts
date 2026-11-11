/**
 * Payment Status Reconciliation - Core Logic
 *
 * Reconciles payment status with Razorpay.
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
import {
  recordSystemErrorSafe,
  recordSystemEvent,
} from "@/lib/enterprise/system-events";
import { reportSentryMessage } from "@/lib/observability/report";
import { reportStandingFinding } from "@/lib/observability/standing-finding";

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
  const cohort = [
    ...stalePendingPayments,
    ...orphanCandidates.filter(
      (p) => !stalePendingPayments.some((s) => s.id === p.id),
    ),
  ]
    .sort(compareLeastRecentlyReconciled)
    .slice(0, limit);
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
    `Found ${stalePendingPayments.length} stale PENDING payments to reconcile, ${orphanCandidates.length} orphan candidate(s) past the orphan age`,
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
        const claimed = await prisma.$transaction(async (tx) => {
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
            }
          }
          return res;
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

  if (deadLetteredIds.length > 0) {
    await recordSystemErrorSafe({
      category: "PAYMENT",
      summary: `reconcile-payment-status: ${deadLetteredIds.length} PENDING payment(s) on an unsupported gateway stamped for manual recovery`,
      err: new Error("UNSUPPORTED_GATEWAY_DEAD_LETTERED"),
      context: { paymentIds: deadLetteredIds },
    });
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
    errors,
    timestamp: new Date().toISOString(),
  };
}

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import crypto from "node:crypto";
import {
  handlePaymentFailure,
  handlePaymentSuccess,
  handleOrgPaymentSuccess,
  handleOrgPaymentFailure,
  handleRefundCreated,
  handleDisputeCreated,
  handleDisputeUpdated,
  verifyWebhookSignature,
  logWebhookEvent,
  markWebhookEventProcessed,
  handleRazorpayPayoutWebhook,
  isDbHealthy,
} from "../utils";
import { scrubWebhookPayload } from "@/lib/logging/webhook-scrub";
import {
  razorpayWebhookEnvelopeSchema,
  razorpayPaymentCapturedEventSchema,
  razorpayPaymentFailedEventSchema,
  razorpayOrderPaidEventSchema,
  type RazorpayWebhookEnvelope,
} from "../../../../schemas/webhooks/razorpay";
import { z } from "zod";

// Strict inner-entity schemas used to narrow optional envelope fields at
// the point of consumption (one per event family we actually process).
const refundEntitySchema = z.object({
  id: z.string(),
  payment_id: z.string(),
  amount: z.number(),
  currency: z.string().optional(),
  status: z.string(),
});

const disputeEntitySchema = z.object({
  id: z.string(),
  payment_id: z.string(),
  amount: z.number(),
  currency: z.string().optional(),
  reason_code: z.string().optional(),
  reason_description: z.string().optional(),
  status: z.string(),
  respond_by: z.number().nullable().optional(),
  deduct_at_onset: z.boolean().optional(),
});

const disputeUpdateEntitySchema = z.object({
  id: z.string(),
  status: z.string(),
});

const payoutEntitySchema = z.object({
  id: z.string(),
  status: z.string(),
  failure_reason: z.string().nullable().optional(),
});
import { razorpayClient } from "@/lib/payments/core/razorpay";

export async function POST(req: NextRequest) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("RAZORPAY_WEBHOOK_SECRET not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  // M2 FIX: RazorpayX payout webhooks may use a separate secret.
  // Try the main Razorpay secret first. If that fails and a RazorpayX secret
  // is configured, re-verify with it (for payout.* events).
  const razorpayXSecret = process.env.RAZORPAYX_WEBHOOK_SECRET;

  const { isValid, body } = await verifyWebhookSignature(
    req,
    secret,
    "razorpay",
  );

  if (!isValid) {
    // M2 FIX: Only allow RazorpayX secret fallback for payout.* events.
    // Parse the body to check event type before re-verifying — this prevents
    // non-payout events from being accepted with the RazorpayX secret.
    let isPossiblyPayoutEvent = false;
    try {
      const parsed = JSON.parse(body);
      isPossiblyPayoutEvent =
        typeof parsed.event === "string" &&
        parsed.event.startsWith("payout.");
    } catch {
      // Can't parse — not a valid webhook, reject
    }

    if (
      isPossiblyPayoutEvent &&
      razorpayXSecret &&
      razorpayXSecret !== secret
    ) {
      const signature = req.headers.get("x-razorpay-signature");
      if (signature) {
        const crypto = await import("crypto");
        const expectedSig = crypto
          .createHmac("sha256", razorpayXSecret)
          .update(body)
          .digest("hex");
        const sigBuf = Buffer.from(signature, "hex");
        const expectedBuf = Buffer.from(expectedSig, "hex");
        const isRazorpayXValid =
          sigBuf.length === expectedBuf.length &&
          crypto.timingSafeEqual(sigBuf, expectedBuf);

        if (!isRazorpayXValid) {
          return NextResponse.json(
            { error: "Invalid signature" },
            { status: 400 },
          );
        }
        // RazorpayX signature valid for payout event — continue processing
      } else {
        return NextResponse.json(
          { error: "Invalid signature" },
          { status: 400 },
        );
      }
    } else {
      return NextResponse.json(
        { error: "Invalid signature" },
        { status: 400 },
      );
    }
  }

  // DB health check — return 503 if DB is unreachable so Razorpay retries
  if (!(await isDbHealthy())) {
    console.warn(
      "[razorpay webhook] DB unhealthy — returning 503 for Razorpay retry",
    );
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 503 },
    );
  }

  // M3 FIX: Parse, log, and idempotency-check synchronously (fast path),
  // then return 200 immediately and process the event asynchronously via
  // Next.js `after()` to stay within Razorpay's 5-second webhook timeout.

  let event: RazorpayWebhookEnvelope;
  let eventType: string;

  try {
    const rawJson: unknown = JSON.parse(body);
    event = razorpayWebhookEnvelopeSchema.parse(rawJson);
    eventType = event.event;
  } catch (parseError) {
    console.error("Razorpay webhook parse error:", parseError);
    return NextResponse.json(
      { error: "Invalid webhook payload" },
      { status: 400 },
    );
  }

  // Composite key prevents collisions between different lifecycle events
  // for the same entity (e.g., payment.captured vs refund.created).
  // When no entity is present (malformed payload) we fall back to a
  // SHA-256 hash of the raw body so the eventId stays deterministic —
  // two identical replayed bodies collapse to the same id, which is what
  // we want for dedup.
  const entityId =
    event.payload?.payment?.entity?.id ||
    event.payload?.order?.entity?.id ||
    event.payload?.refund?.entity?.id ||
    event.payload?.dispute?.entity?.id ||
    event.payload?.payout?.entity?.id ||
    event.account_id ||
    `body_${crypto.createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
  const eventId = `${eventType}:${entityId}`;

  // Idempotency check (synchronous — must complete before returning 200)
  const { isNew } = await logWebhookEvent(
    "razorpay",
    eventId,
    eventType,
    event.payload,
    req.headers.get("x-razorpay-signature") || undefined,
  );

  if (!isNew) {
    console.log(`⚠️ Duplicate webhook event ${eventId}, returning OK`);
    return NextResponse.json({ status: "ok", duplicate: true });
  }

  // Return 200 immediately — process the event asynchronously
  after(async () => {
    await processWebhookEvent(event, eventType, eventId);
  });

  return NextResponse.json({ status: "ok" });
}

/**
 * Process a webhook event asynchronously (called via next/server `after()`).
 * Errors here are logged and recorded on the webhook event record for retry.
 */
async function processWebhookEvent(
  event: RazorpayWebhookEnvelope,
  eventType: string,
  eventId: string,
): Promise<void> {
  // PII-scrub the payload before logging — Razorpay payloads can carry
  // payer email/phone/contact, partial card/UPI fingerprints, and any
  // `notes.*` fields the app populated (referrerEmail etc). See
  // lib/logging/webhook-scrub.ts for the redaction rules.
  console.log(`🔔 Razorpay Webhook Event: ${eventType}`, {
    eventId,
    payload: scrubWebhookPayload(event.payload),
  });

  let processingError: string | undefined;

  try {
    switch (eventType) {
      case "payment.captured": {
        const capturedEvent = razorpayPaymentCapturedEventSchema.parse(event);
        const capturedNotes = capturedEvent.payload.payment.entity.notes ?? {};
        if (
          capturedNotes.type === "credit_purchase" ||
          capturedNotes.type === "invoice_payment"
        ) {
          await handleOrgPaymentSuccess(
            capturedNotes,
            capturedEvent.payload.payment.entity.id,
            capturedEvent.payload.payment.entity.amount,
          );
        } else {
          await handlePaymentSuccess(
            capturedEvent.payload.payment.entity.order_id,
            capturedNotes,
          );
        }
        break;
      }

      case "order.paid": {
        const paidEvent = razorpayOrderPaidEventSchema.parse(event);
        const paidNotes = paidEvent.payload.order.entity.notes ?? {};
        if (
          paidNotes.type === "credit_purchase" ||
          paidNotes.type === "invoice_payment"
        ) {
          await handleOrgPaymentSuccess(paidNotes);
        } else {
          await handlePaymentSuccess(
            paidEvent.payload.order.entity.id,
            paidNotes,
          );
        }
        break;
      }

      case "payment.failed": {
        const failedEvent = razorpayPaymentFailedEventSchema.parse(event);
        const failedEntity = failedEvent.payload.payment.entity;
        const failedNotes = failedEntity.notes ?? {};
        // Org-level top-ups and invoice payments do NOT have a `Payment`
        // row (they live on WalletEntry / OrganizationInvoice), so the
        // legacy handlePaymentFailure would silently no-op for them.
        // Route by notes.type first; fall back to the B2C path.
        if (
          failedNotes.type === "credit_purchase" ||
          failedNotes.type === "invoice_payment"
        ) {
          await handleOrgPaymentFailure(failedNotes, failedEntity.id);
        } else {
          await handlePaymentFailure(failedEntity.order_id);
        }
        break;
      }

      // Refund events
      // FIX #5: Razorpay refunds use payment_id, but our DB stores order_id as
      // paymentIntent. Resolve payment_id → order_id via Razorpay API first.
      case "refund.created":
      case "refund.processed": {
        const refundEvent = refundEntitySchema.parse(
          event.payload?.refund?.entity,
        );
        let paymentIntentId = refundEvent.payment_id;

        if (razorpayClient) {
          try {
            const rzpPayment = await razorpayClient.payments.fetch(
              refundEvent.payment_id,
            );
            if (rzpPayment.order_id) {
              paymentIntentId = rzpPayment.order_id;
            }
          } catch (lookupError) {
            console.error(
              `Failed to resolve Razorpay payment_id ${refundEvent.payment_id} to order_id:`,
              lookupError,
            );
          }
        }

        await handleRefundCreated(
          refundEvent.id,
          paymentIntentId,
          refundEvent.amount,
          refundEvent.currency || "INR",
          refundEvent.status,
          "RAZORPAY",
          refundEvent.payment_id,
        );
        break;
      }

      case "refund.failed": {
        const failedRefundEvent = refundEntitySchema.parse(
          event.payload?.refund?.entity,
        );
        let failedPaymentIntentId = failedRefundEvent.payment_id;

        if (razorpayClient) {
          try {
            const rzpPayment = await razorpayClient.payments.fetch(
              failedRefundEvent.payment_id,
            );
            if (rzpPayment.order_id) {
              failedPaymentIntentId = rzpPayment.order_id;
            }
          } catch (lookupError) {
            console.error(
              `Failed to resolve Razorpay payment_id ${failedRefundEvent.payment_id} to order_id:`,
              lookupError,
            );
          }
        }

        await handleRefundCreated(
          failedRefundEvent.id,
          failedPaymentIntentId,
          failedRefundEvent.amount,
          failedRefundEvent.currency || "INR",
          "failed",
          "RAZORPAY",
          failedRefundEvent.payment_id,
        );
        break;
      }

      // L1 FIX: Handle refund.speed_changed (informational only)
      case "refund.speed_changed": {
        console.log(
          `📄 Refund speed changed: ${event.payload?.refund?.entity?.id}`,
        );
        break;
      }

      // Dispute events
      case "payment.dispute.created": {
        const disputeCreatedEvent = disputeEntitySchema.parse(
          event.payload?.dispute?.entity,
        );
        await handleDisputeCreated(
          disputeCreatedEvent.id,
          disputeCreatedEvent.payment_id,
          disputeCreatedEvent.amount,
          disputeCreatedEvent.currency || "INR",
          disputeCreatedEvent.reason_description ||
            disputeCreatedEvent.reason_code ||
            "unknown",
          disputeCreatedEvent.status,
          disputeCreatedEvent.respond_by ?? null,
          disputeCreatedEvent.deduct_at_onset === false,
          "RAZORPAY",
        );
        break;
      }

      case "payment.dispute.won": {
        const disputeWonEvent = disputeUpdateEntitySchema.parse(
          event.payload?.dispute?.entity,
        );
        await handleDisputeUpdated(disputeWonEvent.id, "won", null);
        break;
      }

      case "payment.dispute.lost": {
        const disputeLostEvent = disputeUpdateEntitySchema.parse(
          event.payload?.dispute?.entity,
        );
        await handleDisputeUpdated(disputeLostEvent.id, "lost", null);
        break;
      }

      case "payment.dispute.closed": {
        const disputeClosedEvent = disputeUpdateEntitySchema.parse(
          event.payload?.dispute?.entity,
        );
        await handleDisputeUpdated(
          disputeClosedEvent.id,
          disputeClosedEvent.status,
          null,
        );
        break;
      }

      // RazorpayX Payout events
      case "payout.processed":
      case "payout.reversed":
      case "payout.rejected":
      case "payout.queued":
      case "payout.pending":
      case "payout.cancelled": {
        const payoutEvent = payoutEntitySchema.parse(
          event.payload?.payout?.entity,
        );
        await handleRazorpayPayoutWebhook(eventType, {
          id: payoutEvent.id,
          status: payoutEvent.status,
          failure_reason: payoutEvent.failure_reason ?? undefined,
        });
        break;
      }

      default:
        console.log(`📄 Unhandled Razorpay event type: ${eventType}`);
    }
  } catch (handlerError) {
    processingError =
      handlerError instanceof Error
        ? handlerError.message
        : String(handlerError);
    console.error(`Razorpay webhook processing error for ${eventId}:`, handlerError);
  } finally {
    await markWebhookEventProcessed(eventId, processingError);
  }
}

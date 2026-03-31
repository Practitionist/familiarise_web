import { NextRequest, NextResponse } from "next/server";
import {
  handlePaymentFailure,
  handlePaymentSuccess,
  handleRefundCreated,
  handleDisputeCreated,
  handleDisputeUpdated,
  verifyWebhookSignature,
  logWebhookEvent,
  markWebhookEventProcessed,
  handleRazorpayPayoutWebhook,
  isDbHealthy,
} from "../utils";
import {
  razorpayBaseEventSchema,
  razorpayPaymentCapturedEventSchema,
  razorpayPaymentFailedEventSchema,
  razorpayOrderPaidEventSchema,
} from "../../../../schemas/webhooks/razorpay";
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

  const { isValid, body } = await verifyWebhookSignature(
    req,
    secret,
    "razorpay",
  );
  if (!isValid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
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

  try {
    const event = JSON.parse(body);
    const { event: eventType } = razorpayBaseEventSchema.parse(event);

    // Log webhook event for audit trail (idempotency check).
    // Use composite key (eventType + entityId) to prevent collisions between
    // different lifecycle events for the same entity (e.g., payment.captured
    // vs refund.created both referencing the same payment ID).
    const entityId =
      event.payload?.payment?.entity?.id ||
      event.payload?.order?.entity?.id ||
      event.payload?.refund?.entity?.id ||
      event.payload?.dispute?.entity?.id ||
      event.payload?.payout?.entity?.id ||
      event.account_id ||
      "unknown";
    const eventId = `${eventType}:${entityId}`;

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

    console.log(`🔔 Razorpay Webhook Event: ${eventType}`, {
      payload: event.payload,
    });

    let processingError: string | undefined;

    try {
      switch (eventType) {
        case "payment.captured": {
          const capturedEvent = razorpayPaymentCapturedEventSchema.parse(event);
          await handlePaymentSuccess(
            capturedEvent.payload.payment.entity.order_id,
            capturedEvent.payload.payment.entity.notes || {},
          );
          break;
        }

        case "order.paid": {
          const paidEvent = razorpayOrderPaidEventSchema.parse(event);
          await handlePaymentSuccess(
            paidEvent.payload.order.entity.id,
            paidEvent.payload.order.entity.notes || {},
          );
          break;
        }

        case "payment.failed": {
          const failedEvent = razorpayPaymentFailedEventSchema.parse(event);
          await handlePaymentFailure(
            failedEvent.payload.payment.entity.order_id,
          );
          break;
        }

        // Refund events
        // FIX #5: Razorpay refunds use payment_id, but our DB stores order_id as
        // paymentIntent. Resolve payment_id → order_id via Razorpay API first.
        case "refund.created":
        case "refund.processed": {
          const refundEvent = event.payload.refund.entity;
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
          );
          break;
        }

        case "refund.failed": {
          const failedRefundEvent = event.payload.refund.entity;
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
          );
          break;
        }

        // Dispute events
        case "payment.dispute.created": {
          const disputeCreatedEvent = event.payload.dispute.entity;
          await handleDisputeCreated(
            disputeCreatedEvent.id,
            disputeCreatedEvent.payment_id,
            disputeCreatedEvent.amount,
            disputeCreatedEvent.currency || "INR",
            disputeCreatedEvent.reason_description ||
              disputeCreatedEvent.reason_code,
            disputeCreatedEvent.status,
            disputeCreatedEvent.respond_by || null,
            disputeCreatedEvent.deduct_at_onset === false,
            "RAZORPAY",
          );
          break;
        }

        case "payment.dispute.won": {
          const disputeWonEvent = event.payload.dispute.entity;
          await handleDisputeUpdated(disputeWonEvent.id, "won", null);
          break;
        }

        case "payment.dispute.lost": {
          const disputeLostEvent = event.payload.dispute.entity;
          await handleDisputeUpdated(disputeLostEvent.id, "lost", null);
          break;
        }

        case "payment.dispute.closed": {
          const disputeClosedEvent = event.payload.dispute.entity;
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
          const payoutEvent = event.payload.payout.entity;
          await handleRazorpayPayoutWebhook(eventType, {
            id: payoutEvent.id,
            status: payoutEvent.status,
            failure_reason: payoutEvent.failure_reason,
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
      throw handlerError;
    } finally {
      // Mark event as processed
      await markWebhookEventProcessed(eventId, processingError);
    }

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("Razorpay webhook error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }
}

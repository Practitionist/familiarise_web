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
  handleStripePayoutWebhook,
  isDbHealthy,
} from "../utils";
import {
  stripeBaseEventSchema,
  stripePaymentIntentSucceededEventSchema,
  stripePaymentIntentFailedEventSchema,
  stripeCheckoutSessionCompletedEventSchema,
  stripeCheckoutSessionExpiredEventSchema,
} from "../../../../schemas/webhooks/stripe";

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  const { isValid, body } = await verifyWebhookSignature(req, secret, "stripe");
  if (!isValid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // DB health check — return 503 if DB is unreachable so Stripe retries
  if (!(await isDbHealthy())) {
    console.warn(
      "[stripe webhook] DB unhealthy — returning 503 for Stripe retry",
    );
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 503 },
    );
  }

  try {
    const event = JSON.parse(body);
    const { type: eventType } = stripeBaseEventSchema.parse(event);

    // Log webhook event for audit trail (idempotency check)
    const eventId = event.id || `stripe_${Date.now()}`;

    const { isNew } = await logWebhookEvent(
      "stripe",
      eventId,
      eventType,
      event.data.object,
      req.headers.get("stripe-signature") || undefined,
    );

    if (!isNew) {
      console.log(`⚠️ Duplicate webhook event ${eventId}, returning OK`);
      return NextResponse.json({ status: "ok", duplicate: true });
    }

    console.log(`🔔 Stripe Webhook Event: ${eventType}`, {
      payload: event.data.object,
    });

    let processingError: string | undefined;

    try {
      switch (eventType) {
        // FIX CF-3: Checkout Session events — primary handler for Stripe Checkout flow.
        // createStripeCheckoutSession stores session.id (cs_...) in Payment.paymentIntent,
        // so we must handle checkout.session.completed to match by cs_... ID.
        // NOTE: Ensure these events are enabled in the Stripe Dashboard webhook settings.
        case "checkout.session.completed": {
          const sessionEvent =
            stripeCheckoutSessionCompletedEventSchema.parse(event);
          const session = sessionEvent.data.object;
          // Use session.id (cs_...) which matches Payment.paymentIntent
          await handlePaymentSuccess(
            session.id,
            session.metadata || {},
          );
          break;
        }

        case "checkout.session.expired": {
          const sessionEvent =
            stripeCheckoutSessionExpiredEventSchema.parse(event);
          await handlePaymentFailure(sessionEvent.data.object.id);
          break;
        }

        // Payment Intent events — kept for backward compatibility.
        // If a payment was stored with pi_... (legacy flow), this handler catches it.
        // Idempotency: handlePaymentSuccess is a no-op if already SUCCEEDED.
        case "payment_intent.succeeded": {
          const succeededEvent =
            stripePaymentIntentSucceededEventSchema.parse(event);
          await handlePaymentSuccess(
            succeededEvent.data.object.id,
            succeededEvent.data.object.metadata || {},
          );
          break;
        }

        case "payment_intent.payment_failed": {
          const failedEvent = stripePaymentIntentFailedEventSchema.parse(event);
          await handlePaymentFailure(failedEvent.data.object.id);
          break;
        }

        // Refund events
        case "charge.refunded": {
          const refundEvent = event.data.object;
          // Stripe includes refunds array in the charge object
          if (refundEvent.refunds && refundEvent.refunds.data.length > 0) {
            const latestRefund = refundEvent.refunds.data[0];
            await handleRefundCreated(
              latestRefund.id,
              refundEvent.payment_intent || refundEvent.id,
              latestRefund.amount,
              latestRefund.currency.toUpperCase(),
              latestRefund.status,
              "STRIPE",
            );
          }
          break;
        }

        // Dispute events
        case "charge.dispute.created": {
          const disputeCreatedEvent = event.data.object;
          await handleDisputeCreated(
            disputeCreatedEvent.id,
            disputeCreatedEvent.charge,
            disputeCreatedEvent.amount,
            disputeCreatedEvent.currency.toUpperCase(),
            disputeCreatedEvent.reason,
            disputeCreatedEvent.status,
            disputeCreatedEvent.evidence_details?.due_by || null,
            disputeCreatedEvent.is_charge_refundable,
            "STRIPE",
          );
          break;
        }

        case "charge.dispute.updated": {
          const disputeUpdatedEvent = event.data.object;
          await handleDisputeUpdated(
            disputeUpdatedEvent.id,
            disputeUpdatedEvent.status,
            disputeUpdatedEvent.evidence || null,
          );
          break;
        }

        case "charge.dispute.closed": {
          const disputeClosedEvent = event.data.object;
          await handleDisputeUpdated(
            disputeClosedEvent.id,
            disputeClosedEvent.status,
            null,
          );
          break;
        }

        // Stripe Connect Payout/Transfer events
        case "payout.created":
        case "payout.paid":
        case "payout.failed":
        case "payout.canceled": {
          const payoutEvent = event.data.object;
          await handleStripePayoutWebhook(eventType, {
            id: payoutEvent.id,
            status: payoutEvent.status,
            failure_code: payoutEvent.failure_code,
            failure_message: payoutEvent.failure_message,
          });
          break;
        }

        // Stripe Connect Account events
        case "account.updated": {
          const accountEvent = event.data.object;
          console.log(`📄 Stripe Connect account updated: ${accountEvent.id}`, {
            chargesEnabled: accountEvent.charges_enabled,
            payoutsEnabled: accountEvent.payouts_enabled,
            detailsSubmitted: accountEvent.details_submitted,
          });
          // TODO: Update PayoutAccount status in database if needed
          break;
        }

        // Transfer events (platform to connected account)
        case "transfer.created":
        case "transfer.reversed": {
          const transferEvent = event.data.object;
          console.log(`📄 Stripe transfer ${eventType}: ${transferEvent.id}`, {
            amount: transferEvent.amount,
            destination: transferEvent.destination,
            reversed: transferEvent.reversed,
          });
          break;
        }

        default:
          console.log(`📄 Unhandled Stripe event type: ${eventType}`);
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
    console.error("Stripe webhook error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }
}

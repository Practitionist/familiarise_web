import { NextRequest, NextResponse } from "next/server";
import {
  handlePaymentFailure,
  handlePaymentSuccess,
  handleRefundCreated,
  handleDisputeCreated,
  handleDisputeUpdated,
  verifyWebhookSignature,
} from "../utils";
import {
  stripeBaseEventSchema,
  stripePaymentIntentSucceededEventSchema,
  stripePaymentIntentFailedEventSchema,
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

  try {
    const event = JSON.parse(body);
    const { type: eventType } = stripeBaseEventSchema.parse(event);

    console.log(`🔔 Stripe Webhook Event: ${eventType}`, {
      payload: event.data.object,
    });

    switch (eventType) {
      // Payment events
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

      default:
        console.log(`📄 Unhandled Stripe event type: ${eventType}`);
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

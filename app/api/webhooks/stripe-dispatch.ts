import * as Sentry from "@sentry/nextjs";
import { ZodError } from "zod";
import {
  handlePaymentFailure,
  handleRefundCreated,
  handleDisputeCreated,
  handleDisputeUpdated,
  markWebhookEventProcessed,
  handleStripePayoutWebhook,
} from "./utils";
import {
  stripeAccountObjectSchema,
  stripeAccountUpdatedEventSchema,
  stripeChargeRefundedEventSchema,
  stripeChargeRefundedObjectSchema,
  stripeCheckoutSessionCompletedEventSchema,
  stripeCheckoutSessionCompletedObjectSchema,
  stripeCheckoutSessionExpiredEventSchema,
  stripeCheckoutSessionObjectSchema,
  stripeDisputeCreatedEventSchema,
  stripeDisputeCreatedObjectSchema,
  stripeDisputeUpdatedEventSchema,
  stripeDisputeUpdatedObjectSchema,
  stripePaymentIntentFailedEventSchema,
  stripePaymentIntentObjectSchema,
  stripePaymentIntentSucceededEventSchema,
  stripePayoutEventSchema,
  stripePayoutObjectSchema,
  stripeTransferEventSchema,
  stripeTransferObjectSchema,
} from "../../../schemas/webhooks/stripe";
import { type WebhookClaim, permanentFailure } from "@/lib/webhooks/event-log";
import { routeCapturedPayment } from "./razorpay-dispatch";

/**
 * The captured amount in paise (the rail is INR-only). Throws (-> 500 ->
 * Stripe redelivers) rather than confirm a booking without a known captured amount.
 */
function requireAmountReceived(pi: {
  id: string;
  amount_received?: number | null;
}): number {
  const amount = pi.amount_received;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
    throw new Error(
      `Stripe amount_received missing or non-integer on payment_intent.succeeded ${pi.id}; refusing to confirm a booking without a known captured amount`,
    );
  }
  return amount;
}

export async function dispatchStripeEventByType(
  eventType: string,
  eventOrObject: unknown,
  isEnvelope: boolean,
): Promise<void> {
  switch (eventType) {
    // FIX CF-3: Checkout Session events — primary handler for Stripe Checkout flow.
    // createStripeCheckoutSession stores session.id (cs_...) in Payment.paymentIntent,
    // so we must handle checkout.session.completed to match by cs_... ID.
    // NOTE: Ensure these events are enabled in the Stripe Dashboard webhook settings.
    case "checkout.session.completed": {
      const session = isEnvelope
        ? stripeCheckoutSessionCompletedEventSchema.parse(eventOrObject).data
            .object
        : stripeCheckoutSessionCompletedObjectSchema.parse(eventOrObject);
      // session.id (cs_...) matches Payment.paymentIntent; `payment_intent`
      // (pi_...) is what refund/dispute webhooks resolve against. Only `paid`
      // collects money; anything else stays PENDING (200: no re-fire).
      if (session.payment_status !== "paid") {
        console.warn(
          `⚠️ Stripe checkout.session.completed ${session.id}: payment_status="${session.payment_status}" is not "paid" — NOT confirming a booking (no money collected); the Payment row stays PENDING for reconcile-payment-status, or cleanup-abandoned-payments releases the hold if the money never lands`,
        );
        break;
      }
      // No amount: `amount_total` is the order total, not a captured
      // amount, so the parity check is skipped on this door.
      await routeCapturedPayment({
        orderId: session.id,
        notes: session.metadata || {},
        gatewayPaymentId: session.payment_intent ?? undefined,
      });
      break;
    }

    case "checkout.session.expired": {
      const session = isEnvelope
        ? stripeCheckoutSessionExpiredEventSchema.parse(eventOrObject).data
            .object
        : stripeCheckoutSessionObjectSchema.parse(eventOrObject);
      await handlePaymentFailure(session.id);
      break;
    }

    // Payment Intent events — kept for backward compatibility.
    // If a payment was stored with pi_... (legacy flow), this handler catches it.
    // routeCapturedPayment no-ops on SUCCEEDED only while the redelivered
    // amount still matches; a mismatch trips the parity check.
    case "payment_intent.succeeded": {
      const pi = isEnvelope
        ? stripePaymentIntentSucceededEventSchema.parse(eventOrObject).data
            .object
        : stripePaymentIntentObjectSchema.parse(eventOrObject);
      await routeCapturedPayment({
        orderId: pi.id,
        notes: pi.metadata || {},
        // `amount_received` is what Stripe actually took, which is NOT
        // `pi.amount` (the authorised figure) on a partial capture.
        amountPaise: requireAmountReceived(pi),
        // A PaymentIntent is both the order and the charge-bearing object
        // on this rail, so its id is both keys.
        gatewayPaymentId: pi.id,
      });
      break;
    }

    case "payment_intent.payment_failed": {
      const pi = isEnvelope
        ? stripePaymentIntentFailedEventSchema.parse(eventOrObject).data.object
        : stripePaymentIntentObjectSchema.parse(eventOrObject);
      await handlePaymentFailure(pi.id);
      break;
    }

    // Refund events
    case "charge.refunded": {
      const refundEvent = isEnvelope
        ? stripeChargeRefundedEventSchema.parse(eventOrObject).data.object
        : stripeChargeRefundedObjectSchema.parse(eventOrObject);
      // Stripe includes the refunds array in the charge object, newest
      // first. Drive EVERY refund in the array, not just data[0]: with
      // two refunds on one charge and delayed/out-of-order delivery,
      // both events resolved data[0] to the newer refund and refund #1
      // never got a row or a cascade. handleRefundCreated is idempotent
      // per gateway refund id (unique + terminal-status guard), so
      // re-processing an already-booked entry is a no-op.
      const refunds = refundEvent.refunds?.data ?? [];
      for (const latestRefund of refunds) {
        await handleRefundCreated(
          latestRefund.id,
          refundEvent.payment_intent || refundEvent.id,
          latestRefund.amount,
          latestRefund.currency.toUpperCase(),
          latestRefund.status ?? "pending",
          "STRIPE",
          typeof latestRefund.charge === "string"
            ? latestRefund.charge
            : (latestRefund.charge?.id ?? refundEvent.id),
        );
      }
      break;
    }

    // Dispute events
    case "charge.dispute.created": {
      const disputeCreatedEvent = isEnvelope
        ? stripeDisputeCreatedEventSchema.parse(eventOrObject).data.object
        : stripeDisputeCreatedObjectSchema.parse(eventOrObject);
      await handleDisputeCreated(
        disputeCreatedEvent.id,
        disputeCreatedEvent.charge,
        disputeCreatedEvent.amount,
        disputeCreatedEvent.currency.toUpperCase(),
        disputeCreatedEvent.reason,
        disputeCreatedEvent.status,
        disputeCreatedEvent.evidence_details?.due_by || null,
        disputeCreatedEvent.is_charge_refundable ?? false,
        "STRIPE",
      );
      break;
    }

    case "charge.dispute.updated": {
      const disputeUpdatedEvent = isEnvelope
        ? stripeDisputeUpdatedEventSchema.parse(eventOrObject).data.object
        : stripeDisputeUpdatedObjectSchema.parse(eventOrObject);
      await handleDisputeUpdated(
        disputeUpdatedEvent.id,
        disputeUpdatedEvent.status,
        (disputeUpdatedEvent.evidence as Record<string, unknown> | null) || null,
      );
      break;
    }

    case "charge.dispute.closed": {
      const disputeClosedEvent = isEnvelope
        ? stripeDisputeUpdatedEventSchema.parse(eventOrObject).data.object
        : stripeDisputeUpdatedObjectSchema.parse(eventOrObject);
      await handleDisputeUpdated(
        disputeClosedEvent.id,
        disputeClosedEvent.status,
        null,
      );
      break;
    }

    case "payout.created":
    case "payout.paid":
    case "payout.failed":
    case "payout.canceled": {
      if (process.env.ENABLE_STRIPE_PAYOUTS !== "true") {
        console.log(
          `⏭️  Stripe Connect payout event ${eventType} ignored (ENABLE_STRIPE_PAYOUTS!=true)`,
        );
        break;
      }
      const payoutEvent = isEnvelope
        ? stripePayoutEventSchema.parse(eventOrObject).data.object
        : stripePayoutObjectSchema.parse(eventOrObject);
      await handleStripePayoutWebhook(eventType, {
        id: payoutEvent.id,
        status: payoutEvent.status,
        failure_code: payoutEvent.failure_code ?? undefined,
        failure_message: payoutEvent.failure_message ?? undefined,
      });
      break;
    }

    case "account.updated": {
      if (process.env.ENABLE_STRIPE_PAYOUTS !== "true") break;
      const accountEvent = isEnvelope
        ? stripeAccountUpdatedEventSchema.parse(eventOrObject).data.object
        : stripeAccountObjectSchema.parse(eventOrObject);
      console.log(`📄 Stripe Connect account updated: ${accountEvent.id}`, {
        chargesEnabled: accountEvent.charges_enabled,
        payoutsEnabled: accountEvent.payouts_enabled,
        detailsSubmitted: accountEvent.details_submitted,
      });
      break;
    }

    case "transfer.created":
    case "transfer.reversed": {
      if (process.env.ENABLE_STRIPE_PAYOUTS !== "true") break;
      const transferEvent = isEnvelope
        ? stripeTransferEventSchema.parse(eventOrObject).data.object
        : stripeTransferObjectSchema.parse(eventOrObject);
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
}

/**
 * Re-drive a stored `WebhookEvent` row (`provider = "stripe"`) from
 * `scripts/cleanup/sweep-stuck-webhook-events.ts`. `WebhookEvent.payload`
 * stores `event.data.object`.
 */
export async function processStripeWebhookEvent(
  payloadObject: unknown,
  eventType: string,
  eventId: string,
  claim?: WebhookClaim,
): Promise<void> {
  let processingError: string | undefined;
  try {
    await dispatchStripeEventByType(eventType, payloadObject, false);
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    processingError =
      err instanceof ZodError ? permanentFailure(rawMsg) : rawMsg;
    Sentry.captureException(err, {
      tags: { subsystem: "payments", provider: "stripe" },
      contexts: { webhook: { eventType, eventId } },
    });
  } finally {
    await markWebhookEventProcessed(eventId, processingError, claim);
  }
}

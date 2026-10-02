import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
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
import { scrubWebhookPayload } from "@/lib/logging/webhook-scrub";
import { MAX_WEBHOOK_BODY_BYTES } from "@/lib/webhooks/read-body";
import {
  stripeAccountObjectSchema,
  stripeAccountUpdatedEventSchema,
  stripeBaseEventSchema,
  stripeChargeRefundedEventSchema,
  stripeChargeRefundedObjectSchema,
  stripeCheckoutSessionCompletedEventSchema,
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
} from "../../../../schemas/webhooks/stripe";
import { type WebhookClaim, permanentFailure } from "@/lib/webhooks/event-log";
import { ZodError } from "zod";

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
        : stripeCheckoutSessionObjectSchema.parse(eventOrObject);
      await handlePaymentSuccess(session.id, session.metadata || {});
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
    // Idempotency: handlePaymentSuccess is a no-op if already SUCCEEDED.
    case "payment_intent.succeeded": {
      const pi = isEnvelope
        ? stripePaymentIntentSucceededEventSchema.parse(eventOrObject).data
            .object
        : stripePaymentIntentObjectSchema.parse(eventOrObject);
      await handlePaymentSuccess(pi.id, pi.metadata || {});
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

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  Sentry.setTag("subsystem", "payments");
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  // #1582 F-P1-01a — same two-layer cap as the Razorpay route: an honest
  // Content-Length is refused unread; a missing or understated one is caught
  // by readBodyWithinCap inside verifyWebhookSignature.
  const declaredBytes = Number(req.headers.get("content-length"));
  if (
    Number.isFinite(declaredBytes) &&
    declaredBytes > MAX_WEBHOOK_BODY_BYTES
  ) {
    console.warn(
      `Rejected oversized Stripe webhook body: ${declaredBytes} bytes`,
    );
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const { isValid, body, oversized } = await verifyWebhookSignature(
    req,
    secret,
    "stripe",
  );
  if (oversized) {
    console.warn(
      `Rejected oversized Stripe webhook body: over ${MAX_WEBHOOK_BODY_BYTES} bytes`,
    );
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  if (!isValid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // DB health check — return 503 if DB is unreachable so Stripe retries
  if (!(await isDbHealthy())) {
    Sentry.logger.warn("stripe webhook: db unhealthy, returning 503");
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 503 },
    );
  }

  try {
    const event = JSON.parse(body);
    // A validly-signed but structurally-invalid payload is a BAD REQUEST, not
    // a server error: returning 500 makes Stripe burn its full exponential
    // retry schedule on an event that can never succeed and eventually
    // disables the endpoint — the exact failure mode the Razorpay route
    // avoids by reserving non-2xx for transient failures.
    let eventType: string;
    try {
      eventType = stripeBaseEventSchema.parse(event).type;
    } catch (parseError) {
      console.error(
        "Stripe webhook payload failed envelope validation:",
        parseError,
      );
      Sentry.captureException(parseError, {
        tags: { subsystem: "payments", provider: "stripe" },
      });
      return NextResponse.json(
        { error: "Unrecognized webhook payload shape" },
        { status: 400 },
      );
    }

    // #1861 P4b — IDs only. `event.data.object.id` is Stripe's own id for
    // whatever this event is about (a PaymentIntent or a Checkout Session,
    // both of which Payment.paymentIntent stores); the internal Payment.id/
    // appointmentId are not known until dispatch resolves them.
    const gatewayOrderId = event.data?.object?.id;
    if (typeof gatewayOrderId === "string") {
      Sentry.getCurrentScope().setTag("gatewayOrderId", gatewayOrderId);
    }

    // Log webhook event for audit trail (idempotency check).
    // Stripe always sends a unique `evt_...` id, but if it's missing we
    // derive a deterministic fallback from the body hash so replays
    // still dedup.
    const eventId =
      event.id ||
      `stripe_body_${crypto.createHash("sha256").update(body).digest("hex").slice(0, 16)}`;

    const { isNew, claim } = await logWebhookEvent(
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

    Sentry.logger.info(Sentry.logger.fmt`stripe webhook: ${eventType}`, {
      eventId,
    });

    // PII-scrub the payload before logging — Stripe payloads can carry
    // `receipt_email`, `billing_details.name/email/phone`, and arbitrary
    // `metadata.*` fields set by the application. See
    // lib/logging/webhook-scrub.ts for the redaction rules.
    console.log(`🔔 Stripe Webhook Event: ${eventType}`, {
      eventId,
      payload: scrubWebhookPayload(event.data.object),
    });

    let processingError: string | undefined;

    try {
      await dispatchStripeEventByType(eventType, event, true);
    } catch (handlerError) {
      const rawMessage =
        handlerError instanceof Error
          ? handlerError.message
          : String(handlerError);
      processingError =
        handlerError instanceof ZodError
          ? permanentFailure(rawMessage)
          : rawMessage;
      Sentry.captureException(handlerError, {
        tags: { subsystem: "payments", provider: "stripe" },
        contexts: { webhook: { eventType, eventId } },
      });
      if (handlerError instanceof ZodError) {
        return NextResponse.json(
          { error: "Invalid webhook payload" },
          { status: 400 },
        );
      }
      throw handlerError;
    } finally {
      // Mark event as processed
      await markWebhookEventProcessed(eventId, processingError, claim);
    }

    return NextResponse.json({ status: "ok" });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    Sentry.captureException(error, {
      tags: { subsystem: "payments", provider: "stripe" },
    });
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }
}

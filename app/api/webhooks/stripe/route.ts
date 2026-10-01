import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  handlePaymentFailure,
  handleRefundCreated,
  handleDisputeCreated,
  handleDisputeUpdated,
  verifyWebhookSignature,
  logWebhookEvent,
  markWebhookEventProcessed,
  handleStripePayoutWebhook,
  isDbHealthy,
} from "../utils";
import { routeCapturedPayment } from "../razorpay-dispatch";
import { scrubWebhookPayload } from "@/lib/logging/webhook-scrub";
import { MAX_WEBHOOK_BODY_BYTES } from "@/lib/webhooks/read-body";
import {
  stripeBaseEventSchema,
  stripePaymentIntentSucceededEventSchema,
  stripePaymentIntentFailedEventSchema,
  stripeCheckoutSessionCompletedEventSchema,
  stripeCheckoutSessionExpiredEventSchema,
} from "../../../../schemas/webhooks/stripe";

/**
 * The captured amount (paise; the rail is INR-only) off the RAW event, since
 * zod strips fields the schema does not model. Throws (-> 500 -> Stripe
 * redelivers) rather than confirm a booking without a known captured amount.
 */
function requireCapturedAmountPaise(
  raw: unknown,
  field: string,
  source: string,
): number {
  const amount = (raw as Record<string, unknown> | null | undefined)?.[field];
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
    throw new Error(
      `Stripe ${field} missing or non-integer on ${source}; refusing to confirm a booking without a known captured amount`,
    );
  }
  return amount;
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
      switch (eventType) {
        // FIX CF-3: Checkout Session events — primary handler for Stripe Checkout flow.
        // createStripeCheckoutSession stores session.id (cs_...) in Payment.paymentIntent,
        // so we must handle checkout.session.completed to match by cs_... ID.
        // NOTE: Ensure these events are enabled in the Stripe Dashboard webhook settings.
        // Routed through the same router as every other capture door (#ADR-21).
        case "checkout.session.completed": {
          const sessionEvent =
            stripeCheckoutSessionCompletedEventSchema.parse(event);
          const session = sessionEvent.data.object;
          // Use session.id (cs_...) which matches Payment.paymentIntent.
          // `payment_intent` (pi_...) is this rail's `pay_…`: the object the
          // refund/dispute webhooks can be resolved against.
          //
          // Only `paid` collects money; anything else (async method in flight,
          // unfinished 3DS, unknown value) stays PENDING for
          // reconcile-payment-status / cleanup-abandoned-payments. 200, not 500:
          // Stripe will not re-fire a completed session.
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
          const sessionEvent =
            stripeCheckoutSessionExpiredEventSchema.parse(event);
          await handlePaymentFailure(sessionEvent.data.object.id);
          break;
        }

        // Payment Intent events — kept for backward compatibility.
        // If a payment was stored with pi_... (legacy flow), this handler catches it.
        // Idempotency: routeCapturedPayment is a no-op if already SUCCEEDED
        // AND the redelivered amount still matches what we booked — a redelivery
        // whose amount does not match now trips the parity check instead of
        // being waved through by that short-circuit.
        case "payment_intent.succeeded": {
          const succeededEvent =
            stripePaymentIntentSucceededEventSchema.parse(event);
          const intent = succeededEvent.data.object;
          await routeCapturedPayment({
            orderId: intent.id,
            notes: intent.metadata || {},
            // `amount_received` is what Stripe actually took, which is NOT
            // `intent.amount` (the authorised figure) on a partial capture.
            amountPaise: requireCapturedAmountPaise(
              event.data.object,
              "amount_received",
              `payment_intent.succeeded ${intent.id}`,
            ),
            // A PaymentIntent is both the order and the charge-bearing object
            // on this rail, so its id is both keys.
            gatewayPaymentId: intent.id,
          });
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
              latestRefund.status,
              "STRIPE",
              // 7th arg — the provider payment id the org-level branches key
              // on (WalletTopUp / OrganizationInvoice.providerPaymentId); only
              // the B2C Payment lookup uses `payment_intent`. `ch_<…>` is the
              // Stripe analogue of the `pay_<…>` razorpay-dispatch passes here.
              // Org billing mints Razorpay orders today, so nothing matches on
              // this rail yet; what it changes now is the not-found case, which
              // stopped silently ACKing (#813/#812 calls that permanent death)
              // and now 5xxs so Stripe re-delivers.
              typeof latestRefund.charge === "string"
                ? latestRefund.charge
                : (latestRefund.charge?.id ?? refundEvent.id),
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

        // Stripe Connect Payout/Transfer events.
        //
        // Payouts are India-first via RazorpayX; Stripe Connect payout
        // integration is opt-in. Production environments that haven't
        // onboarded Connect will otherwise receive noisy webhooks (e.g.
        // for the platform's own Stripe balance movements). Gate both
        // the handler and the subsequent `account.updated` /
        // `transfer.*` logs behind ENABLE_STRIPE_PAYOUTS so we can
        // enable the full Connect flow atomically once ready.
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
          const payoutEvent = event.data.object;
          await handleStripePayoutWebhook(eventType, {
            id: payoutEvent.id,
            status: payoutEvent.status,
            failure_code: payoutEvent.failure_code,
            failure_message: payoutEvent.failure_message,
          });
          break;
        }

        // Stripe Connect Account events — only meaningful when Connect
        // payouts are enabled.
        case "account.updated": {
          if (process.env.ENABLE_STRIPE_PAYOUTS !== "true") break;
          const accountEvent = event.data.object;
          console.log(`📄 Stripe Connect account updated: ${accountEvent.id}`, {
            chargesEnabled: accountEvent.charges_enabled,
            payoutsEnabled: accountEvent.payouts_enabled,
            detailsSubmitted: accountEvent.details_submitted,
          });
          break;
        }

        // Transfer events (platform to connected account)
        case "transfer.created":
        case "transfer.reversed": {
          if (process.env.ENABLE_STRIPE_PAYOUTS !== "true") break;
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
      Sentry.captureException(handlerError, {
        tags: { subsystem: "payments", provider: "stripe" },
        contexts: { webhook: { eventType, eventId } },
      });
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

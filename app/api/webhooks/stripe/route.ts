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
 * Read a captured-amount figure off the RAW event object, in the currency's
 * smallest unit, or `undefined` when the field is absent or not an integer.
 *
 * The RAW object is deliberate: `stripePaymentIntentSucceededEventSchema` and
 * `stripeCheckoutSessionCompletedEventSchema` model only the fields this route
 * consumes, and zod strips everything else, so `amount_received` does not
 * survive the parse. The figure is never taken from `metadata` either —
 * metadata is written before the capture, so it can only restate the order
 * total, and feeding that into the parity check compares the gateway against
 * itself.
 *
 * No currency conversion is needed: `createStripeCheckoutSession` runs
 * `assertInrSettlement` as its first statement and prices `unit_amount` from
 * that, so paise is the only unit this rail can produce.
 */
function readCapturedAmountPaise(
  raw: unknown,
  field: string,
): number | undefined {
  const amount = (raw as Record<string, unknown> | null | undefined)?.[field];
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) {
    return undefined;
  }
  return amount;
}

/**
 * Strict variant for the door that owns the gateway truth. `amount_received` is
 * a required field of a `payment_intent.succeeded` object, so a missing figure
 * means a payload this route cannot reason about — and a door that cannot state
 * what was captured must not confirm a booking for it. That argument used to be
 * optional and omitted here entirely, so an under-captured Stripe order
 * confirmed a FULL booking with no parity check at all: silent under-collection.
 * Throwing makes the route 500, which is what makes Stripe redeliver.
 */
function requireCapturedAmountPaise(
  raw: unknown,
  field: string,
  source: string,
): number {
  const amount = readCapturedAmountPaise(raw, field);
  if (amount === undefined) {
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
        //
        // #ADR-21 — this door used to call handlePaymentSuccess(session.id,
        // session.metadata) with no amount and no gateway payment id, so the
        // capture-amount parity check and the `gatewayPaymentId` write (which
        // the refund and dispute webhooks resolve against) were both skipped
        // here. It now goes through the SAME router as `payment.captured`,
        // `order.paid` and both client-return doors, so notes.type routing and
        // the parity check cannot drift per-gateway again.
        case "checkout.session.completed": {
          const sessionEvent =
            stripeCheckoutSessionCompletedEventSchema.parse(event);
          const session = sessionEvent.data.object;
          // Use session.id (cs_...) which matches Payment.paymentIntent.
          // `payment_intent` (pi_...) is this rail's `pay_…`: the object the
          // refund/dispute webhooks can be resolved against.
          //
          // INVARIANT: a Checkout Session with no collected money must not
          // confirm a booking.
          //
          // `checkout.session.completed` fires for a session that is `complete`
          // but whose payment is NOT yet collected — `payment_status` is `unpaid`
          // whenever an async/delayed method is in flight, and also on the
          // window between a card's authorisation and a 3DS step the buyer has
          // not finished. `status: "complete"` means the CHECKOUT finished, not
          // that money arrived. This door used to route every completed session
          // regardless, so a `unpaid` one confirmed a consultant's time with
          // nothing received: a real under-collection behind a live commitment.
          // Since the amount is withheld below, `payment_status` is the only
          // gateway-truth signal left on this payload, and it answers exactly the
          // one question this door has to ask — did money arrive?
          //
          // Allow-list, not a deny-list: only `paid` collects. `no_payment_required`
          // is a zero-total session, and a zero-amount checkout is confirmed
          // synchronously in lib/payments/operations/checkout.ts and never becomes
          // a PENDING B2C row, so it cannot be the row this door would confirm.
          // An unrecognised future value must also fall on the refuse side.
          //
          // Why parking is safe, and why it is NOT a lost booking: the Payment
          // row stays PENDING, which is the durable park, and
          // `reconcile-payment-status` (every 30m) is Stripe-capable — it
          // resolves the `cs_…` to its `pi_…` and reads gateway truth
          // (scripts/payments/reconcile-payment-status.ts), so a 3DS that later
          // completes is still picked up. If the money never lands,
          // `cleanup-abandoned-payments` EXPIREs the row and releases the hold,
          // so the slot is re-sellable and the buyer can re-book. Either way no
          // money is stranded and no slot is sold twice.
          //
          // The sibling `payment_intent.succeeded` door does NOT rescue this, and
          // the reason matters: it calls routeCapturedPayment with `intent.id`
          // (`pi_…`), but handlePaymentSuccess resolves the row with a strict
          // `findUnique({ paymentIntent })` and this rail stores the `cs_…`
          // there (createStripeCheckoutSession returns session.id). So the
          // intent door throws "Payment record not found" on a Checkout row and
          // confirms nothing. `verify?sync=true` is gated on `order_` and does
          // not help either. The PENDING row plus those two sweeps is the whole
          // durable path, which is why the guard below writes nothing itself.
          //
          // 200, not 500: the event is durably recorded, Stripe will not re-fire
          // a completed session, and `logWebhookEvent` short-circuits a retry of
          // the same `evt_…` as a duplicate — so a 500 would burn the retry
          // schedule on a payload that can never succeed, which is the failure
          // mode the envelope check above already avoids. This is the same
          // 200-and-log an unhandled event gets.
          if (session.payment_status !== "paid") {
            console.warn(
              `⚠️ Stripe checkout.session.completed ${session.id}: payment_status="${session.payment_status}" is not "paid" — NOT confirming a booking (no money collected); the Payment row stays PENDING for reconcile-payment-status, or cleanup-abandoned-payments releases the hold if the money never lands`,
            );
            break;
          }
          //
          // A Checkout Session carries no CAPTURED amount. `amount_total` is
          // the session's ORDER total — what was asked for — and it does not
          // move when a payment is partially captured. Passing it as
          // `amountPaise` would make the parity check compare the gateway
          // against itself, which is the same defect removed from the Razorpay
          // `order.paid` fallback in W1b, and it would read as "verified" while
          // proving nothing. So this door deliberately WITHHOLDS the amount and
          // the parity check is skipped — the org rail's existing conservatism.
          //
          // The rail is not blind to a short capture ON THE DIRECT-INTENT FLOW:
          // Stripe fires `payment_intent.succeeded`, which does carry
          // `amount_received`, and the door below passes that through. On a
          // CHECKOUT row that door cannot resolve the row (see the payment_status
          // guard above), so it is `reconcile-payment-status` that re-reads a
          // `cs_…` and catches a short capture. This one only adds the session
          // as a second entry point.
          const sessionTotalPaise = readCapturedAmountPaise(
            event.data.object,
            "amount_total",
          );
          if (sessionTotalPaise !== undefined) {
            console.warn(
              `⚠️ Stripe checkout.session.completed ${session.id}: amount_total is the session ORDER total (${sessionTotalPaise}p), not a captured amount — confirming without a capture-amount parity check; the payment_intent.succeeded door carries amount_received`,
            );
          }
          await routeCapturedPayment({
            orderId: session.id,
            notes: session.metadata || {},
            // Intentionally undefined — see above.
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

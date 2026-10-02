import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  verifyWebhookSignature,
  logWebhookEvent,
  markWebhookEventProcessed,
  isDbHealthy,
} from "../utils";
import { dispatchStripeEventByType } from "../stripe-dispatch";
import { scrubWebhookPayload } from "@/lib/logging/webhook-scrub";
import { MAX_WEBHOOK_BODY_BYTES } from "@/lib/webhooks/read-body";
import { stripeBaseEventSchema } from "../../../../schemas/webhooks/stripe";
import { permanentFailure } from "@/lib/webhooks/event-log";
import { ZodError } from "zod";

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
        return NextResponse.json({
          status: "ignored",
          reason: "invalid_payload",
        });
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

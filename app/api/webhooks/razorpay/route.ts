import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import crypto from "node:crypto";
import {
  verifyWebhookSignature,
  logWebhookEvent,
  isDbHealthy,
} from "../utils";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import {
  razorpayWebhookEnvelopeSchema,
  type RazorpayWebhookEnvelope,
} from "../../../../schemas/webhooks/razorpay";
// #785 — dispatch switch extracted to a Next-agnostic module so the B5
// stuck-webhook sweeper (jobs/cleanup/sweep-stuck-webhook-events) can replay
// crashed events through the exact same handler routing.
import { processRazorpayWebhookEvent } from "../razorpay-dispatch";

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
          // #776 §K — repeated HMAC failures are a tamper/misconfig signal.
          await recordSystemEvent({
            category: "WEBHOOK",
            severity: "WARN",
            message: "Razorpay webhook HMAC verification failed (RazorpayX secret)",
            context: { provider: "razorpayx", event: "payout.*" },
          });
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
      // #776 §K — repeated HMAC failures are a tamper/misconfig signal.
      await recordSystemEvent({
        category: "WEBHOOK",
        severity: "WARN",
        message: "Razorpay webhook HMAC verification failed",
        context: { provider: "razorpay" },
      });
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
    await processRazorpayWebhookEvent(event, eventType, eventId);
  });

  return NextResponse.json({ status: "ok" });
}

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import crypto from "node:crypto";
import { logWebhookEvent, isDbHealthy } from "../utils";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import {
  razorpayWebhookEnvelopeSchema,
  type RazorpayWebhookEnvelope,
} from "../../../../schemas/webhooks/razorpay";
// #785 — dispatch switch extracted to a Next-agnostic module so the B5
// stuck-webhook sweeper (jobs/cleanup/sweep-stuck-webhook-events) can replay
// crashed events through the exact same handler routing.
import { processRazorpayWebhookEvent } from "../razorpay-dispatch";
import {
  isPayoutEventName,
  matchRazorpayWebhookSecret,
  resolveRazorpayPaymentSecrets,
  resolveRazorpayXSecrets,
} from "./signature";
import {
  MAX_WEBHOOK_BODY_BYTES,
  readBodyWithinCap,
} from "@/lib/webhooks/read-body";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const declaredBytes = Number(req.headers.get("content-length"));
  if (
    Number.isFinite(declaredBytes) &&
    declaredBytes > MAX_WEBHOOK_BODY_BYTES
  ) {
    console.warn(
      `Rejected oversized Razorpay webhook body: ${declaredBytes} bytes`,
    );
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  Sentry.setTag("subsystem", "payments");

  const paymentSecrets = resolveRazorpayPaymentSecrets();
  if (paymentSecrets.length === 0) {
    console.error("RAZORPAY_WEBHOOK_SECRET not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  const signature = req.headers.get("x-razorpay-signature");
  const body = signature ? await readBodyWithinCap(req) : "";
  if (body === null) {
    console.warn(
      `Rejected oversized Razorpay webhook body: over ${MAX_WEBHOOK_BODY_BYTES} bytes`,
    );
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const matchedRole = signature
    ? matchRazorpayWebhookSecret(body, signature, paymentSecrets)
    : null;

  if (matchedRole === "previous") {
    await recordSystemEvent({
      category: "WEBHOOK",
      severity: "WARN",
      message:
        "Razorpay webhook verified with RAZORPAY_WEBHOOK_SECRET_PREVIOUS — rotation grace still in use",
      context: { provider: "razorpay" },
    });
  }

  if (!matchedRole) {
    const isPossiblyRazorpayXEvent = signature
      ? isPayoutEventName(body)
      : false;
    const razorpayXSecrets = isPossiblyRazorpayXEvent
      ? resolveRazorpayXSecrets().filter(
          (xCandidate) =>
            !paymentSecrets.some((p) => p.value === xCandidate.value),
        )
      : [];

    const matchedXRole =
      isPossiblyRazorpayXEvent && signature
        ? matchRazorpayWebhookSecret(body, signature, razorpayXSecrets)
        : null;

    if (matchedXRole === "previous") {
      await recordSystemEvent({
        category: "WEBHOOK",
        severity: "WARN",
        message:
          "RazorpayX webhook verified with RAZORPAYX_WEBHOOK_SECRET_PREVIOUS — rotation grace still in use",
        context: { provider: "razorpayx" },
      });
    }

    if (!matchedXRole) {
      await recordSystemEvent({
        category: "WEBHOOK",
        severity: "WARN",
        message: isPossiblyRazorpayXEvent
          ? "Razorpay webhook HMAC verification failed (RazorpayX secret)"
          : "Razorpay webhook HMAC verification failed",
        context: isPossiblyRazorpayXEvent
          ? { provider: "razorpayx", event: "payout.*|fund_account.*" }
          : { provider: "razorpay" },
      });
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }
  }

  // DB health check — return 503 if DB is unreachable so Razorpay retries
  if (!(await isDbHealthy())) {
    Sentry.logger.warn("razorpay webhook: db unhealthy, returning 503");
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
    Sentry.captureException(parseError, {
      tags: { subsystem: "payments" },
      contexts: { webhook: { provider: "razorpay" } },
    });
    return NextResponse.json(
      { error: "Invalid webhook payload" },
      { status: 400 },
    );
  }

  // #1861 P4b — IDs only, whichever entity this event actually carries; the
  // internal Payment.id/appointmentId are not known until dispatch resolves
  // them, so the gateway's own order id is what's taggable here.
  const gatewayOrderId = event.payload?.order?.entity?.id;
  if (gatewayOrderId) {
    Sentry.getCurrentScope().setTag("gatewayOrderId", gatewayOrderId);
  }

  // Razorpay sends `x-razorpay-event-id`, and it is tempting as the dedup key.
  // This repo deliberately does NOT use it — see
  // .claude/skills/finance/references/razorpay/references/webhooks.md.
  //
  // Two reasons, and the second is the one that matters. First, the synthesized
  // key dedups on the *business fact* rather than the delivery, so two distinct
  // deliveries describing the same state transition collapse to one. Second,
  // and decisively: the HMAC covers the BODY ONLY. A header is unsigned, so
  // keying on it would let anyone holding one captured (body, signature) pair
  // replay it N times under N invented header values and get N full dispatches.
  // The key below is derived entirely from signature-covered material — an
  // entity id from the payload, or a hash of the raw body — which is what makes
  // the dedup boundary tamper-proof rather than merely convenient.
  //
  // Every downstream handler is separately idempotent, so the amplification
  // would not have moved money; it would have removed a defence-in-depth layer
  // for no correctness gain. If you change this, you are changing what "already
  // processed" means AND weakening a trust boundary.
  // #1132 — refund/dispute MUST be probed before payment. Razorpay sends
  // `contains: ["refund","payment"]` on refund events, so a payment-first chain
  // keyed every refund on a given payment to the same id. The second partial
  // refund then matched as a duplicate and never reached handleRefundCreated —
  // no Refund row, no earnings reversal, no credit note, no ledger posting,
  // while the money had already left. Most-specific entity wins.
  const bodyHash = crypto
    .createHash("sha256")
    .update(body)
    .digest("hex")
    .slice(0, 16);
  const entityId =
    event.payload?.refund?.entity?.id ||
    event.payload?.dispute?.entity?.id ||
    event.payload?.payout?.entity?.id ||
    event.payload?.["fund_account.validation"]?.entity?.id ||
    event.payload?.settlement?.entity?.id ||
    event.payload?.payment?.entity?.id ||
    event.payload?.order?.entity?.id ||
    event.account_id ||
    `body_${bodyHash}`;
  const eventId = `${eventType}:${entityId}:${bodyHash}`;

  // Idempotency check (synchronous — must complete before returning 200)
  const { isNew, claim } = await logWebhookEvent(
    "razorpay",
    eventId,
    eventType,
    event.payload,
    signature || undefined,
  );

  if (!isNew) {
    console.log(`⚠️ Duplicate webhook event ${eventId}, returning OK`);
    return NextResponse.json({ status: "ok", duplicate: true });
  }

  Sentry.logger.info(Sentry.logger.fmt`razorpay webhook: ${eventType}`, {
    eventId,
  });

  // Return 200 immediately — process the event asynchronously
  after(async () => {
    await processRazorpayWebhookEvent(event, eventType, eventId, claim);
  });

  return NextResponse.json({ status: "ok" });
}

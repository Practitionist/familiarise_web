import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import crypto from "node:crypto";
import { logWebhookEvent, isDbHealthy } from "../utils";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import { readRazorpayIngress } from "../../../../schemas/webhooks/razorpay";
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

/** Razorpay event ids are short alphanumerics; anything else falls back to the body hash. */
const RAZORPAY_EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

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

  // The signature is the only gate: a verified delivery is stored whatever
  // its shape, answered 200, and parsed by dispatch, which records a shape it
  // cannot read on the stored row.
  let rawEvent: unknown = body;
  try {
    rawEvent = JSON.parse(body);
  } catch {
    // Not JSON: stored as the signed text.
  }
  const ingress = readRazorpayIngress(rawEvent);
  const eventType = ingress.eventType;

  // IDs only: the gateway's own order id is what is known before dispatch.
  const gatewayOrderId = ingress.entityId("order");
  if (gatewayOrderId) {
    Sentry.getCurrentScope().setTag("gatewayOrderId", gatewayOrderId);
  }

  // Razorpay keeps `x-razorpay-event-id` across retries and dashboard replays,
  // so it keys dedupe when present; the body hash is the fallback. The event type
  // and entity id come from the signed body. Refund/dispute are probed before
  // payment because refund events also carry the payment entity.
  const bodyHash = crypto
    .createHash("sha256")
    .update(body)
    .digest("hex")
    .slice(0, 16);
  const entityId =
    ingress.entityId("refund") ||
    ingress.entityId("dispute") ||
    ingress.entityId("payout") ||
    ingress.entityId("fund_account.validation") ||
    ingress.entityId("settlement") ||
    ingress.entityId("payment") ||
    ingress.entityId("order") ||
    ingress.accountId ||
    `body_${bodyHash}`;
  const headerEventId = req.headers.get("x-razorpay-event-id")?.trim() ?? "";
  const razorpayEventId = RAZORPAY_EVENT_ID.test(headerEventId)
    ? headerEventId
    : bodyHash;
  const eventId = `${eventType}:${entityId}:${razorpayEventId}`;

  // Idempotency check (synchronous — must complete before returning 200)
  const { isNew, claim } = await logWebhookEvent(
    "razorpay",
    eventId,
    eventType,
    ingress.stored,
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
    await processRazorpayWebhookEvent(rawEvent, eventType, eventId, claim);
  });

  return NextResponse.json({ status: "ok" });
}

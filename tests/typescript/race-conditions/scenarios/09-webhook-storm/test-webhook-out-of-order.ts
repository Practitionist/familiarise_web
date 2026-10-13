/**
 * Test: Out-of-Order Webhook Delivery (refund before capture)
 * Category: 09 - Webhook storm (#837 scenario 16)
 *
 * Razorpay makes no ordering guarantee: a refund.created can land before
 * the payment.captured it follows. The route must ACK both (2xx — a 5xx
 * triggers gateway retry storms), record each envelope exactly once under
 * its own composite eventId, and never crash on the unknown-payment path.
 *
 * Uses a nonexistent payment id: exercises ordering/ack/idempotency
 * machinery, not the money cascade (staging gate covers cascades).
 */
import "dotenv/config";
import crypto from "node:crypto";
import prisma from "../../../../../lib/prisma";
import {
  BASE_URL,
  check,
  finish,
  ensureServerOrSkip,
} from "../../utilities/api-client";
import {
  buildRazorpayPaymentCapturedEnvelope,
  buildRazorpayRefundCreatedEnvelope,
} from "../../utilities/fixtures";

const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

async function deliver(payload: string) {
  const signature = crypto
    .createHmac("sha256", SECRET!)
    .update(payload)
    .digest("hex");
  const r = await fetch(`${BASE_URL}/api/webhooks/razorpay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-signature": signature,
    },
    body: payload,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function run() {
  await ensureServerOrSkip();

  if (!SECRET) {
    console.log("⏭️  SKIP — RAZORPAY_WEBHOOK_SECRET not set");
    process.exit(0);
  }

  const suffix = `${process.pid}_${Date.now()}`;
  const paymentId = `pay_chaos_ooo_${suffix}`;
  const refundId = `rfnd_chaos_ooo_${suffix}`;

  // 1) Refund arrives FIRST.
  const refundFirst = await deliver(
    buildRazorpayRefundCreatedEnvelope({
      refundId,
      paymentId,
      amount: 100,
      currency: "INR",
      status: "created",
    }),
  );
  check(
    "refund.created before capture is ACKed (2xx)",
    refundFirst.status >= 200 && refundFirst.status < 300,
    refundFirst,
  );

  // 2) Capture lands afterwards.
  const captureLater = await deliver(
    buildRazorpayPaymentCapturedEnvelope({
      paymentId,
      orderId: `order_chaos_ooo_${suffix}`,
      amount: 100,
      currency: "INR",
    }),
  );
  check(
    "late payment.captured is ACKed (2xx)",
    captureLater.status >= 200 && captureLater.status < 300,
    captureLater,
  );

  // 3) Each envelope recorded exactly once under its own composite id.
  const refundEventId = `refund.created:${refundId}`;
  const captureEventId = `payment.captured:${paymentId}`;
  const refundRows = await prisma.webhookEvent.count({
    where: { eventId: refundEventId },
  });
  const captureRows = await prisma.webhookEvent.count({
    where: { eventId: captureEventId },
  });
  check(
    "one WebhookEvent row per envelope",
    refundRows === 1 && captureRows === 1,
    { refundRows, captureRows },
  );

  // 4) Replaying each once more stays deduped.
  await deliver(
    buildRazorpayRefundCreatedEnvelope({
      refundId,
      paymentId,
      amount: 100,
      currency: "INR",
      status: "created",
    }),
  );
  const refundRowsAfterReplay = await prisma.webhookEvent.count({
    where: { eventId: refundEventId },
  });
  check(
    "replay does not create a second row",
    refundRowsAfterReplay === 1,
    { refundRowsAfterReplay },
  );

  // Cleanup chaos rows for repeat runs.
  await prisma.webhookEvent.deleteMany({
    where: { eventId: { in: [refundEventId, captureEventId] } },
  });

  finish("webhook-out-of-order");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

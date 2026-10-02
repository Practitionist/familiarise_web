import crypto from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import { isDbHealthy, logWebhookEvent, markWebhookEventProcessed } from "@/lib/webhooks/event-log";
import {
  MAX_WEBHOOK_BODY_BYTES,
  readBodyWithinCap,
} from "@/lib/webhooks/read-body";
import {
  isNovuDeliveredEvent,
  isNovuFailureEvent,
  novuWebhookEventSchema,
  resolveNovuError,
  resolveNovuEventType,
  resolveNovuStatus,
  resolveNovuTransactionId,
} from "@/schemas/webhooks/novu";

export const runtime = "nodejs";

/**
 * Verify Novu HMAC-SHA256 webhook signature (`x-novu-signature` or `novu-signature`).
 * Accepts raw hex or `sha256=<hex>` formats using constant-time comparison.
 */
export function verifyNovuWebhookSignature(
  body: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const normalized = signatureHeader.trim().replace(/^sha256=/i, "");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  const sigBuf = Buffer.from(normalized, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

export async function POST(req: NextRequest) {
  const declaredBytes = Number(req.headers.get("content-length"));
  if (
    Number.isFinite(declaredBytes) &&
    declaredBytes > MAX_WEBHOOK_BODY_BYTES
  ) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  Sentry.setTag("subsystem", "notifications");

  const secret = process.env.NOVU_WEBHOOK_SECRET;
  if (!secret) {
    console.error("NOVU_WEBHOOK_SECRET not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 },
    );
  }

  const body = await readBodyWithinCap(req);
  if (body === null) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  if (!body) {
    return NextResponse.json({ error: "Empty body" }, { status: 400 });
  }

  const signature =
    req.headers.get("x-novu-signature") ?? req.headers.get("novu-signature");

  if (!verifyNovuWebhookSignature(body, signature, secret)) {
    await recordSystemEvent({
      category: "WEBHOOK",
      severity: "WARN",
      message: "Novu webhook HMAC verification failed",
      context: { provider: "novu" },
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  if (!(await isDbHealthy())) {
    Sentry.logger.warn("novu webhook: db unhealthy, returning 503");
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 503 },
    );
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsedResult = novuWebhookEventSchema.safeParse(rawJson);
  if (!parsedResult.success) {
    return NextResponse.json(
      { error: "Invalid webhook payload" },
      { status: 400 },
    );
  }

  const event = parsedResult.data;
  const eventType = resolveNovuEventType(event);
  const transactionId = resolveNovuTransactionId(event);
  const status = resolveNovuStatus(event);
  const deliveryError = resolveNovuError(event);

  const bodyHash = crypto
    .createHash("sha256")
    .update(body)
    .digest("hex")
    .slice(0, 16);
  const eventId =
    event.id ??
    event.eventId ??
    (transactionId
      ? `${eventType}:${transactionId}:${bodyHash}`
      : `${eventType}:body_${bodyHash}`);

  const { isNew, claim } = await logWebhookEvent(
    "novu",
    eventId,
    eventType,
    event,
    signature ?? undefined,
  );

  if (!isNew) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  let processingError: string | undefined;
  try {
    if (isNovuFailureEvent(eventType, status)) {
      const errorText =
        deliveryError ?? `Novu delivery failure (${eventType})`;
      if (transactionId && typeof prisma.notificationOutbox?.updateMany === "function") {
        await prisma.notificationOutbox.updateMany({
          where: { transactionId },
          data: {
            lastError: errorText,
          },
        });
      }
      await recordSystemEvent({
        category: "WEBHOOK",
        severity: "WARN",
        message: `Novu notification delivery failed: ${eventType}`,
        context: {
          provider: "novu",
          eventId,
          eventType,
          transactionId: transactionId ?? null,
          subscriberId: event.subscriberId ?? event.data?.subscriberId ?? null,
          workflowId: event.workflowId ?? event.data?.workflowId ?? null,
          error: errorText,
        },
      });
    } else if (
      transactionId &&
      isNovuDeliveredEvent(eventType, status) &&
      typeof prisma.notificationOutbox?.updateMany === "function"
    ) {
      await prisma.notificationOutbox.updateMany({
        where: { transactionId, status: "PENDING" },
        data: {
          status: "SENT",
          sentAt: new Date(),
          nextRetryAt: null,
          lastError: null,
        },
      });
    }
  } catch (err) {
    processingError = err instanceof Error ? err.message : String(err);
    Sentry.captureException(err, {
      tags: { subsystem: "notifications", provider: "novu" },
      contexts: { webhook: { eventId, eventType, transactionId } },
    });
    throw err;
  } finally {
    await markWebhookEventProcessed(eventId, processingError, claim);
  }

  return NextResponse.json({ received: true });
}

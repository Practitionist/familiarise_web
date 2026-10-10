import crypto from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import {
  isDbHealthy,
  logWebhookEvent,
  markWebhookEventProcessed,
} from "@/lib/webhooks/event-log";
import {
  MAX_WEBHOOK_BODY_BYTES,
  readBodyWithinCap,
} from "@/lib/webhooks/read-body";
import {
  extractNovuChannel,
  extractNovuErrorMessage,
  extractNovuSubscriberId,
  extractNovuTransactionId,
  isNovuDeliveredEvent,
  isNovuFailureEvent,
  novuWebhookPayloadSchema,
  resolveNovuEventType,
  resolveNovuStatus,
  verifyNovuWebhook,
  type NovuWebhookPayload,
} from "@/schemas/webhooks/novu";

export const runtime = "nodejs";

/**
 * Applies delivery outcome updates to `NotificationOutbox` and emits operational warnings
 * on failure events (`message.failed`, `message.bounced`, `execution_detail.failed`, etc.).
 */
export async function processNovuWebhookPayload(
  payload: NovuWebhookPayload,
  resolvedEventId?: string,
): Promise<void> {
  const eventType = resolveNovuEventType(payload);
  const transactionId = extractNovuTransactionId(payload);
  const subscriberId = extractNovuSubscriberId(payload);
  const channel = extractNovuChannel(payload);
  const status = resolveNovuStatus(payload);
  const deliveryError = extractNovuErrorMessage(payload);
  const eventId = resolvedEventId ?? payload.id ?? payload.eventId ?? null;

  if (isNovuFailureEvent(eventType, status)) {
    const errorText = deliveryError ?? `Novu delivery failure (${eventType})`;
    if (transactionId) {
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
        channel: channel ?? null,
        transactionId: transactionId ?? null,
        subscriberId: subscriberId ?? null,
        workflowId: payload.workflowId ?? payload.data?.workflowId ?? null,
        error: errorText,
      },
    });
  } else if (transactionId && isNovuDeliveredEvent(eventType, status)) {
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
      { status: 503 },
    );
  }

  const body = await readBodyWithinCap(req);
  if (body === null) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  if (!body) {
    return NextResponse.json({ error: "Empty body" }, { status: 400 });
  }

  if (!verifyNovuWebhook(body, req.headers, secret)) {
    await recordSystemEvent({
      category: "WEBHOOK",
      severity: "WARN",
      message: "Novu webhook signature verification failed",
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

  const parsedResult = novuWebhookPayloadSchema.safeParse(rawJson);
  if (!parsedResult.success) {
    return NextResponse.json(
      { error: "Invalid webhook payload" },
      { status: 400 },
    );
  }

  const event = parsedResult.data;
  const eventType = resolveNovuEventType(event);
  const transactionId = extractNovuTransactionId(event);

  const bodyHash = crypto
    .createHash("sha256")
    .update(body)
    .digest("hex")
    .slice(0, 16);
  const verifiedSvixId = req.headers.get("svix-signature")
    ? req.headers.get("svix-id")
    : null;
  const eventId =
    verifiedSvixId ??
    event.id ??
    event.eventId ??
    (transactionId
      ? `${eventType}:${transactionId}:${bodyHash}`
      : `${eventType}:body_${bodyHash}`);

  const signature =
    req.headers.get("svix-signature") ??
    req.headers.get("x-novu-signature") ??
    req.headers.get("novu-signature");

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

  try {
    await processNovuWebhookPayload(event, eventId);
  } catch (err) {
    const processingError = err instanceof Error ? err.message : String(err);
    Sentry.captureException(err, {
      tags: { subsystem: "notifications", provider: "novu" },
      contexts: { webhook: { eventId, eventType, transactionId } },
    });
    await markWebhookEventProcessed(eventId, processingError, claim);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  await markWebhookEventProcessed(eventId, undefined, claim);
  return NextResponse.json({ received: true });
}

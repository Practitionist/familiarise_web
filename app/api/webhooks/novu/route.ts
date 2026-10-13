import crypto from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";

import { recordSystemEvent } from "@/lib/enterprise/system-events";
import {
  isDbHealthy,
  logWebhookEvent,
  markWebhookEventProcessed,
} from "@/lib/webhooks/event-log";
import { processNovuWebhookPayload } from "@/lib/webhooks/novu-handler";
import {
  MAX_WEBHOOK_BODY_BYTES,
  readBodyWithinCap,
} from "@/lib/webhooks/read-body";
import {
  extractNovuTransactionId,
  novuWebhookPayloadSchema,
  resolveNovuEventType,
  verifyNovuWebhook,
  type NovuWebhookPayload,
} from "@/schemas/webhooks/novu";

export const runtime = "nodejs";

function deriveNovuEventId(
  event: NovuWebhookPayload,
  eventType: string,
  transactionId: string | undefined,
  verifiedSvixId: string | null,
  bodyHash: string,
): string {
  if (verifiedSvixId) return verifiedSvixId;
  if (event.id) return event.id;
  if (event.eventId) return event.eventId;
  if (transactionId) return `${eventType}:${transactionId}:${bodyHash}`;
  return `${eventType}:body_${bodyHash}`;
}

function formatError(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return JSON.stringify(err) ?? "Unknown error";
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
  const eventId = deriveNovuEventId(
    event,
    eventType,
    transactionId,
    verifiedSvixId,
    bodyHash,
  );
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
    const processingError = formatError(err);
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

import crypto from "node:crypto";
import { Webhook } from "standardwebhooks";
import { z } from "zod";

const REPLAY_TOLERANCE_MS = 5 * 60 * 1000;

function readHeader(
  headers: Headers | Record<string, string | null | undefined>,
  name: string,
): string | null {
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  const direct = headers[name] ?? headers[name.toLowerCase()];
  return typeof direct === "string" ? direct : null;
}

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

/**
 * Verifies inbound Novu webhook authenticity across both Svix (`svix-id`,
 * `svix-timestamp`, `svix-signature`) and legacy `x-novu-signature` HMAC modes
 * with a 5-minute replay window.
 */
export function verifyNovuWebhook(
  rawBody: string,
  headers: Headers | Record<string, string | null | undefined>,
  secret: string,
): boolean {
  if (!secret || !rawBody) return false;

  const svixSignature = readHeader(headers, "svix-signature");
  if (svixSignature) {
    const svixId = readHeader(headers, "svix-id");
    const svixTimestamp = readHeader(headers, "svix-timestamp");
    if (!svixId || !svixTimestamp) return false;

    const tsNum = Number(svixTimestamp);
    if (!Number.isFinite(tsNum)) return false;
    const tsMs = tsNum > 1e12 ? tsNum : tsNum * 1000;
    if (Math.abs(Date.now() - tsMs) > REPLAY_TOLERANCE_MS) return false;

    try {
      const wh = new Webhook(secret);
      wh.verify(rawBody, {
        "webhook-id": svixId,
        "webhook-timestamp": svixTimestamp,
        "webhook-signature": svixSignature,
      });
      return true;
    } catch {
      return false;
    }
  }

  const signature =
    readHeader(headers, "x-novu-signature") ??
    readHeader(headers, "novu-signature");
  return verifyNovuWebhookSignature(rawBody, signature, secret);
}

const novuDataObjectSchema = z
  .object({
    id: z.string().optional(),
    subscriberId: z.string().optional(),
    channel: z.string().optional(),
    providerId: z.string().optional(),
    transactionId: z.string().min(1).optional(),
    error: z.string().nullable().optional(),
    createdAt: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const novuDataSchema = z
  .object({
    subscriber: z
      .union([
        z.string(),
        z.object({ subscriberId: z.string().optional() }).passthrough(),
      ])
      .optional(),
    subscriberId: z.string().optional(),
    channel: z.string().optional(),
    transactionId: z.string().min(1).optional(),
    workflowId: z.string().optional(),
    messageId: z.string().optional(),
    status: z.string().optional(),
    error: z.string().nullable().optional(),
    object: novuDataObjectSchema.optional(),
  })
  .passthrough();

/**
 * Inbound Novu webhook schema supporting both top-level `data` fields and nested `data.object`.
 */
export const novuWebhookPayloadSchema = z
  .object({
    id: z.string().min(1).optional(),
    eventId: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    event: z.string().min(1).optional(),
    timestamp: z.union([z.number(), z.string()]).optional(),
    transactionId: z.string().min(1).optional(),
    workflowId: z.string().optional(),
    subscriberId: z.string().optional(),
    messageId: z.string().optional(),
    channel: z.string().optional(),
    status: z.string().optional(),
    error: z.string().nullable().optional(),
    data: novuDataSchema.optional(),
    payload: z.record(z.unknown()).optional(),
  })
  .passthrough()
  .refine(
    (val) => Boolean(val.type || val.event),
    "Novu webhook payload must include `type` or `event`",
  );

export type NovuWebhookPayload = z.infer<typeof novuWebhookPayloadSchema>;
export const novuWebhookEventSchema = novuWebhookPayloadSchema;
export type NovuWebhookEvent = NovuWebhookPayload;

export function extractNovuSubscriberId(
  payload: NovuWebhookPayload,
): string | undefined {
  const fromSubscriberField =
    typeof payload.data?.subscriber === "string"
      ? payload.data.subscriber
      : payload.data?.subscriber?.subscriberId;
  return (
    payload.data?.object?.subscriberId ??
    payload.data?.subscriberId ??
    fromSubscriberField ??
    payload.subscriberId
  );
}

export function extractNovuChannel(
  payload: NovuWebhookPayload,
): string | undefined {
  return (
    payload.data?.object?.channel ?? payload.data?.channel ?? payload.channel
  );
}

export function extractNovuTransactionId(
  payload: NovuWebhookPayload,
): string | undefined {
  return (
    payload.data?.object?.transactionId ??
    payload.data?.transactionId ??
    payload.transactionId
  );
}

export function extractNovuErrorMessage(
  payload: NovuWebhookPayload,
): string | undefined {
  const err =
    payload.data?.object?.error ?? payload.data?.error ?? payload.error;
  return typeof err === "string" && err.trim().length > 0
    ? err.trim()
    : undefined;
}

export function resolveNovuEventType(parsed: NovuWebhookPayload): string {
  return (parsed.type ?? parsed.event ?? "novu.unknown").trim();
}

export function resolveNovuTransactionId(
  parsed: NovuWebhookPayload,
): string | undefined {
  return extractNovuTransactionId(parsed);
}

export function resolveNovuStatus(
  parsed: NovuWebhookPayload,
): string | undefined {
  return parsed.status ?? parsed.data?.status;
}

export function resolveNovuError(
  parsed: NovuWebhookPayload,
): string | undefined {
  return extractNovuErrorMessage(parsed);
}

export function isNovuFailureEvent(
  eventType: string,
  status?: string,
): boolean {
  const normalizedType = eventType.toLowerCase();
  const normalizedStatus = status?.toLowerCase();
  if (
    normalizedType.endsWith(".failed") ||
    normalizedType.endsWith("_failed") ||
    normalizedType.includes("error") ||
    normalizedType.includes("bounced") ||
    normalizedType.includes("undelivered")
  ) {
    return true;
  }
  return (
    normalizedStatus === "failed" ||
    normalizedStatus === "error" ||
    normalizedStatus === "bounced" ||
    normalizedStatus === "undelivered"
  );
}

export function isNovuDeliveredEvent(
  eventType: string,
  status?: string,
): boolean {
  const normalizedType = eventType.toLowerCase();
  const normalizedStatus = status?.toLowerCase();
  if (
    normalizedType.endsWith(".sent") ||
    normalizedType.endsWith(".delivered") ||
    normalizedType.endsWith(".completed") ||
    normalizedType.endsWith("_sent") ||
    normalizedType.endsWith("_delivered")
  ) {
    return true;
  }
  return (
    normalizedStatus === "sent" ||
    normalizedStatus === "delivered" ||
    normalizedStatus === "completed"
  );
}

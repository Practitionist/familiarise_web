import { z } from "zod";

/**
 * #399 — Novu inbound delivery webhook schema.
 *
 * Novu dispatches webhook events for message/step/workflow delivery outcomes.
 * Payloads may supply the event name under `type` or `event` and the
 * `transactionId` at top level or nested inside `data` / `payload`.
 */
export const novuWebhookEventSchema = z
  .object({
    id: z.string().min(1).optional(),
    eventId: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    event: z.string().min(1).optional(),
    transactionId: z.string().min(1).optional(),
    workflowId: z.string().optional(),
    subscriberId: z.string().optional(),
    messageId: z.string().optional(),
    channel: z.string().optional(),
    status: z.string().optional(),
    error: z.string().nullable().optional(),
    data: z
      .object({
        transactionId: z.string().min(1).optional(),
        workflowId: z.string().optional(),
        subscriberId: z.string().optional(),
        messageId: z.string().optional(),
        channel: z.string().optional(),
        status: z.string().optional(),
        error: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    payload: z.record(z.unknown()).optional(),
  })
  .passthrough()
  .refine(
    (val) => Boolean(val.type || val.event),
    "Novu webhook payload must include `type` or `event`",
  );

export type NovuWebhookEvent = z.infer<typeof novuWebhookEventSchema>;

export function resolveNovuEventType(parsed: NovuWebhookEvent): string {
  return (parsed.type ?? parsed.event ?? "novu.unknown").trim();
}

export function resolveNovuTransactionId(
  parsed: NovuWebhookEvent,
): string | undefined {
  return parsed.transactionId ?? parsed.data?.transactionId;
}

export function resolveNovuStatus(
  parsed: NovuWebhookEvent,
): string | undefined {
  return parsed.status ?? parsed.data?.status;
}

export function resolveNovuError(
  parsed: NovuWebhookEvent,
): string | undefined {
  const err = parsed.error ?? parsed.data?.error;
  return typeof err === "string" && err.trim().length > 0
    ? err.trim()
    : undefined;
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

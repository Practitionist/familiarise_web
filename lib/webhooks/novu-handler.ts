import prisma from "@/lib/prisma";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import {
  extractNovuChannel,
  extractNovuErrorMessage,
  extractNovuSubscriberId,
  extractNovuTransactionId,
  isNovuDeliveredEvent,
  isNovuFailureEvent,
  resolveNovuEventType,
  resolveNovuStatus,
  type NovuWebhookPayload,
} from "@/schemas/webhooks/novu";

async function handleNovuFailureEvent(
  payload: NovuWebhookPayload,
  eventType: string,
  eventId: string | null,
  transactionId: string | undefined,
): Promise<void> {
  const errorText =
    extractNovuErrorMessage(payload) ?? `Novu delivery failure (${eventType})`;
  if (transactionId) {
    await prisma.notificationOutbox.updateMany({
      where: { transactionId },
      data: { lastError: errorText },
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
      channel: extractNovuChannel(payload) ?? null,
      transactionId: transactionId ?? null,
      subscriberId: extractNovuSubscriberId(payload) ?? null,
      workflowId: payload.workflowId ?? payload.data?.workflowId ?? null,
      error: errorText,
    },
  });
}

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
  const status = resolveNovuStatus(payload);
  const eventId = resolvedEventId ?? payload.id ?? payload.eventId ?? null;

  if (isNovuFailureEvent(eventType, status)) {
    await handleNovuFailureEvent(payload, eventType, eventId, transactionId);
    return;
  }

  if (transactionId && isNovuDeliveredEvent(eventType, status)) {
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

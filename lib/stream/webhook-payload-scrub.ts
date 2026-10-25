import { scrubWebhookPayload } from "@/lib/logging/webhook-scrub";
import { isHandledEventType } from "@/lib/stream/webhook-events";
import { STREAM_EVENT_SCHEMAS } from "@/schemas/webhooks/stream";

/**
 * The payload persisted in `WebhookEvent.payload` for a Stream delivery.
 * Parsing through the event's own schema keeps exactly the fields the handlers
 * and the stuck-event sweeper re-drive from, and drops participant names,
 * images and custom profile data. An unparseable payload is permanently failed
 * by dispatch, so it falls back to the generic PII scrubber.
 */
export function scrubStreamEventForStorage(
  eventType: string,
  event: unknown,
): unknown {
  if (!isHandledEventType(eventType)) return scrubWebhookPayload(event);
  const parsed = STREAM_EVENT_SCHEMAS[eventType].safeParse(event);
  return parsed.success ? parsed.data : scrubWebhookPayload(event);
}

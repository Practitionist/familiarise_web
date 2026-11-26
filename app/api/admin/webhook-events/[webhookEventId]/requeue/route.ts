/**
 * POST /api/admin/webhook-events/[webhookEventId]/requeue
 *
 * Puts a stored webhook event the sweeper gave up on, or one marked permanent,
 * back in the sweeper's queue, so it can be replayed once a handler that can
 * decode it is deployed. The sweeper re-drives it through the same dispatcher;
 * the handlers' own idempotency decides what, if anything, is written.
 */

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  isTerminalWebhookError,
  requeueTerminalWebhookEvent,
} from "@/lib/webhooks/event-log";

const NOT_TERMINAL = () =>
  new OpsRefusal(
    "NOT_TERMINAL",
    "Only an event the sweep gave up on or marked permanent can be requeued; this one is processed, still being retried, or was just requeued.",
    409,
  );

export const POST = withOpsAction(
  "systemJobs.manage",
  "webhookEvent.requeue",
  {},
  {
    mode: "tx",
    run: async (tx, { params }) => {
      const event = await tx.webhookEvent.findUnique({
        where: { id: params.webhookEventId },
        select: {
          id: true,
          eventId: true,
          eventType: true,
          provider: true,
          processed: true,
          error: true,
        },
      });
      if (!event) {
        throw new OpsRefusal("NOT_FOUND", "Webhook event not found.", 404);
      }
      if (event.processed || !isTerminalWebhookError(event.error)) {
        throw NOT_TERMINAL();
      }
      // false ⇒ another actor or the sweeper moved the row since the read.
      if (!(await requeueTerminalWebhookEvent(tx, event.id, event.error))) {
        throw NOT_TERMINAL();
      }
      return {
        target: { kind: "WebhookEvent", id: event.id },
        before: { error: event.error },
        after: {
          error: null,
          queued: true,
          eventId: event.eventId,
          eventType: event.eventType,
          provider: event.provider,
        },
        correlationId: event.eventId,
        response: { status: "requeued", webhookEventId: event.id },
      };
    },
  },
);

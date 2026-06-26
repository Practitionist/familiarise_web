/**
 * Razorpay webhook event dispatch — the eventType → handler switch, extracted
 * from the route so it can be shared by (a) the live webhook route's after()
 * callback and (b) the B5 stuck-webhook sweeper (#785, task #10) which re-drives
 * WebhookEvent rows left processed=false after an after()-callback crash.
 *
 * Deliberately Next-agnostic (NO `next/server` import) so the tsx sweeper can
 * import it without pulling the Next runtime. All handlers it calls are
 * idempotent (ledger idempotency keys + status guards), so a replay is safe.
 */
import * as Sentry from "@sentry/nextjs";
import {
  handlePaymentFailure,
  handlePaymentSuccess,
  handleOrgPaymentSuccess,
  handleOrgPaymentFailure,
  handleRefundCreated,
  handleDisputeCreated,
  handleDisputeUpdated,
  markWebhookEventProcessed,
  handleRazorpayPayoutWebhook,
  DeferSignal,
} from "./utils";
import {
  handleOverageMemberSuccess,
  handleOverageMemberFailure,
} from "@/lib/payments/webhooks/overage-handlers";
import { scrubWebhookPayload } from "@/lib/logging/webhook-scrub";
import {
  razorpayPaymentCapturedEventSchema,
  razorpayPaymentFailedEventSchema,
  razorpayOrderPaidEventSchema,
  type RazorpayWebhookEnvelope,
} from "@/schemas/webhooks/razorpay";
import { razorpayClient } from "@/lib/payments/core/razorpay";
import { z } from "zod";

// Strict inner-entity schemas used to narrow optional envelope fields at the
// point of consumption (one per event family we actually process).
const refundEntitySchema = z.object({
  id: z.string(),
  payment_id: z.string(),
  amount: z.number(),
  currency: z.string().optional(),
  status: z.string(),
});

const disputeEntitySchema = z.object({
  id: z.string(),
  payment_id: z.string(),
  amount: z.number(),
  currency: z.string().optional(),
  reason_code: z.string().optional(),
  reason_description: z.string().optional(),
  status: z.string(),
  respond_by: z.number().nullable().optional(),
  deduct_at_onset: z.boolean().optional(),
});

const disputeUpdateEntitySchema = z.object({
  id: z.string(),
  status: z.string(),
});

const payoutEntitySchema = z.object({
  id: z.string(),
  status: z.string(),
  failure_reason: z.string().nullable().optional(),
  // A1+A8: bank-side UTR. Present on `payout.processed`; absent on
  // queued/initiated/pending. Plumbed through to OrganizationPayout.gatewayUtr.
  utr: z.string().nullable().optional(),
});

/**
 * Process a Razorpay webhook event. Called via the route's `after()` callback
 * AND by the stuck-webhook sweeper on replay. Errors are caught and recorded on
 * the WebhookEvent row (via markWebhookEventProcessed) for retry/observability.
 */
export async function processRazorpayWebhookEvent(
  event: RazorpayWebhookEnvelope,
  eventType: string,
  eventId: string,
): Promise<void> {
  // PII-scrub the payload before logging — Razorpay payloads can carry
  // payer email/phone/contact, partial card/UPI fingerprints, and any
  // `notes.*` fields the app populated (referrerEmail etc). See
  // lib/logging/webhook-scrub.ts for the redaction rules.
  console.log(`🔔 Razorpay Webhook Event: ${eventType}`, {
    eventId,
    payload: scrubWebhookPayload(event.payload),
  });
  Sentry.logger.info(Sentry.logger.fmt`razorpay dispatch: handling ${eventType}`, { eventId });

  let processingError: string | undefined;
  // #813/#812 — set when a handler DEFERS (event valid but its row not yet
  // written). On a defer we skip markWebhookEventProcessed so the row stays
  // processed=false/error=null for the stuck-event sweeper to re-drive.
  let deferred = false;

  try {
    switch (eventType) {
      case "payment.captured": {
        const capturedEvent = razorpayPaymentCapturedEventSchema.parse(event);
        const capturedNotes = capturedEvent.payload.payment.entity.notes ?? {};
        if (
          capturedNotes.type === "credit_purchase" ||
          capturedNotes.type === "invoice_payment"
        ) {
          await handleOrgPaymentSuccess(
            capturedNotes,
            capturedEvent.payload.payment.entity.id,
            capturedEvent.payload.payment.entity.amount,
          );
        } else if (capturedNotes.type === "overage_member") {
          // #775 — CHARGE_MEMBER overage side-charge (no appointment; routes
          // on the order id stamped at resume-checkout time).
          await handleOverageMemberSuccess(
            capturedEvent.payload.payment.entity.order_id,
          );
        } else {
          await handlePaymentSuccess(
            capturedEvent.payload.payment.entity.order_id,
            capturedNotes,
            capturedEvent.payload.payment.entity.amount,
          );
        }
        break;
      }

      case "order.paid": {
        const paidEvent = razorpayOrderPaidEventSchema.parse(event);
        const paidNotes = paidEvent.payload.order.entity.notes ?? {};
        if (
          paidNotes.type === "credit_purchase" ||
          paidNotes.type === "invoice_payment"
        ) {
          await handleOrgPaymentSuccess(paidNotes);
        } else if (paidNotes.type === "overage_member") {
          await handleOverageMemberSuccess(paidEvent.payload.order.entity.id);
        } else {
          await handlePaymentSuccess(
            paidEvent.payload.order.entity.id,
            paidNotes,
            paidEvent.payload.order.entity.amount,
          );
        }
        break;
      }

      case "payment.failed": {
        const failedEvent = razorpayPaymentFailedEventSchema.parse(event);
        const failedEntity = failedEvent.payload.payment.entity;
        const failedNotes = failedEntity.notes ?? {};
        // Org-level top-ups and invoice payments do NOT have a `Payment`
        // row (they live on WalletEntry / OrganizationInvoice), so the
        // legacy handlePaymentFailure would silently no-op for them.
        // Route by notes.type first; fall back to the B2C path.
        if (
          failedNotes.type === "credit_purchase" ||
          failedNotes.type === "invoice_payment"
        ) {
          await handleOrgPaymentFailure(failedNotes, failedEntity.id);
        } else if (failedNotes.type === "overage_member") {
          await handleOverageMemberFailure(failedEntity.order_id);
        } else {
          await handlePaymentFailure(failedEntity.order_id);
        }
        break;
      }

      // Refund events
      // FIX #5: Razorpay refunds use payment_id, but our DB stores order_id as
      // paymentIntent. Resolve payment_id → order_id via Razorpay API first.
      case "refund.created":
      case "refund.processed": {
        const refundEvent = refundEntitySchema.parse(
          event.payload?.refund?.entity,
        );
        let paymentIntentId = refundEvent.payment_id;

        if (razorpayClient) {
          try {
            const rzpPayment = await razorpayClient.payments.fetch(
              refundEvent.payment_id,
            );
            if (rzpPayment.order_id) {
              paymentIntentId = rzpPayment.order_id;
            }
          } catch (lookupError) {
            console.error(
              `Failed to resolve Razorpay payment_id ${refundEvent.payment_id} to order_id:`,
              lookupError,
            );
            Sentry.captureException(lookupError, {
              tags: { subsystem: "payments", provider: "razorpay" },
              contexts: { refund: { refundId: refundEvent.id, paymentId: refundEvent.payment_id } },
              level: "warning",
            });
          }
        }

        const refundResult = await handleRefundCreated(
          refundEvent.id,
          paymentIntentId,
          refundEvent.amount,
          refundEvent.currency || "INR",
          refundEvent.status,
          "RAZORPAY",
          refundEvent.payment_id,
        );
        if (refundResult instanceof DeferSignal) {
          deferred = true;
          console.log(
            `⏳ Deferring refund ${refundEvent.id} for re-drive: ${refundResult.reason}`,
          );
        }
        break;
      }

      case "refund.failed": {
        const failedRefundEvent = refundEntitySchema.parse(
          event.payload?.refund?.entity,
        );
        let failedPaymentIntentId = failedRefundEvent.payment_id;

        if (razorpayClient) {
          try {
            const rzpPayment = await razorpayClient.payments.fetch(
              failedRefundEvent.payment_id,
            );
            if (rzpPayment.order_id) {
              failedPaymentIntentId = rzpPayment.order_id;
            }
          } catch (lookupError) {
            console.error(
              `Failed to resolve Razorpay payment_id ${failedRefundEvent.payment_id} to order_id:`,
              lookupError,
            );
            Sentry.captureException(lookupError, {
              tags: { subsystem: "payments", provider: "razorpay" },
              contexts: { refund: { refundId: failedRefundEvent.id, paymentId: failedRefundEvent.payment_id } },
              level: "warning",
            });
          }
        }

        const failedRefundResult = await handleRefundCreated(
          failedRefundEvent.id,
          failedPaymentIntentId,
          failedRefundEvent.amount,
          failedRefundEvent.currency || "INR",
          "failed",
          "RAZORPAY",
          failedRefundEvent.payment_id,
        );
        if (failedRefundResult instanceof DeferSignal) {
          deferred = true;
          console.log(
            `⏳ Deferring refund ${failedRefundEvent.id} for re-drive: ${failedRefundResult.reason}`,
          );
        }
        break;
      }

      // L1 FIX: Handle refund.speed_changed (informational only)
      case "refund.speed_changed": {
        console.log(
          `📄 Refund speed changed: ${event.payload?.refund?.entity?.id}`,
        );
        break;
      }

      // Dispute events
      case "payment.dispute.created": {
        const disputeCreatedEvent = disputeEntitySchema.parse(
          event.payload?.dispute?.entity,
        );
        await handleDisputeCreated(
          disputeCreatedEvent.id,
          disputeCreatedEvent.payment_id,
          disputeCreatedEvent.amount,
          disputeCreatedEvent.currency || "INR",
          disputeCreatedEvent.reason_description ||
            disputeCreatedEvent.reason_code ||
            "unknown",
          disputeCreatedEvent.status,
          disputeCreatedEvent.respond_by ?? null,
          disputeCreatedEvent.deduct_at_onset === false,
          "RAZORPAY",
        );
        break;
      }

      // #789 — these two were dropped to `default`. under_review carries the
      // gateway moving evidence into review; action_required is the deadline
      // signal. Both must advance Dispute.status (mapDisputeStatus already maps
      // them: under_review → UNDER_REVIEW, action_required → NEEDS_RESPONSE).
      case "payment.dispute.under_review":
      case "payment.dispute.action_required": {
        const disputeProgressEvent = disputeUpdateEntitySchema.parse(
          event.payload?.dispute?.entity,
        );
        await handleDisputeUpdated(
          disputeProgressEvent.id,
          disputeProgressEvent.status,
          null,
        );
        break;
      }

      case "payment.dispute.won": {
        const disputeWonEvent = disputeUpdateEntitySchema.parse(
          event.payload?.dispute?.entity,
        );
        await handleDisputeUpdated(disputeWonEvent.id, "won", null);
        break;
      }

      case "payment.dispute.lost": {
        const disputeLostEvent = disputeUpdateEntitySchema.parse(
          event.payload?.dispute?.entity,
        );
        await handleDisputeUpdated(disputeLostEvent.id, "lost", null);
        break;
      }

      case "payment.dispute.closed": {
        const disputeClosedEvent = disputeUpdateEntitySchema.parse(
          event.payload?.dispute?.entity,
        );
        await handleDisputeUpdated(
          disputeClosedEvent.id,
          disputeClosedEvent.status,
          null,
        );
        break;
      }

      // RazorpayX Payout events. #789 — payout.failed was previously dropped to
      // `default` even though handleRazorpayPayoutWebhook + markOrgPayoutFailed
      // already handle it, leaving a failed org payout stuck in PROCESSING with
      // earnings unreleased; it is now routed alongside the other terminal events.
      case "payout.processed":
      case "payout.reversed":
      case "payout.rejected":
      case "payout.failed":
      case "payout.queued":
      case "payout.pending":
      case "payout.cancelled": {
        const payoutEvent = payoutEntitySchema.parse(
          event.payload?.payout?.entity,
        );
        await handleRazorpayPayoutWebhook(eventType, {
          id: payoutEvent.id,
          status: payoutEvent.status,
          failure_reason: payoutEvent.failure_reason ?? undefined,
          utr: payoutEvent.utr ?? undefined,
        });
        break;
      }

      default:
        console.log(`📄 Unhandled Razorpay event type: ${eventType}`);
    }
    Sentry.logger.info(Sentry.logger.fmt`razorpay dispatch: done ${eventType}`, { eventId, deferred });
  } catch (handlerError) {
    processingError =
      handlerError instanceof Error
        ? handlerError.message
        : String(handlerError);
    console.error(
      `Razorpay webhook processing error for ${eventId}:`,
      handlerError,
    );
    Sentry.captureException(handlerError, {
      tags: { subsystem: "payments", provider: "razorpay" },
      contexts: { dispatch: { eventType, eventId } },
    });
  } finally {
    // #813/#812 — on a defer, leave the row processed=false/error=null so the
    // stuck-event sweeper re-drives it once the awaited payment lands.
    if (!deferred) {
      await markWebhookEventProcessed(eventId, processingError);
    }
  }
}

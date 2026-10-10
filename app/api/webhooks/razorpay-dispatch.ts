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
import {
  handleRecordingPurchaseSuccess,
  handleRecordingPurchaseFailure,
} from "@/lib/payments/webhooks/recording-purchase";
import { scrubWebhookPayload } from "@/lib/logging/webhook-scrub";
import {
  razorpayPaymentCapturedEventSchema,
  razorpayPaymentFailedEventSchema,
  razorpayOrderPaidEventSchema,
  razorpayNotesSchema,
  fundAccountValidationEntitySchema,
  disputeUpdateEntitySchema,
  type RazorpayWebhookEnvelope,
} from "@/schemas/webhooks/razorpay";
import { handleFundAccountValidationWebhook } from "@/lib/payments/payouts/reverse-penny-drop";
import { getRazorpayClient } from "@/lib/payments/core/razorpay";
import prisma from "@/lib/prisma";
import { type WebhookClaim, permanentFailure } from "@/lib/webhooks/event-log";
import { reportSentryError } from "@/lib/observability/report";
import { z, ZodError } from "zod";

const refundEntitySchema = z.object({
  id: z.string(),
  payment_id: z.string(),
  amount: z.number(),
  currency: z.string().optional(),
  status: z.string(),
  notes: razorpayNotesSchema,
});

const disputeEntitySchema = z.object({
  id: z.string(),
  payment_id: z.string(),
  amount: z.number(),
  currency: z.string().optional(),
  reason_code: z.string().nullable().optional(),
  reason_description: z.string().nullable().optional(),
  status: z.string(),
  respond_by: z.number().nullable().optional(),
  deduct_at_onset: z.boolean().optional(),
});

const payoutEntitySchema = z.object({
  id: z.string(),
  status: z.string(),
  failure_reason: z.string().nullable().optional(),
  // Official RazorpayX docs mark top-level `failure_reason` as deprecated in
  // favor of `status_details: { description, source, reason }`.
  status_details: z
    .object({
      description: z.string().nullable().optional(),
      source: z.string().nullable().optional(),
      reason: z.string().nullable().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  // A1+A8: bank-side UTR. Present on `payout.processed`; absent on
  // queued/initiated/pending. Plumbed through to OrganizationPayout.gatewayUtr.
  utr: z.string().nullable().optional(),
  // #1846 N1 — our payout row id, sent as `reference_id` at creation. It
  // matches a consultant payout whose submit reply was lost.
  reference_id: z.string().nullable().optional(),
});

/**
 * Route a captured payment to the handler its `notes.type` selects.
 *
 * Extracted because there are now three callers — `payment.captured`,
 * `order.paid`, and the client-return path in
 * `app/api/checkout/verify-signature/route.ts` — and the routing MUST be
 * identical across all of them. Before #ADR-21 the verify-signature path had no
 * routing at all: it flipped `Payment.paymentStatus` to SUCCEEDED directly,
 * which made the later webhook hit `handlePaymentSuccess`'s already-SUCCEEDED
 * early-return and skip appointment confirmation, earnings, the
 * `booking:<paymentId>` journal entry and the capture-amount parity check.
 *
 * Every handler below is idempotent, so whichever caller arrives first does the
 * work and the others are no-ops.
 */
export async function routeCapturedPayment(params: {
  /** Razorpay order id — this is what `Payment.paymentIntent` stores. */
  orderId: string;
  /** `notes` from the Razorpay order/payment entity; selects the handler. */
  notes: Record<string, string>;
  /** Captured amount in paise, for the parity check. */
  amountPaise?: number;
  /**
   * Razorpay `pay_*` id. Present on `payment.captured`, on the client return
   * and on `order.paid` when its payment entity is shipped (#1582 F-P0-01);
   * absent, `handleOrgPaymentSuccess` refuses to mark an invoice PAID.
   */
  gatewayPaymentId?: string;
}): Promise<void> {
  const { orderId, notes, amountPaise, gatewayPaymentId } = params;

  // #1861 P4b — IDs only. `orderId` is what Payment.paymentIntent stores;
  // an internal Payment.id or appointmentId is not yet resolved at this
  // point in the pipeline (the handlers below look it up), so gatewayOrderId
  // is what's known here.
  Sentry.getCurrentScope().setTag("gatewayOrderId", orderId);

  if (notes.type === "credit_purchase" || notes.type === "invoice_payment") {
    // The org path only trusts an amount that came off a PAYMENT entity. On
    // `order.paid` the figure available is the order total, not what was
    // actually settled, so passing it could mark an invoice PAID on a partial
    // payment. Withholding it keeps the documented conservative behaviour in
    // handleOrgPaymentSuccess ("no payment id -> refuse to mark PAID").
    await handleOrgPaymentSuccess(
      notes,
      gatewayPaymentId,
      gatewayPaymentId ? amountPaise : undefined,
    );
    return;
  }
  if (notes.type === "overage_member") {
    // Settle only on gateway truth; withhold order total without a payment entity.
    await handleOverageMemberSuccess(
      orderId,
      gatewayPaymentId ? amountPaise : undefined,
      gatewayPaymentId,
    );
    return;
  }
  if (notes.type === "recording_purchase") {
    // #366 — standalone replay sale; not a Payment row, settled on its own
    // RecordingPurchase record (idempotent per gatewayOrderId). Withhold the
    // order total without a payment entity, like the org and overage rails.
    await handleRecordingPurchaseSuccess(
      orderId,
      gatewayPaymentId,
      notes,
      gatewayPaymentId ? amountPaise : undefined,
    );
    return;
  }
  // #1353 — the B2C pipeline persists the `pay_…` id on the Payment row it is
  // already the single writer of, so later refund and dispute webhooks (which
  // carry only that id) can find the row without a live gateway lookup.
  await handlePaymentSuccess(orderId, notes, amountPaise, gatewayPaymentId);
}

/**
 * Process a Razorpay webhook event. Called via the route's `after()` callback
 * AND by the stuck-webhook sweeper on replay. Errors are caught and recorded on
 * the WebhookEvent row (via markWebhookEventProcessed) for retry/observability.
 */
export async function processRazorpayWebhookEvent(
  event: RazorpayWebhookEnvelope,
  eventType: string,
  eventId: string,
  /** The live route's claim on the row; the sweeper re-drive passes none. */
  claim?: WebhookClaim,
): Promise<void> {
  // PII-scrub the payload before logging — Razorpay payloads can carry
  // payer email/phone/contact, partial card/UPI fingerprints, and any
  // `notes.*` fields the app populated (referrerEmail etc). See
  // lib/logging/webhook-scrub.ts for the redaction rules.
  console.log(`🔔 Razorpay Webhook Event: ${eventType}`, {
    eventId,
    payload: scrubWebhookPayload(event.payload),
  });
  Sentry.logger.info(
    Sentry.logger.fmt`razorpay dispatch: handling ${eventType}`,
    { eventId },
  );

  let processingError: string | undefined;
  // #813/#812 — set when a handler DEFERS (event valid but its row not yet
  // written). On a defer we skip markWebhookEventProcessed so the row stays
  // processed=false/error=null for the stuck-event sweeper to re-drive.
  let deferred = false;

  try {
    switch (eventType) {
      case "payment.captured": {
        const capturedEvent = razorpayPaymentCapturedEventSchema.parse(event);
        await routeCapturedPayment({
          orderId: capturedEvent.payload.payment.entity.order_id ?? "",
          notes: capturedEvent.payload.payment.entity.notes,
          amountPaise: capturedEvent.payload.payment.entity.amount,
          gatewayPaymentId: capturedEvent.payload.payment.entity.id,
        });
        break;
      }

      case "order.paid": {
        const paidEvent = razorpayOrderPaidEventSchema.parse(event);
        const paidEntity = paidEvent.payload.payment?.entity;
        await routeCapturedPayment({
          orderId: paidEvent.payload.order.entity.id,
          notes: paidEvent.payload.order.entity.notes,
          amountPaise: paidEntity?.amount,
          gatewayPaymentId: paidEntity?.id,
        });
        break;
      }

      case "payment.failed": {
        const failedEvent = razorpayPaymentFailedEventSchema.parse(event);
        const failedEntity = failedEvent.payload.payment.entity;
        const failedNotes = failedEntity.notes;
        const failedOrderId = failedEntity.order_id ?? "";
        if (
          failedNotes.type === "credit_purchase" ||
          failedNotes.type === "invoice_payment"
        ) {
          await handleOrgPaymentFailure(failedNotes, failedEntity.id);
        } else if (failedNotes.type === "overage_member") {
          await handleOverageMemberFailure(failedOrderId);
        } else if (failedNotes.type === "recording_purchase") {
          await handleRecordingPurchaseFailure(failedOrderId);
        } else {
          await handlePaymentFailure(
            failedOrderId,
            failedEntity.error_description ?? undefined,
            failedEntity.id,
          );
        }
        break;
      }

      case "refund.created":
      case "refund.processed": {
        const refundEvent = refundEntitySchema.parse(
          event.payload?.refund?.entity,
        );
        let paymentIntentId = refundEvent.payment_id;

        const knownPayment = await prisma.payment.findFirst({
          where: { gatewayPaymentId: refundEvent.payment_id },
          select: { paymentIntent: true },
        });
        const razorpayClient = knownPayment ? null : getRazorpayClient();
        if (knownPayment) {
          paymentIntentId = knownPayment.paymentIntent;
        }
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
              contexts: {
                refund: {
                  refundId: refundEvent.id,
                  paymentId: refundEvent.payment_id,
                },
              },
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
          refundEvent.payment_id,
          refundEvent.notes,
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

        const knownFailedPayment = await prisma.payment.findFirst({
          where: { gatewayPaymentId: failedRefundEvent.payment_id },
          select: { paymentIntent: true },
        });
        const razorpayClient = knownFailedPayment ? null : getRazorpayClient();
        if (knownFailedPayment) {
          failedPaymentIntentId = knownFailedPayment.paymentIntent;
        }
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
              contexts: {
                refund: {
                  refundId: failedRefundEvent.id,
                  paymentId: failedRefundEvent.payment_id,
                },
              },
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
          failedRefundEvent.payment_id,
          failedRefundEvent.notes,
        );
        if (failedRefundResult instanceof DeferSignal) {
          deferred = true;
          console.log(
            `⏳ Deferring refund ${failedRefundEvent.id} for re-drive: ${failedRefundResult.reason}`,
          );
        }
        break;
      }

      case "refund.speed_changed": {
        console.log(
          `📄 Refund speed changed: ${event.payload?.refund?.entity?.id}`,
        );
        break;
      }

      case "payment.dispute.created": {
        const disputeCreatedEvent = disputeEntitySchema.parse(
          event.payload?.dispute?.entity,
        );
        const createdResult = await handleDisputeCreated(
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
        );
        if (createdResult instanceof DeferSignal) {
          deferred = true;
        }
        break;
      }

      case "payment.dispute.under_review":
      case "payment.dispute.action_required": {
        const disputeProgressEvent = disputeUpdateEntitySchema.parse(
          event.payload?.dispute?.entity,
        );
        const disputeProgressResult =
          disputeProgressEvent.respond_by !== undefined &&
          disputeProgressEvent.respond_by !== null
            ? await handleDisputeUpdated(
                disputeProgressEvent.id,
                disputeProgressEvent.status,
                null,
                disputeProgressEvent.respond_by,
              )
            : await handleDisputeUpdated(
                disputeProgressEvent.id,
                disputeProgressEvent.status,
                null,
              );
        if (disputeProgressResult instanceof DeferSignal) {
          deferred = true;
        }
        break;
      }

      case "payment.dispute.won": {
        const disputeWonEvent = disputeUpdateEntitySchema.parse(
          event.payload?.dispute?.entity,
        );
        const disputeWonResult =
          disputeWonEvent.respond_by !== undefined &&
          disputeWonEvent.respond_by !== null
            ? await handleDisputeUpdated(
                disputeWonEvent.id,
                "won",
                null,
                disputeWonEvent.respond_by,
              )
            : await handleDisputeUpdated(disputeWonEvent.id, "won", null);
        if (disputeWonResult instanceof DeferSignal) {
          deferred = true;
        }
        break;
      }

      case "payment.dispute.lost": {
        const disputeLostEvent = disputeUpdateEntitySchema.parse(
          event.payload?.dispute?.entity,
        );
        const disputeLostResult =
          disputeLostEvent.respond_by !== undefined &&
          disputeLostEvent.respond_by !== null
            ? await handleDisputeUpdated(
                disputeLostEvent.id,
                "lost",
                null,
                disputeLostEvent.respond_by,
              )
            : await handleDisputeUpdated(disputeLostEvent.id, "lost", null);
        if (disputeLostResult instanceof DeferSignal) {
          deferred = true;
        }
        break;
      }

      case "payment.dispute.closed": {
        const disputeClosedEvent = disputeUpdateEntitySchema.parse(
          event.payload?.dispute?.entity,
        );
        const disputeClosedResult =
          disputeClosedEvent.respond_by !== undefined &&
          disputeClosedEvent.respond_by !== null
            ? await handleDisputeUpdated(
                disputeClosedEvent.id,
                disputeClosedEvent.status,
                null,
                disputeClosedEvent.respond_by,
              )
            : await handleDisputeUpdated(
                disputeClosedEvent.id,
                disputeClosedEvent.status,
                null,
              );
        if (disputeClosedResult instanceof DeferSignal) {
          deferred = true;
        }
        break;
      }

      case "payout.processed":
      case "payout.reversed":
      case "payout.rejected":
      case "payout.failed":
      case "payout.initiated":
      case "payout.updated":
      case "payout.queued":
      case "payout.pending":
      case "payout.cancelled": {
        const payoutEvent = payoutEntitySchema.parse(
          event.payload?.payout?.entity,
        );
        const failureReason =
          payoutEvent.failure_reason ??
          payoutEvent.status_details?.description ??
          payoutEvent.status_details?.reason ??
          undefined;
        await handleRazorpayPayoutWebhook(eventType, {
          id: payoutEvent.id,
          status: payoutEvent.status,
          failure_reason: failureReason,
          utr: payoutEvent.utr ?? undefined,
          reference_id: payoutEvent.reference_id ?? undefined,
        });
        break;
      }

      case "fund_account.validation.completed":
      case "fund_account.validation.failed": {
        const validationEntity = fundAccountValidationEntitySchema.parse(
          event.payload?.["fund_account.validation"]?.entity,
        );
        await handleFundAccountValidationWebhook(eventType, validationEntity);
        break;
      }

      default:
        console.log(`📄 Unhandled Razorpay event type: ${eventType}`);
    }
    Sentry.logger.info(
      Sentry.logger.fmt`razorpay dispatch: done ${eventType}`,
      { eventId, deferred },
    );
  } catch (handlerError) {
    if (handlerError instanceof ZodError) {
      const detail = handlerError.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      processingError = permanentFailure(
        `schema mismatch: ${eventType} — ${detail}`.slice(0, 500),
      );
      console.error(
        `Razorpay webhook ${eventId} is permanently unprocessable:`,
        detail,
      );
      reportSentryError(
        new Error(`Razorpay ${eventType} payload failed schema validation`),
        {
          subsystem: "payments",
          op: "razorpay.schema_mismatch",
          expected: true,
          level: "warning",
          tags: { provider: "razorpay" },
          contexts: { dispatch: { eventType, eventId, detail } },
        },
      );
    } else {
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
    }
  } finally {
    if (deferred) {
      await prisma.webhookEvent
        .updateMany({
          where: {
            eventId,
            processed: false,
            ...(claim ? { claimedAt: claim.claimedAt } : {}),
          },
          data: { deferCount: { increment: 1 } },
        })
        .catch(() => {});
    } else {
      await markWebhookEventProcessed(eventId, processingError, claim);
    }
  }
}

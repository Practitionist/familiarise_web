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
import {
  handleDigitalProductPurchaseSuccess,
  handleDigitalProductPurchaseFailure,
} from "@/lib/payments/webhooks/digital-product-purchase";
import { scrubWebhookPayload } from "@/lib/logging/webhook-scrub";
import {
  razorpayPaymentCapturedEventSchema,
  razorpayPaymentFailedEventSchema,
  razorpayOrderPaidEventSchema,
  razorpayNotesSchema,
  razorpayPayoutStatusDetailsSchema,
  razorpayPayoutErrorSchema,
  fundAccountValidationEntitySchema,
  disputeUpdateEntitySchema,
  type RazorpayWebhookEnvelope,
} from "@/schemas/webhooks/razorpay";
import { handleFundAccountValidationWebhook } from "@/lib/payments/payouts/reverse-penny-drop";
import {
  getRazorpayClient,
  withRazorpaySdkTimeout,
} from "@/lib/payments/core/razorpay";
import prisma from "@/lib/prisma";
import { postGatewayFee } from "@/lib/payments/ledger/gateway-fee";
import {
  recordPayerInstruments,
  type PayerInstrumentFields,
} from "@/lib/payments/payer-instruments";
import { type WebhookClaim, permanentFailure } from "@/lib/webhooks/event-log";
import { errorMessageOf, reportSentryError } from "@/lib/observability/report";
import { z, ZodError } from "zod";

const DISPUTE_EVENT_VERDICT: Partial<Record<string, string>> = {
  "payment.dispute.won": "won",
  "payment.dispute.lost": "lost",
};

const refundEntitySchema = z.object({
  id: z.string(),
  payment_id: z.string(),
  amount: z.number(),
  currency: z.string().optional(),
  status: z.string(),
  speed_requested: z.enum(["normal", "optimum"]).nullable().optional(),
  speed_processed: z
    .enum(["normal", "instant", "optimum"])
    .nullable()
    .optional(),
  notes: razorpayNotesSchema,
});

/** The payment entity a refund event may embed; `captured` is read only when it is there. */
const refundedPaymentEntitySchema = z
  .object({ captured: z.boolean().optional() })
  .passthrough();

const disputeEntitySchema = z.object({
  id: z.string(),
  payment_id: z.string(),
  amount: z.number(),
  currency: z.string().optional(),
  reason_code: z.string().nullable().optional(),
  reason_description: z.string().nullable().optional(),
  status: z.string(),
  respond_by: z.number().nullable().optional(),
  phase: z.string().nullable().optional(),
  deduct_at_onset: z.boolean().optional(),
});

const payoutEntitySchema = z.object({
  id: z.string(),
  status: z.string(),
  failure_reason: z.string().nullable().optional(),
  status_details: razorpayPayoutStatusDetailsSchema,
  error: razorpayPayoutErrorSchema,
  utr: z.string().nullable().optional(),
  reference_id: z.string().nullable().optional(),
});

function payloadFee(entity: {
  fee?: number | null;
  tax?: number | null;
}): { feePaise: number; taxPaise: number } | undefined {
  if (entity.fee === null || entity.fee === undefined) return undefined;
  return { feePaise: entity.fee, taxPaise: entity.tax ?? 0 };
}

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
  /** Razorpay's `method`; the standalone sale rails record it on their Payment. */
  method?: string;
  /** Gateway fee (GST included) and its GST, from the webhook's payment entity only. */
  fee?: { feePaise: number; taxPaise: number };
  /** The webhook payment entity's payer fields, hashed onto the Payment for the referral vest. */
  payer?: PayerInstrumentFields;
}): Promise<void> {
  await dispatchCapturedPayment(params);
  // Outside the capture transaction; the settlement job books it under the same key when absent.
  if (params.gatewayPaymentId && params.fee) {
    await postGatewayFee(prisma, {
      gatewayPaymentId: params.gatewayPaymentId,
      ...params.fee,
    });
  }
  if (params.gatewayPaymentId && params.payer) {
    await recordPayerInstruments(prisma, params.gatewayPaymentId, params.payer);
  }
}

async function dispatchCapturedPayment(params: {
  orderId: string;
  notes: Record<string, string>;
  amountPaise?: number;
  gatewayPaymentId?: string;
  method?: string;
}): Promise<void> {
  const { orderId, notes, amountPaise, gatewayPaymentId, method } = params;

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
      method,
    );
    return;
  }
  if (notes.type === "digital_product_purchase") {
    // Settled on its own DigitalProductPurchase row; withhold the order total without a payment entity.
    await handleDigitalProductPurchaseSuccess(
      orderId,
      gatewayPaymentId,
      notes,
      gatewayPaymentId ? amountPaise : undefined,
      method,
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
        const capturedEntity = capturedEvent.payload.payment.entity;
        await routeCapturedPayment({
          orderId: capturedEntity.order_id ?? "",
          notes: capturedEntity.notes,
          amountPaise: capturedEntity.amount,
          gatewayPaymentId: capturedEntity.id,
          method: capturedEntity.method,
          fee: payloadFee(capturedEntity),
          payer: capturedEntity,
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
          method: paidEntity?.method,
          fee: paidEntity ? payloadFee(paidEntity) : undefined,
          payer: paidEntity,
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
        } else if (failedNotes.type === "digital_product_purchase") {
          await handleDigitalProductPurchaseFailure(failedOrderId);
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
        const embeddedOrderId =
          event.payload?.payment?.entity?.order_id ?? undefined;
        const embeddedPayment = refundedPaymentEntitySchema.safeParse(
          event.payload?.payment?.entity,
        );
        let paymentIntentId = embeddedOrderId ?? refundEvent.payment_id;

        const knownPayment = embeddedOrderId
          ? null
          : await prisma.payment.findFirst({
              where: { gatewayPaymentId: refundEvent.payment_id },
              select: { paymentIntent: true },
            });
        const razorpayClient =
          embeddedOrderId || knownPayment ? null : getRazorpayClient();
        if (knownPayment) {
          paymentIntentId = knownPayment.paymentIntent;
        }
        if (razorpayClient) {
          try {
            const rzpPayment = await withRazorpaySdkTimeout(
              "payments.fetch",
              () => razorpayClient.payments.fetch(refundEvent.payment_id),
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
          embeddedPayment.success ? embeddedPayment.data.captured : undefined,
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
            const rzpPayment = await withRazorpaySdkTimeout(
              "payments.fetch",
              () => razorpayClient.payments.fetch(failedRefundEvent.payment_id),
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
        const speedEvent = refundEntitySchema.parse(
          event.payload?.refund?.entity,
        );
        const existingRefund = await prisma.refund.findFirst({
          where: { refundId: speedEvent.id },
          select: { id: true, status: true, metadata: true },
        });
        if (!existingRefund) {
          deferred = true;
          break;
        }
        const prevMeta =
          existingRefund.metadata &&
          typeof existingRefund.metadata === "object" &&
          !Array.isArray(existingRefund.metadata)
            ? existingRefund.metadata
            : {};
        await prisma.refund.updateMany({
          where: { id: existingRefund.id, status: existingRefund.status },
          data: {
            metadata: {
              ...prevMeta,
              speedRequested: speedEvent.speed_requested ?? null,
              speedProcessed: speedEvent.speed_processed ?? null,
            },
          },
        });
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
          {
            isRedrive: !claim,
            phase: disputeCreatedEvent.phase ?? null,
            webhookEventId: eventId,
          },
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
        const disputeProgressResult = await handleDisputeUpdated(
          disputeProgressEvent.id,
          disputeProgressEvent.status,
          null,
          disputeProgressEvent.respond_by ?? null,
          null,
          disputeProgressEvent.phase ?? null,
          eventId,
        );
        if (disputeProgressResult instanceof DeferSignal) {
          deferred = true;
        }
        break;
      }

      case "payment.dispute.won":
      case "payment.dispute.lost":
      case "payment.dispute.closed": {
        const verdictEvent = disputeUpdateEntitySchema.parse(
          event.payload?.dispute?.entity,
        );
        // won/lost are the event's verdict; closed carries its own entity status.
        const verdictStatus =
          DISPUTE_EVENT_VERDICT[eventType] ?? verdictEvent.status;
        const verdictResult = await handleDisputeUpdated(
          verdictEvent.id,
          verdictStatus,
          null,
          verdictEvent.respond_by ?? null,
          verdictEvent.amount_deducted ?? null,
          verdictEvent.phase ?? null,
          eventId,
        );
        if (verdictResult instanceof DeferSignal) {
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
          payoutEvent.error?.description ??
          payoutEvent.error?.reason ??
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

      case "settlement.processed": {
        const settlementEntity = event.payload?.settlement?.entity;
        console.log("Razorpay settlement processed", {
          settlementId: settlementEntity?.id,
          amount: settlementEntity?.amount,
          utr: settlementEntity?.utr,
        });
        break;
      }

      case "fund_account.validation.completed":
      case "fund_account.validation.failed": {
        const validationEntity = fundAccountValidationEntitySchema.parse(
          event.payload?.["fund_account.validation"]?.entity,
        );
        const validationResult = await handleFundAccountValidationWebhook(
          eventType,
          validationEntity,
        );
        if (validationResult === "deferred") {
          deferred = true;
        }
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
      processingError = errorMessageOf(handlerError);
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

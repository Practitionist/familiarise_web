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
  gatewayPaymentTime,
  razorpayWebhookEnvelopeSchema,
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
import {
  errorMessageOf,
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import {
  railNamedByNotes,
  resolveCaptureRail,
  type CaptureRail,
} from "@/lib/payments/webhooks/capture-rail";
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
  speed_requested: z.string().nullable().optional(),
  speed_processed: z.string().nullable().optional(),
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
 * The rail an order belongs to: its own row decides. Notes are a cross-check
 * against that row, and select a rail only for an order no row names (a
 * purchase deleted since, an invoice whose order was replaced or cleared).
 */
async function captureRailFor(
  orderId: string,
  notes: Record<string, string>,
): Promise<CaptureRail> {
  const byRows = await resolveCaptureRail(prisma, orderId);
  const claimed = railNamedByNotes(notes);
  if (byRows.rail === "unknown") {
    if (claimed === "wallet_top_up" || claimed === "org_invoice") {
      return { rail: claimed, notes };
    }
    return { rail: claimed ?? "booking" };
  }
  // A replaced overage order's tombstone is a parentless Payment row: the
  // booking writer refunds it as a late capture, so that pairing is no conflict.
  const replacedOverageOrder =
    byRows.rail === "booking" && claimed === "overage";
  if (claimed && claimed !== byRows.rail && !replacedOverageOrder) {
    reportSentryMessage(
      "Gateway notes name a different rail than the order's row",
      {
        subsystem: "payments",
        op: "razorpay.capture_rail",
        level: "warning",
        expected: true,
        extra: { orderId, rowRail: byRows.rail, notesRail: claimed },
      },
    );
  }
  return byRows;
}

/**
 * Route a captured payment to the handler of the rail its order belongs to.
 * Every door calls this (both capture webhooks, the two client-return routes,
 * the top-up verify route and the reconcile sweeps), so the routing is the
 * same wherever a capture is first seen. Every handler is idempotent:
 * whichever caller arrives first does the work and the others are no-ops.
 */
export async function routeCapturedPayment(params: {
  /** Razorpay order id — this is what `Payment.paymentIntent` stores. */
  orderId: string;
  /** `notes` from the Razorpay order or payment entity; the booking and standalone-sale handlers read them, the rail does not. */
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
  /** The gateway's own time for the payment; a seat hold still live then is honoured. */
  gatewayCapturedAt?: Date;
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
  gatewayCapturedAt?: Date;
}): Promise<void> {
  const { orderId, notes, amountPaise, gatewayPaymentId, method } = params;
  const { gatewayCapturedAt } = params;

  // #1861 P4b — IDs only. `orderId` is what Payment.paymentIntent stores;
  // an internal Payment.id or appointmentId is not yet resolved at this
  // point in the pipeline (the handlers below look it up), so gatewayOrderId
  // is what's known here.
  Sentry.getCurrentScope().setTag("gatewayOrderId", orderId);

  const rail = await captureRailFor(orderId, notes);
  // No rail settles on an order total: without a payment entity the amount is withheld.
  const capturedPaise = gatewayPaymentId ? amountPaise : undefined;
  switch (rail.rail) {
    case "wallet_top_up":
    case "org_invoice":
      await handleOrgPaymentSuccess(
        rail.notes,
        gatewayPaymentId,
        capturedPaise,
      );
      return;
    case "overage":
      await handleOverageMemberSuccess(
        orderId,
        capturedPaise,
        gatewayPaymentId,
      );
      return;
    case "recording_purchase":
      await handleRecordingPurchaseSuccess(
        orderId,
        gatewayPaymentId,
        notes,
        capturedPaise,
        method,
      );
      return;
    case "digital_product_purchase":
      await handleDigitalProductPurchaseSuccess(
        orderId,
        gatewayPaymentId,
        notes,
        capturedPaise,
        method,
      );
      return;
    default:
      // The booking pipeline stores the `pay_` id on the Payment row it confirms.
      await (gatewayCapturedAt
        ? handlePaymentSuccess(orderId, notes, amountPaise, gatewayPaymentId, {
            gatewayCapturedAt,
          })
        : handlePaymentSuccess(orderId, notes, amountPaise, gatewayPaymentId));
  }
}

/** Events that move or describe money: a shape the handlers cannot read is retried before it is given up. */
const MONEY_EVENT_PREFIXES = [
  "payment.",
  "order.",
  "refund.",
  "payout.",
  "fund_account.validation.",
];

/** How long after receipt a money event with an unreadable shape stays retryable. */
const SCHEMA_MISMATCH_RETRY_MS = 24 * 3_600_000;

/**
 * Process a stored Razorpay webhook event. Called via the route's `after()`
 * callback and by the stuck-webhook sweeper on replay. The event arrives as
 * stored, unvalidated; every parse happens here, and a failure is recorded on
 * the WebhookEvent row (via markWebhookEventProcessed), never thrown.
 */
export async function processRazorpayWebhookEvent(
  rawEvent: unknown,
  eventType: string,
  eventId: string,
  /** The caller's claim on the row. */
  claim?: WebhookClaim,
  /** When the row was first stored; absent on the delivery that stored it. */
  receivedAt?: Date,
): Promise<void> {
  // PII-scrub the payload before logging — Razorpay payloads can carry
  // payer email/phone/contact, partial card/UPI fingerprints, and any
  // `notes.*` fields the app populated (referrerEmail etc). See
  // lib/logging/webhook-scrub.ts for the redaction rules.
  console.log(`🔔 Razorpay Webhook Event: ${eventType}`, {
    eventId,
    event: scrubWebhookPayload(rawEvent),
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
    const event = razorpayWebhookEnvelopeSchema.parse(rawEvent);
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
          gatewayCapturedAt: gatewayPaymentTime(capturedEntity.created_at),
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
          gatewayCapturedAt: gatewayPaymentTime(paidEntity?.created_at),
          fee: paidEntity ? payloadFee(paidEntity) : undefined,
          payer: paidEntity,
        });
        break;
      }

      case "payment.failed": {
        const failedEvent = razorpayPaymentFailedEventSchema.parse(event);
        const failedEntity = failedEvent.payload.payment.entity;
        const failedOrderId = failedEntity.order_id ?? "";
        const failedRail = await captureRailFor(
          failedOrderId,
          failedEntity.notes,
        );
        switch (failedRail.rail) {
          case "wallet_top_up":
          case "org_invoice":
            await handleOrgPaymentFailure(failedRail.notes, failedEntity.id);
            break;
          case "overage":
            await handleOverageMemberFailure(failedOrderId);
            break;
          case "recording_purchase":
            await handleRecordingPurchaseFailure(failedOrderId);
            break;
          case "digital_product_purchase":
            await handleDigitalProductPurchaseFailure(failedOrderId);
            break;
          default:
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
      const mismatch = `schema mismatch: ${eventType} — ${detail}`.slice(
        0,
        500,
      );
      // A money event stays in the sweeper's queue for a bounded time, so a
      // decoder deployed inside it imports the event with no operator step.
      const retryable =
        MONEY_EVENT_PREFIXES.some((prefix) => eventType.startsWith(prefix)) &&
        Date.now() - (receivedAt?.getTime() ?? Date.now()) <
          SCHEMA_MISMATCH_RETRY_MS;
      processingError = retryable ? mismatch : permanentFailure(mismatch);
      console.error(
        `Razorpay webhook ${eventId} failed schema validation (${retryable ? "retryable" : "permanent"}):`,
        detail,
      );
      // Once when first met and once when given up; the sweeper's own run
      // report covers the re-drives in between.
      if (!retryable || !receivedAt) {
        reportSentryError(
          new Error(`Razorpay ${eventType} payload failed schema validation`),
          {
            subsystem: "payments",
            op: "razorpay.schema_mismatch",
            expected: true,
            level: "warning",
            tags: { provider: "razorpay", permanent: String(!retryable) },
            contexts: { dispatch: { eventType, eventId, detail } },
          },
        );
      }
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

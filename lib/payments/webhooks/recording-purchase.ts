/**
 * Replay purchase webhook settlement.
 *
 * A capture settles its RecordingPurchase (PENDING, or FAILED when the buyer
 * retried the same order) to SUCCEEDED with the Payment, earnings and BOOKING
 * journal in one transaction. A capture that cannot fulfil a purchase (the
 * replay is no longer purchasable, the buyer already holds it, or a second
 * payment on a settled order, or a purchase row deleted with its recording) is
 * recorded as a SUCCEEDED Payment carrying the auto-refund marker and refunded
 * after commit; retry-auto-refunds re-drives it.
 */
import { z } from "zod";
import prisma, { type Tx } from "@/lib/prisma";
import {
  createEarningsFromPayment,
  type CreateEarningsParams,
} from "@/lib/payments/payouts/earnings-service";
import type { AppointmentType } from "@/lib/payments/payouts/constants";
import { mintConsumerInvoiceBestEffort } from "@/lib/payments/billing/consumer-invoice";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import { postUnappliedReceipt } from "@/lib/payments/ledger/unapplied-receipts";
import {
  AUTO_REFUND_PENDING_PREFIX,
  AUTO_REFUND_STUCK_PREFIX,
  AUTO_REFUNDED_PREFIX,
  REPLAY_SALE_PREFIX,
  settledAutoRefundDescription,
} from "@/lib/payments/webhooks/auto-refund-marker";
import { isDurablyOurs } from "@/lib/stream/recording-storage";
import { reportSentryError } from "@/lib/observability/report";
import * as Sentry from "@sentry/nextjs";

const paiseNote = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().safe());

/** The notes a replay order is minted with; the capture reads them back. */
export const replayChargeNotesSchema = z.object({
  type: z.literal("recording_purchase"),
  recordingId: z.string().min(1),
  userId: z.string().min(1),
  originalAmountPaise: paiseNote,
  taxAmountPaise: paiseNote,
  buyerCountry: z.string().length(2),
});
const chargeSplitSchema = replayChargeNotesSchema.pick({
  originalAmountPaise: true,
  taxAmountPaise: true,
  buyerCountry: true,
});
const replayBuyerSchema = replayChargeNotesSchema.pick({ userId: true });

interface ReplayCharge {
  originalAmount: number;
  taxAmount: number;
  buyerCountry: string | null;
}

/**
 * The tax split the mint stamped on the order notes. An order minted before
 * replays were taxed carries none and settles untaxed, as it was charged.
 */
function resolveReplayCharge(
  orderId: string,
  chargedPaise: number,
  notes: Record<string, string> | undefined,
): ReplayCharge {
  const parsed = chargeSplitSchema.safeParse(notes ?? {});
  if (
    parsed.success &&
    parsed.data.originalAmountPaise + parsed.data.taxAmountPaise ===
      chargedPaise
  ) {
    return {
      originalAmount: parsed.data.originalAmountPaise,
      taxAmount: parsed.data.taxAmountPaise,
      buyerCountry: parsed.data.buyerCountry.toUpperCase(),
    };
  }
  if (notes?.taxAmountPaise !== undefined) {
    Sentry.captureMessage(
      `[recording-purchase] order notes do not sum to the charge: ${orderId}`,
      { level: "error", tags: { subsystem: "payments" } },
    );
  }
  return { originalAmount: chargedPaise, taxAmount: 0, buyerCountry: null };
}

interface ResolvedPurchasePlanInfo {
  consultantProfileId: string;
  appointmentType: AppointmentType;
  webinarPlanId: string | null;
  classPlanId: string | null;
  organizationId: string | null;
}

function resolvePurchasePlanInfo(purchase: {
  recording?: {
    organizationId?: string | null;
    meeting?: {
      occurrence?: {
        appointment?: {
          organizationId?: string | null;
          webinar?: {
            webinarPlanId?: string;
            webinarPlan?: {
              id: string;
              consultantProfileId: string | null;
              organizationId?: string | null;
            } | null;
          } | null;
          class?: {
            classPlanId?: string;
            classPlan?: {
              id: string;
              consultantProfileId: string | null;
              organizationId?: string | null;
            } | null;
          } | null;
          consultation?: {
            consultationPlan?: {
              id: string;
              consultantProfileId: string | null;
            } | null;
          } | null;
          subscription?: {
            subscriptionPlan?: {
              id: string;
              consultantProfileId: string | null;
            } | null;
          } | null;
        } | null;
      } | null;
    } | null;
  } | null;
}): ResolvedPurchasePlanInfo | null {
  const recording = purchase.recording;
  const appointment = recording?.meeting?.occurrence?.appointment;
  if (!appointment) return null;

  const fallbackOrgId =
    appointment.organizationId ?? recording?.organizationId ?? null;

  const webinarPlan = appointment.webinar?.webinarPlan;
  if (webinarPlan?.consultantProfileId) {
    return {
      consultantProfileId: webinarPlan.consultantProfileId,
      appointmentType: "WEBINAR",
      webinarPlanId: appointment.webinar?.webinarPlanId ?? webinarPlan.id,
      classPlanId: null,
      organizationId: webinarPlan.organizationId ?? fallbackOrgId,
    };
  }

  const classPlan = appointment.class?.classPlan;
  if (classPlan?.consultantProfileId) {
    return {
      consultantProfileId: classPlan.consultantProfileId,
      appointmentType: "CLASS",
      webinarPlanId: null,
      classPlanId: appointment.class?.classPlanId ?? classPlan.id,
      organizationId: classPlan.organizationId ?? fallbackOrgId,
    };
  }

  if (appointment.consultation?.consultationPlan?.consultantProfileId) {
    return {
      consultantProfileId:
        appointment.consultation.consultationPlan.consultantProfileId,
      appointmentType: "CONSULTATION",
      webinarPlanId: null,
      classPlanId: null,
      organizationId: fallbackOrgId,
    };
  }

  if (appointment.subscription?.subscriptionPlan?.consultantProfileId) {
    return {
      consultantProfileId:
        appointment.subscription.subscriptionPlan.consultantProfileId,
      appointmentType: "SUBSCRIPTION",
      webinarPlanId: null,
      classPlanId: null,
      organizationId: fallbackOrgId,
    };
  }

  return null;
}

const AUTO_REFUND_MARKERS = [
  AUTO_REFUND_PENDING_PREFIX,
  AUTO_REFUNDED_PREFIX,
  AUTO_REFUND_STUCK_PREFIX,
];

type CaptureOutcome =
  | { kind: "settled"; paymentId: string }
  | { kind: "refund"; paymentId: string; reason: string; marker: string };

/** The leg trigger rejects a positive Payment without legs at commit. */
function cardLeg(amountPaise: number, paymentIntent: string) {
  return {
    create: { source: "CARD" as const, amountPaise, sourceRef: paymentIntent },
  };
}

/**
 * Record a capture that fulfils nothing as a SUCCEEDED Payment carrying the
 * auto-refund marker. A row already staged for the intent is re-driven only
 * while its marker is still pending.
 */
async function stageCaptureRefund(
  tx: Tx,
  input: {
    paymentIntent: string;
    buyerId: string;
    chargedPaise: number;
    charge: ReplayCharge;
    organizationId: string | null;
    gatewayPaymentId: string | undefined;
    reason: string;
  },
): Promise<CaptureOutcome | null> {
  const marker = `${AUTO_REFUND_PENDING_PREFIX} ${input.reason}. Replay NOT granted.`;
  const existing = await tx.payment.findUnique({
    where: { paymentIntent: input.paymentIntent },
    select: { id: true, description: true, amount: true },
  });
  if (existing) {
    if (!existing.description?.startsWith(AUTO_REFUND_PENDING_PREFIX)) {
      return null;
    }
    await postUnappliedReceipt(tx, {
      paymentId: existing.id,
      capturedPaise: existing.amount,
    });
    return {
      kind: "refund",
      paymentId: existing.id,
      reason: input.reason,
      marker: existing.description,
    };
  }
  const created = await tx.payment.create({
    data: {
      userId: input.buyerId,
      appointmentId: null,
      amount: input.chargedPaise,
      originalAmount: input.charge.originalAmount,
      taxAmount: input.charge.taxAmount,
      currency: "INR",
      paymentMethod: "CARD",
      paymentIntent: input.paymentIntent,
      paymentGateway: "RAZORPAY",
      paymentStatus: "SUCCEEDED",
      capturedAt: new Date(),
      description: marker,
      organizationId: input.organizationId,
      legs: cardLeg(input.chargedPaise, input.paymentIntent),
      ...(input.gatewayPaymentId
        ? { gatewayPaymentId: input.gatewayPaymentId }
        : {}),
    },
    select: { id: true },
  });
  await postUnappliedReceipt(tx, {
    paymentId: created.id,
    capturedPaise: input.chargedPaise,
  });
  return {
    kind: "refund",
    paymentId: created.id,
    reason: input.reason,
    marker,
  };
}

/**
 * Refund a capture whose purchase row is gone (deleted with its recording) to
 * the buyer the order notes name. Without a captured amount or a live buyer
 * there is nothing to stage a refund on, and the caller's alert is the record.
 */
async function refundOrphanCapture(
  tx: Tx,
  input: {
    orderId: string;
    gatewayPaymentId: string | undefined;
    notes: Record<string, string> | undefined;
    capturedPaise: number | undefined;
  },
): Promise<CaptureOutcome | null> {
  const { orderId, capturedPaise } = input;
  const buyer = replayBuyerSchema.safeParse(input.notes ?? {});
  if (
    !buyer.success ||
    capturedPaise === undefined ||
    !Number.isSafeInteger(capturedPaise) ||
    capturedPaise <= 0
  ) {
    return null;
  }
  const buyerRow = await tx.user.findUnique({
    where: { id: buyer.data.userId },
    select: { id: true },
  });
  if (!buyerRow) return null;
  return stageCaptureRefund(tx, {
    paymentIntent: orderId,
    buyerId: buyerRow.id,
    chargedPaise: capturedPaise,
    charge: resolveReplayCharge(orderId, capturedPaise, input.notes),
    organizationId: null,
    gatewayPaymentId: input.gatewayPaymentId,
    reason: `capture on replay order ${orderId}; its purchase no longer exists`,
  });
}

/**
 * Whether a capture on a settled order is a second payment. An order settled
 * without a payment id takes the first id seen as its settling capture.
 */
async function isDuplicateCapture(
  tx: Tx,
  input: {
    purchaseId: string;
    settledBy: string | null;
    orderId: string;
    gatewayPaymentId: string;
  },
): Promise<boolean> {
  const { purchaseId, orderId, gatewayPaymentId } = input;
  let settledBy = input.settledBy;
  if (!settledBy) {
    const stamped = await tx.recordingPurchase.updateMany({
      where: { id: purchaseId, gatewayPaymentId: null },
      data: { gatewayPaymentId },
    });
    if (stamped.count === 1) {
      await tx.payment.updateMany({
        where: { paymentIntent: orderId, gatewayPaymentId: null },
        data: { gatewayPaymentId },
      });
      return false;
    }
    const current = await tx.recordingPurchase.findUnique({
      where: { id: purchaseId },
      select: { gatewayPaymentId: true },
    });
    settledBy = current?.gatewayPaymentId ?? null;
  }
  // Same payment redelivered; a different one is a duplicate charge.
  return settledBy !== gatewayPaymentId;
}

/** Settle a claimed purchase: its Payment, CARD leg, earnings and journal. */
async function settleReplaySale(
  tx: Tx,
  input: {
    orderPayment: Omit<CreateEarningsParams["payment"], "appointment"> | null;
    buyerId: string;
    recordingId: string;
    orderId: string;
    gatewayPaymentId: string | undefined;
    chargedPaise: number;
    charge: ReplayCharge;
    organizationId: string | null;
    planInfo: ResolvedPurchasePlanInfo | null;
  },
): Promise<CaptureOutcome> {
  const {
    orderPayment,
    orderId,
    gatewayPaymentId,
    chargedPaise,
    charge,
    organizationId,
    planInfo,
  } = input;
  const payment =
    orderPayment ??
    (await tx.payment.create({
      data: {
        userId: input.buyerId,
        appointmentId: null,
        amount: chargedPaise,
        originalAmount: charge.originalAmount,
        taxAmount: charge.taxAmount,
        ...(charge.buyerCountry
          ? {
              buyerCountry: charge.buyerCountry,
              isInternational: charge.buyerCountry !== "IN",
            }
          : {}),
        currency: "INR",
        paymentMethod: "CARD",
        paymentIntent: orderId,
        paymentGateway: "RAZORPAY",
        paymentStatus: "SUCCEEDED",
        capturedAt: new Date(),
        description: `${REPLAY_SALE_PREFIX} recording ${input.recordingId}`,
        organizationId,
        legs: cardLeg(chargedPaise, orderId),
        ...(gatewayPaymentId ? { gatewayPaymentId } : {}),
      },
    }));

  if (!planInfo) {
    Sentry.captureMessage(
      `[recording-purchase] settled without earnings owner: ${orderId}`,
      { level: "error", tags: { subsystem: "payments" } },
    );
    return { kind: "settled", paymentId: payment.id };
  }

  await createEarningsFromPayment({
    payment: {
      ...payment,
      appointment: {
        consultantProfile: { id: planInfo.consultantProfileId },
        webinar: planInfo.webinarPlanId
          ? { webinarPlanId: planInfo.webinarPlanId }
          : null,
        class: planInfo.classPlanId
          ? { classPlanId: planInfo.classPlanId }
          : null,
      },
    },
    appointmentType: planInfo.appointmentType,
    tx,
  });
  return { kind: "settled", paymentId: payment.id };
}

export async function handleRecordingPurchaseSuccess(
  orderId: string,
  gatewayPaymentId?: string,
  notes?: Record<string, string>,
  /** Captured paise from the payment entity; the purchase amount when absent. */
  capturedPaise?: number,
): Promise<void> {
  const outcome = await prisma.$transaction(
    async (tx): Promise<CaptureOutcome | null> => {
      const purchase = await tx.recordingPurchase.findUnique({
        where: { gatewayOrderId: orderId },
        select: {
          id: true,
          recordingId: true,
          buyerId: true,
          amountPaise: true,
          status: true,
          gatewayPaymentId: true,
          recording: {
            select: {
              id: true,
              organizationId: true,
              listingStatus: true,
              status: true,
              storageType: true,
              meeting: {
                select: {
                  occurrence: {
                    select: {
                      appointment: {
                        select: {
                          organizationId: true,
                          webinar: {
                            select: {
                              webinarPlanId: true,
                              webinarPlan: {
                                select: {
                                  id: true,
                                  consultantProfileId: true,
                                  organizationId: true,
                                },
                              },
                            },
                          },
                          class: {
                            select: {
                              classPlanId: true,
                              classPlan: {
                                select: {
                                  id: true,
                                  consultantProfileId: true,
                                  organizationId: true,
                                },
                              },
                            },
                          },
                          consultation: {
                            select: {
                              consultationPlan: {
                                select: {
                                  id: true,
                                  consultantProfileId: true,
                                },
                              },
                            },
                          },
                          subscription: {
                            select: {
                              subscriptionPlan: {
                                select: {
                                  id: true,
                                  consultantProfileId: true,
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!purchase) {
        console.error(
          `[recording-purchase] captured order ${orderId} has no RecordingPurchase row`,
        );
        Sentry.captureMessage(
          `[recording-purchase] captured order without row: ${orderId}`,
          { level: "error", tags: { subsystem: "payments" } },
        );
        return refundOrphanCapture(tx, {
          orderId,
          gatewayPaymentId,
          notes,
          capturedPaise,
        });
      }

      const chargedPaise = capturedPaise ?? Number(purchase.amountPaise);
      if (!Number.isSafeInteger(chargedPaise) || chargedPaise <= 0) {
        throw new Error(
          `[recording-purchase] invalid charged amount for order ${orderId}`,
        );
      }
      const charge = resolveReplayCharge(orderId, chargedPaise, notes);
      const planInfo = resolvePurchasePlanInfo(purchase);
      const organizationId =
        planInfo?.organizationId ?? purchase.recording?.organizationId ?? null;
      const refundCapture = (paymentIntent: string, reason: string) =>
        stageCaptureRefund(tx, {
          paymentIntent,
          buyerId: purchase.buyerId,
          chargedPaise,
          charge,
          organizationId,
          gatewayPaymentId,
          reason,
        });

      if (purchase.status === "SUCCEEDED" || purchase.status === "REFUNDED") {
        if (!gatewayPaymentId) return null;
        const duplicate = await isDuplicateCapture(tx, {
          purchaseId: purchase.id,
          settledBy: purchase.gatewayPaymentId,
          orderId,
          gatewayPaymentId,
        });
        return duplicate
          ? refundCapture(
              gatewayPaymentId,
              `duplicate capture on settled replay order ${orderId}`,
            )
          : null;
      }

      const orderPayment = await tx.payment.findUnique({
        where: { paymentIntent: orderId },
      });
      // A refund already staged for this order is final; never grant over it.
      if (
        AUTO_REFUND_MARKERS.some((prefix) =>
          orderPayment?.description?.startsWith(prefix),
        )
      ) {
        return refundCapture(
          orderId,
          `late capture on replay order ${orderId}`,
        );
      }

      const recording = purchase.recording;
      if (
        purchase.status === "FAILED" &&
        (recording?.listingStatus !== "PUBLISHED" || !isDurablyOurs(recording))
      ) {
        return refundCapture(
          orderId,
          `late capture on replay order ${orderId}; the replay is no longer purchasable`,
        );
      }

      const entitled = await tx.recordingPurchase.findFirst({
        where: {
          recordingId: purchase.recordingId,
          buyerId: purchase.buyerId,
          status: "SUCCEEDED",
          id: { not: purchase.id },
        },
        select: { id: true },
      });
      if (entitled) {
        return refundCapture(
          orderId,
          `capture on replay order ${orderId}; the buyer already holds this replay`,
        );
      }

      // Expected prior status in WHERE: PENDING, or FAILED for a late retry.
      const claimed = await tx.recordingPurchase.updateMany({
        where: { id: purchase.id, status: purchase.status },
        data: {
          status: "SUCCEEDED",
          ...(gatewayPaymentId ? { gatewayPaymentId } : {}),
        },
      });
      if (claimed.count === 0) return null;

      return settleReplaySale(tx, {
        orderPayment,
        buyerId: purchase.buyerId,
        recordingId: purchase.recordingId,
        orderId,
        gatewayPaymentId,
        chargedPaise,
        charge,
        organizationId,
        planInfo,
      });
    },
  );

  if (!outcome) return;
  // Post-commit and best effort, exactly as the booking confirmation mints it.
  if (outcome.kind === "settled") {
    await mintConsumerInvoiceBestEffort({ paymentId: outcome.paymentId });
    return;
  }
  try {
    await refundBookingPayment({
      paymentId: outcome.paymentId,
      reason: outcome.reason,
      initiatedByUserId: null,
      dedupeKey: `replay-capture:${outcome.paymentId}`,
    });
    await prisma.payment.updateMany({
      where: { id: outcome.paymentId, description: outcome.marker },
      data: { description: settledAutoRefundDescription(outcome.marker) },
    });
  } catch (refundError) {
    // The marker stays pending, so retry-auto-refunds re-drives the refund.
    reportSentryError(refundError, {
      subsystem: "payments",
      extra: { orderId, paymentId: outcome.paymentId },
    });
  }
}

export async function handleRecordingPurchaseFailure(
  orderId: string,
): Promise<void> {
  // Only PENDING → FAILED; a captured (SUCCEEDED) purchase can never be
  // flipped to FAILED by an out-of-order failure event.
  await prisma.recordingPurchase.updateMany({
    where: { gatewayOrderId: orderId, status: "PENDING" },
    data: { status: "FAILED" },
  });
}

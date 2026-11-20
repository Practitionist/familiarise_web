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
import { REPLAY_SALE_PREFIX } from "@/lib/payments/webhooks/auto-refund-marker";
import {
  AUTO_REFUND_MARKERS,
  cardLeg,
  gatewayPaymentMethod,
  gstRegimeNote,
  paiseNote,
  refundStagedCapture,
  resolveStandaloneCharge,
  settleOrderPayment,
  stageCaptureRefund as stageStandaloneCaptureRefund,
  type CaptureOutcome,
  type StageRefundInput,
  type StandaloneCharge,
} from "@/lib/payments/webhooks/standalone-sale-capture";
import { isDurablyOurs } from "@/lib/stream/recording-storage";
import * as Sentry from "@sentry/nextjs";

/** The notes a replay order is minted with; the capture reads them back. */
export const replayChargeNotesSchema = z.object({
  type: z.literal("recording_purchase"),
  recordingId: z.string().min(1),
  userId: z.string().min(1),
  originalAmountPaise: paiseNote,
  taxAmountPaise: paiseNote,
  buyerCountry: z.string().length(2),
  gstRegime: gstRegimeNote,
});
const replayBuyerSchema = replayChargeNotesSchema.pick({ userId: true });

type ReplayCharge = StandaloneCharge;

function resolveReplayCharge(
  orderId: string,
  chargedPaise: number,
  notes: Record<string, string> | undefined,
): ReplayCharge {
  return resolveStandaloneCharge(
    "recording-purchase",
    orderId,
    chargedPaise,
    notes,
  );
}

interface ResolvedPurchasePlanInfo {
  consultantProfileId: string | null;
  appointmentType: AppointmentType;
  webinarPlanId: string | null;
  classPlanId: string | null;
  hostOrganizationId: string | null;
  visibility?: string | null;
  /** When the recorded session started: the team of that moment shares the replay. */
  sessionStartsAt: Date;
}

function resolvePurchasePlanInfo(purchase: {
  recording?: {
    organizationId?: string | null;
    meeting?: {
      occurrence?: {
        startsAt: Date;
        appointment?: {
          organizationId?: string | null;
          webinar?: {
            webinarPlanId?: string;
            webinarPlan?: {
              id: string;
              consultantProfileId: string | null;
              organizationId?: string | null;
              visibility?: string | null;
            } | null;
          } | null;
          class?: {
            classPlanId?: string;
            classPlan?: {
              id: string;
              consultantProfileId: string | null;
              organizationId?: string | null;
              visibility?: string | null;
            } | null;
          } | null;
          consultation?: {
            consultationPlan?: {
              id: string;
              consultantProfileId: string | null;
              visibility?: string | null;
            } | null;
          } | null;
          subscription?: {
            subscriptionPlan?: {
              id: string;
              consultantProfileId: string | null;
              visibility?: string | null;
            } | null;
          } | null;
        } | null;
      } | null;
    } | null;
  } | null;
}): ResolvedPurchasePlanInfo | null {
  const recording = purchase.recording;
  const occurrence = recording?.meeting?.occurrence;
  const appointment = occurrence?.appointment;
  if (!occurrence || !appointment) return null;
  const sessionStartsAt = occurrence.startsAt;

  const fallbackOrgId =
    appointment.organizationId ?? recording?.organizationId ?? null;

  const webinarPlan = appointment.webinar?.webinarPlan;
  if (webinarPlan?.consultantProfileId || webinarPlan?.organizationId) {
    return {
      consultantProfileId: webinarPlan.consultantProfileId ?? null,
      appointmentType: "WEBINAR",
      webinarPlanId: appointment.webinar?.webinarPlanId ?? webinarPlan.id,
      classPlanId: null,
      hostOrganizationId: webinarPlan.organizationId ?? fallbackOrgId,
      visibility: webinarPlan.visibility ?? null,
      sessionStartsAt,
    };
  }

  const classPlan = appointment.class?.classPlan;
  if (classPlan?.consultantProfileId || classPlan?.organizationId) {
    return {
      consultantProfileId: classPlan.consultantProfileId ?? null,
      appointmentType: "CLASS",
      webinarPlanId: null,
      classPlanId: appointment.class?.classPlanId ?? classPlan.id,
      hostOrganizationId: classPlan.organizationId ?? fallbackOrgId,
      visibility: classPlan.visibility ?? null,
      sessionStartsAt,
    };
  }

  if (appointment.consultation?.consultationPlan?.consultantProfileId) {
    return {
      consultantProfileId:
        appointment.consultation.consultationPlan.consultantProfileId,
      appointmentType: "CONSULTATION",
      webinarPlanId: null,
      classPlanId: null,
      hostOrganizationId: fallbackOrgId,
      visibility: appointment.consultation.consultationPlan.visibility ?? null,
      sessionStartsAt,
    };
  }

  if (appointment.subscription?.subscriptionPlan?.consultantProfileId) {
    return {
      consultantProfileId:
        appointment.subscription.subscriptionPlan.consultantProfileId,
      appointmentType: "SUBSCRIPTION",
      webinarPlanId: null,
      classPlanId: null,
      hostOrganizationId: fallbackOrgId,
      visibility: appointment.subscription.subscriptionPlan.visibility ?? null,
      sessionStartsAt,
    };
  }

  return null;
}

function stageCaptureRefund(
  tx: Tx,
  input: StageRefundInput,
): Promise<CaptureOutcome | null> {
  return stageStandaloneCaptureRefund(tx, input, "Replay NOT granted.");
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
    method: string | undefined;
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
    method: input.method,
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
    method: string | undefined;
    chargedPaise: number;
    charge: ReplayCharge;
    hostOrganizationId: string | null;
    planInfo: ResolvedPurchasePlanInfo;
  },
): Promise<CaptureOutcome> {
  const {
    orderPayment,
    orderId,
    gatewayPaymentId,
    chargedPaise,
    charge,
    hostOrganizationId,
    planInfo,
  } = input;
  const paymentMethod = gatewayPaymentMethod(input.method);
  const payment = orderPayment
    ? await (async () => {
        const updatedLegs = await tx.paymentLeg.updateMany({
          where: { paymentId: orderPayment.id, source: "CARD" },
          data: { amountPaise: chargedPaise },
        });
        if (updatedLegs.count === 0) {
          await tx.paymentLeg.create({
            data: {
              paymentId: orderPayment.id,
              source: "CARD",
              amountPaise: chargedPaise,
              sourceRef: orderId,
            },
          });
        }
        return settleOrderPayment(tx, orderPayment, {
          amount: chargedPaise,
          originalAmount: charge.originalAmount,
          taxAmount: charge.taxAmount,
          gstRegime: charge.gstRegime,
          ...(charge.buyerCountry
            ? {
                buyerCountry: charge.buyerCountry,
                isInternational: charge.buyerCountry !== "IN",
              }
            : {}),
          paymentMethod,
          capturedAt: new Date(),
          description: `${REPLAY_SALE_PREFIX} recording ${input.recordingId}`,
          ...(gatewayPaymentId ? { gatewayPaymentId } : {}),
        });
      })()
    : await tx.payment.create({
        data: {
          userId: input.buyerId,
          appointmentId: null,
          amount: chargedPaise,
          originalAmount: charge.originalAmount,
          taxAmount: charge.taxAmount,
          gstRegime: charge.gstRegime,
          ...(charge.buyerCountry
            ? {
                buyerCountry: charge.buyerCountry,
                isInternational: charge.buyerCountry !== "IN",
              }
            : {}),
          currency: "INR",
          paymentMethod,
          paymentIntent: orderId,
          paymentGateway: "RAZORPAY",
          paymentStatus: "SUCCEEDED",
          capturedAt: new Date(),
          description: `${REPLAY_SALE_PREFIX} recording ${input.recordingId}`,
          organizationId:
            planInfo.visibility === "PUBLIC" ? null : hostOrganizationId,
          legs: cardLeg(chargedPaise, orderId),
          ...(gatewayPaymentId ? { gatewayPaymentId } : {}),
        },
      });

  await createEarningsFromPayment({
    payment: {
      ...payment,
      appointment: {
        ...(planInfo.consultantProfileId
          ? { consultantProfile: { id: planInfo.consultantProfileId } }
          : {}),
        organizationId: hostOrganizationId,
        webinar: planInfo.webinarPlanId
          ? { webinarPlanId: planInfo.webinarPlanId }
          : null,
        class: planInfo.classPlanId
          ? { classPlanId: planInfo.classPlanId }
          : null,
      },
    },
    appointmentType: planInfo.appointmentType,
    teamAt: planInfo.sessionStartsAt,
    tx,
  });
  return { kind: "settled", paymentId: payment.id };
}

function evaluateReplayRejection(input: {
  purchase: {
    status: string;
    recording: {
      listingStatus: string | null;
      status: string;
      storageType: string;
    } | null;
  };
  orderPayment: { description: string | null } | null;
  orderId: string;
  gatewayPaymentId?: string;
}): { paymentIntent: string; reason: string } | null {
  if (
    AUTO_REFUND_MARKERS.some((prefix) =>
      input.orderPayment?.description?.startsWith(prefix),
    )
  ) {
    return {
      paymentIntent: input.gatewayPaymentId ?? input.orderId,
      reason: `late capture on replay order ${input.orderId}`,
    };
  }
  const recording = input.purchase.recording;
  if (
    input.purchase.status === "FAILED" &&
    (recording?.listingStatus !== "PUBLISHED" || !isDurablyOurs(recording))
  ) {
    return {
      paymentIntent: input.orderId,
      reason: `late capture on replay order ${input.orderId}; the replay is no longer purchasable`,
    };
  }
  return null;
}

export async function handleRecordingPurchaseSuccess(
  orderId: string,
  gatewayPaymentId?: string,
  notes?: Record<string, string>,
  /** Captured paise from the payment entity; the purchase amount when absent. */
  capturedPaise?: number,
  /** Razorpay's `method` for the capture. */
  method?: string,
): Promise<void> {
  if (prisma.payment?.findUnique) {
    const existing = await prisma.payment.findUnique({
      where: { paymentIntent: orderId },
      select: {
        id: true,
        paymentStatus: true,
        amount: true,
        gatewayPaymentId: true,
      },
    });
    if (
      existing?.paymentStatus === "SUCCEEDED" &&
      (capturedPaise === undefined || capturedPaise === existing.amount) &&
      (!gatewayPaymentId ||
        !existing.gatewayPaymentId ||
        existing.gatewayPaymentId === gatewayPaymentId)
    ) {
      if (gatewayPaymentId && !existing.gatewayPaymentId) {
        await prisma.payment.updateMany({
          where: { id: existing.id, gatewayPaymentId: null },
          data: { gatewayPaymentId },
        });
      }
      return;
    }
  }

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
                      startsAt: true,
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
                                  visibility: true,
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
                                  visibility: true,
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
                                  visibility: true,
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
                                  visibility: true,
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
          method,
        });
      }

      // Settle only on gateway truth; without a captured amount stay PENDING.
      if (capturedPaise === undefined) {
        return null;
      }
      const chargedPaise = capturedPaise;
      if (!Number.isSafeInteger(chargedPaise) || chargedPaise <= 0) {
        throw new Error(
          `[recording-purchase] invalid charged amount for order ${orderId}`,
        );
      }
      const charge = resolveReplayCharge(orderId, chargedPaise, notes);
      const planInfo = resolvePurchasePlanInfo(purchase);
      const hostOrganizationId =
        planInfo?.hostOrganizationId ??
        purchase.recording?.organizationId ??
        null;
      const refundCapture = (paymentIntent: string, reason: string) =>
        stageCaptureRefund(tx, {
          paymentIntent,
          buyerId: purchase.buyerId,
          chargedPaise,
          charge,
          organizationId: null,
          gatewayPaymentId,
          method,
          reason,
        });
      if (chargedPaise !== Number(purchase.amountPaise)) {
        return refundCapture(
          orderId,
          `capture amount ${chargedPaise}p != expected ${purchase.amountPaise}p`,
        );
      }

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
      const rejection = evaluateReplayRejection({
        purchase,
        orderPayment,
        orderId,
        gatewayPaymentId,
      });
      if (rejection) {
        return refundCapture(rejection.paymentIntent, rejection.reason);
      }
      if (!planInfo) {
        Sentry.captureMessage(
          `[recording-purchase] capture without earnings owner: ${orderId}`,
          { level: "error", tags: { subsystem: "payments" } },
        );
        return refundCapture(
          orderId,
          `capture on replay order ${orderId}; recording plan owner is missing`,
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
        method,
        chargedPaise,
        charge,
        hostOrganizationId,
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
  await refundStagedCapture(outcome, {
    orderId,
    dedupePrefix: "replay-capture",
  });
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

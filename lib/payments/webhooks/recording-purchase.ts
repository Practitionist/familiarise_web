/**
 * Replay purchase webhook settlement.
 *
 * Recording purchase orders settle the RecordingPurchase row from PENDING to
 * SUCCEEDED and atomically record the corresponding Payment, ConsultantEarnings
 * (plus OrganizationEarnings and collaborator splits when applicable), and
 * double-entry BOOKING ledger journal inside a single database transaction.
 *
 * Idempotency: keyed on gatewayOrderId (unique) with a PENDING -> SUCCEEDED
 * compare-and-swap. A replayed capture hits the already-SUCCEEDED early return
 * or 0-row CAS guard. `payment.failed` marks the row FAILED only from PENDING
 * so a capture that raced ahead of the failure event wins.
 */
import prisma from "@/lib/prisma";
import { createEarningsFromPayment } from "@/lib/payments/payouts/earnings-service";
import type { AppointmentType } from "@/lib/payments/payouts/constants";
import * as Sentry from "@sentry/nextjs";

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

export async function handleRecordingPurchaseSuccess(
  orderId: string,
  gatewayPaymentId?: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const purchase = await tx.recordingPurchase.findUnique({
      where: { gatewayOrderId: orderId },
      select: {
        id: true,
        buyerId: true,
        amountPaise: true,
        status: true,
        recording: {
          select: {
            id: true,
            organizationId: true,
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
      // Unknown order — log loudly; the sweeper can't re-drive what has no row.
      console.error(
        `[recording-purchase] captured order ${orderId} has no RecordingPurchase row`,
      );
      Sentry.captureMessage(
        `[recording-purchase] captured order without row: ${orderId}`,
        { level: "error", tags: { subsystem: "payments" } },
      );
      return;
    }

    if (purchase.status === "SUCCEEDED") return; // idempotent replay

    const planInfo = resolvePurchasePlanInfo(purchase);
    if (!planInfo) {
      Sentry.captureMessage(
        `[recording-purchase] unable to resolve owning consultant plan for order: ${orderId}`,
        { level: "error", tags: { subsystem: "payments" } },
      );
      return;
    }

    const grossAmountPaise = Number(purchase.amountPaise);
    if (!Number.isFinite(grossAmountPaise) || grossAmountPaise <= 0) {
      return;
    }

    const claimed = await tx.recordingPurchase.updateMany({
      where: { id: purchase.id, status: "PENDING" },
      data: {
        status: "SUCCEEDED",
        ...(gatewayPaymentId ? { gatewayPaymentId } : {}),
      },
    });
    if (claimed.count === 0) return;

    const existingPayment = await tx.payment.findUnique({
      where: { paymentIntent: orderId },
    });

    const payment =
      existingPayment ??
      (await tx.payment.create({
        data: {
          userId: purchase.buyerId,
          appointmentId: null,
          amount: grossAmountPaise,
          originalAmount: grossAmountPaise,
          taxAmount: 0,
          currency: "INR",
          paymentMethod: "CARD",
          paymentIntent: orderId,
          paymentGateway: "RAZORPAY",
          paymentStatus: "SUCCEEDED",
          capturedAt: new Date(),
          organizationId: planInfo.organizationId,
          ...(gatewayPaymentId ? { gatewayPaymentId } : {}),
        },
      }));

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

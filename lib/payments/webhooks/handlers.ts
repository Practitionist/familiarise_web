/**
 * Payment Webhook Handlers
 * Core business logic for processing payment events
 * Can be used by both webhook API routes and direct checkout flows
 */

import prisma, { type Tx } from "@/lib/prisma";
import {
  AppointmentsType,
  PaymentStatus,
  Prisma,
  RequestStatus,
} from "@prisma/client";
import { calculateSubscriptionEndDate } from "@/utils/dateUtils";
import { validateWebhookMetadata } from "@/schemas/webhooks/metadata";
import { ZodError } from "zod";
import { sendPaymentSuccessEmail, sendPaymentFailedEmail } from "@/lib/email";
import {
  createEarningsFromPayment,
  type AppointmentType,
} from "@/lib/payments/payouts";
import { markWaitlistAsBooked } from "@/lib/waitlist/slot-handler";
import {
  notifyPaymentSuccess,
  notifyPaymentFailed,
  notifyAppointmentBooked,
} from "@/lib/novu";
import {
  processQualifyingAction,
  processConsultantBookingReferral,
} from "@/lib/referrals/service";
import { addUserToEventChannel } from "@/actions/stream/chat/event-channel.action";
import { createDirectMessageChannel } from "@/actions/stream/chat/channel.action";
import { streamLogger } from "@/lib/stream-logger";
import { getAppUrl } from "@/lib/url";

// ============================================================================
// Type Definitions
// ============================================================================

// #780 — the extended client converts EVERY BigInt column to number on read,
// but GetPayload (incl. nested includes) still says bigint. Deep-map to match
// runtime; Date/Bytes/Decimal pass through untouched.
type MoneyAsNumber<T> = T extends bigint
  ? number
  : T extends Date | Uint8Array | Prisma.Decimal
    ? T
    : T extends Array<infer U>
      ? Array<MoneyAsNumber<U>>
      : T extends object
        ? { [K in keyof T]: MoneyAsNumber<T[K]> }
        : T;

/**
 * Payment type with user and consultee profile included
 * Matches the Prisma query includes used in handlePaymentSuccess
 */
type PaymentWithUser = MoneyAsNumber<
  Prisma.PaymentGetPayload<{
    include: {
      user: {
        include: { consulteeProfile: true };
      };
    };
  }>
>;

/**
 * Data required to create a consultation appointment
 */
interface ConsultationData {
  planId: string;
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
  notes?: string;
  consulteeProfileId: string;
  userId: string;
}

/**
 * Data required to create a subscription appointment
 */
interface SubscriptionData {
  planId: string;
  slotStartTimeInUTC?: string;
  slotEndTimeInUTC?: string;
  schedulingPeriodStartsAt?: string;
  schedulingPeriodEndsAt?: string;
  notes?: string;
  consulteeProfileId: string;
  userId: string;
}

/**
 * Data required to create webinar/class appointments
 */
interface EventData {
  eventId: string;
  userId: string;
}

// ============================================================================
// Payment Success/Failure Handlers
// ============================================================================

/**
 * Handle successful payment - confirms or creates appointments
 *
 * TWO FLOWS SUPPORTED:
 * 1. NEW FLOW (Race Condition Fix): Appointment created during checkout (tentative)
 *    - payment.appointmentId exists
 *    - Just confirm appointment by setting isTentative = false
 *    - This prevents race conditions by making validation see tentative bookings
 *
 * 2. LEGACY FLOW: Appointment NOT created during checkout
 *    - payment.appointmentId is null
 *    - Create appointment from webhook metadata
 *    - Used for backwards compatibility and older payment flows
 *
 * Used by both webhook handlers and mock payment flows
 */
export async function handlePaymentSuccess(
  paymentIntentId: string,
  metadata: Record<string, string>,
): Promise<void> {
  // C1 FIX: Split into two phases:
  //   Phase 1 (transaction): Critical payment + appointment processing
  //   Phase 2 (post-tx): Earnings, invoice, waitlist, notifications
  //
  // Previously, earnings/invoice creation used the global `prisma` client
  // inside the transaction, meaning they ran outside isolation but errors
  // were swallowed. Now they run explicitly post-transaction with proper
  // error logging. The `sync-payment-earnings` background job serves as
  // a safety net for any failures in Phase 2.

  // Phase 1: Critical transaction — payment confirmation + appointment
  const txResult = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      include: { user: { include: { consulteeProfile: true } } },
    });

    if (!payment) {
      throw new Error(
        `Payment record not found for intent: ${paymentIntentId}`,
      );
    }

    if (payment.paymentStatus === PaymentStatus.SUCCEEDED) {
      console.log(`Payment ${paymentIntentId} has already been processed.`);
      return null; // Signal: already processed, skip Phase 2
    }

    // VALIDATION: Check metadata before processing
    try {
      validateWebhookMetadata(metadata);
    } catch (validationError) {
      const errorMessage =
        validationError instanceof ZodError
          ? validationError.errors
              .map((e) => `${e.path.join(".")}: ${e.message}`)
              .join("; ")
          : validationError instanceof Error
            ? validationError.message
            : String(validationError);

      console.error(
        `❌ Metadata validation failed for payment ${paymentIntentId}:`,
        errorMessage,
      );

      // FIX Issue #8: Enhanced alerting for metadata validation failures
      // This is a CRITICAL condition - customer charged but no appointment created!
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          paymentStatus: PaymentStatus.SUCCEEDED,
          description: `REQUIRES_MANUAL_RECOVERY: Metadata validation failed: ${errorMessage}. Customer charged but appointment NOT created.`,
        },
      });

      // CRITICAL ALERT - Log in structured format for monitoring systems
      console.error(
        JSON.stringify({
          event: "CRITICAL_PAYMENT_WITHOUT_APPOINTMENT",
          alert_priority: "P1",
          payment_id: payment.id,
          payment_intent: paymentIntentId,
          user_id: payment.userId,
          user_email: payment.user.email,
          amount: payment.amount,
          currency: payment.currency,
          error: errorMessage,
          action_required:
            "IMMEDIATE: Manual appointment creation or full refund required",
          dashboard_url: `${getAppUrl()}/admin/payments/${payment.id}`,
          timestamp: new Date().toISOString(),
        }),
      );

      console.error(
        `
================================================================================
                    CRITICAL ALERT: PAYMENT WITHOUT APPOINTMENT
================================================================================
Payment ID:      ${payment.id}
Payment Intent:  ${paymentIntentId}
User ID:         ${payment.userId}
User Email:      ${payment.user.email || "N/A"}
Amount:          ${payment.currency} ${payment.amount / 100}
Error:           ${errorMessage}

ACTION REQUIRED: Customer was charged but appointment was NOT created!
                 Either create appointment manually or issue full refund.
================================================================================
        `,
      );

      return null; // Exit early — requires manual intervention
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: { paymentStatus: PaymentStatus.SUCCEEDED },
    });

    let appointment;
    if (payment.appointmentId) {
      // NEW FLOW: Appointment already created during checkout (tentative)
      appointment = await tx.appointment.findUnique({
        where: { id: payment.appointmentId },
      });

      console.log(
        JSON.stringify({
          event: "webhook_confirming_existing_appointment",
          paymentIntent: paymentIntentId,
          appointmentId: payment.appointmentId,
          timestamp: new Date().toISOString(),
        }),
      );
    } else {
      // LEGACY FLOW: Appointment not created during checkout
      appointment = await createAppointmentFromWebhook(tx, metadata, payment);

      console.log(
        JSON.stringify({
          event: "webhook_creating_new_appointment",
          paymentIntent: paymentIntentId,
          appointmentId: appointment.id,
          appointmentType: metadata.appointmentType,
          timestamp: new Date().toISOString(),
        }),
      );
    }

    if (!appointment) {
      throw new Error("Failed to create or find appointment");
    }

    // Confirm appointment: set isTentative = false and update status to APPROVED
    await confirmExistingAppointment(tx, appointment.id, payment.userId);

    console.log(
      `✅ Payment ${paymentIntentId} processed successfully. Appointment ID: ${appointment.id}`,
    );

    // Return data needed for Phase 2
    return {
      paymentId: payment.id,
      appointmentId: appointment.id,
      appointmentType: metadata.appointmentType,
      userId: payment.userId,
      userName: payment.user.name,
      amount: payment.amount,
      currency: payment.currency,
    };
  });

  // If transaction returned null, the payment was already processed or had a metadata error
  if (!txResult) return;

  // Phase 2: Non-critical post-transaction work (earnings, invoice, waitlist, notifications)
  // Failures here are logged but do NOT roll back the payment.
  // The `sync-payment-earnings` and related background jobs serve as safety nets.

  // M5 FIX: Send payment success email in Phase 2 (post-commit) so a
  // transaction rollback cannot leave the user with a false confirmation.
  try {
    const paymentForEmail = await prisma.payment.findUnique({
      where: { id: txResult.paymentId },
      include: { user: { include: { consulteeProfile: true } } },
    });
    if (paymentForEmail) {
      await sendPaymentSuccessNotification(
        prisma,
        paymentForEmail as PaymentWithUser,
        txResult.appointmentId,
        txResult.appointmentType,
      );
    }
  } catch (emailError) {
    console.error(
      "Failed to send payment success email (Phase 2):",
      emailError,
    );
  }

  const { paymentId, appointmentId, userId, userName, amount, currency } =
    txResult;

  // --- Earnings creation ---
  try {
    const paymentWithAppointment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        appointment: {
          include: {
            consultation: {
              include: {
                consultationPlan: {
                  include: { consultantProfile: true },
                },
              },
            },
            subscription: {
              include: {
                subscriptionPlan: {
                  include: { consultantProfile: true },
                },
              },
            },
            webinar: {
              select: {
                id: true,
                webinarPlanId: true,
                webinarPlan: {
                  include: { consultantProfile: true },
                },
              },
            },
            class: {
              select: {
                id: true,
                classPlanId: true,
                classPlan: {
                  include: { consultantProfile: true },
                },
              },
            },
          },
        },
      },
    });

    if (paymentWithAppointment?.appointment) {
      const consultantProfile =
        paymentWithAppointment.appointment.consultation?.consultationPlan
          ?.consultantProfile ||
        paymentWithAppointment.appointment.subscription?.subscriptionPlan
          ?.consultantProfile ||
        paymentWithAppointment.appointment.webinar?.webinarPlan
          ?.consultantProfile ||
        paymentWithAppointment.appointment.class?.classPlan?.consultantProfile;

      if (consultantProfile) {
        const appointmentTypeMap: Record<string, AppointmentType> = {
          CONSULTATION: "CONSULTATION",
          SUBSCRIPTION: "SUBSCRIPTION",
          WEBINAR: "WEBINAR",
          CLASS: "CLASS",
        };

        const earningsAppointmentType =
          appointmentTypeMap[metadata.appointmentType] || "CONSULTATION";

        const paymentForEarnings = {
          ...paymentWithAppointment,
          appointment: {
            ...paymentWithAppointment.appointment,
            consultantProfile: { id: consultantProfile.id },
            webinar: paymentWithAppointment.appointment.webinar
              ? {
                  webinarPlanId:
                    paymentWithAppointment.appointment.webinar.webinarPlanId,
                }
              : null,
            class: paymentWithAppointment.appointment.class
              ? {
                  classPlanId:
                    paymentWithAppointment.appointment.class.classPlanId,
                }
              : null,
          },
        };

        await createEarningsFromPayment({
          payment: paymentForEarnings as Parameters<
            typeof createEarningsFromPayment
          >[0]["payment"],
          appointmentType: earningsAppointmentType,
        });

        console.log(
          `💰 Earnings record created for payment ${paymentId}, consultant ${consultantProfile.id}`,
        );
      }
    }
  } catch (earningsError) {
    // Log but don't fail — sync-payment-earnings job will pick up the gap
    console.error(
      `⚠️ Failed to create earnings for payment ${paymentId}:`,
      earningsError,
    );
  }

  // --- Referral qualifying action (first paid booking triggers both bonuses) ---
  // FIX #437: Process for the buyer (consultee) — their first paid booking qualifies their referral
  try {
    await processQualifyingAction(userId, "first_paid_booking");
  } catch (referralError) {
    console.error(
      `⚠️ Failed to process referral qualifying action for user ${userId}:`,
      referralError,
    );
  }

  // FIX #437: Also process for the consultant (service provider) — receiving their first
  // paid booking qualifies their referral too. This fixes the broken Consultant→Consultant
  // referral scenario where consultants never trigger qualification because they don't
  // make bookings, they receive them.
  try {
    await processConsultantBookingReferral({ id: paymentId }, userId);
  } catch (consultantReferralError) {
    console.error(
      `⚠️ Failed to process consultant referral qualifying action:`,
      consultantReferralError,
    );
  }

  // Personal-consultee per-Payment invoice generation was removed in
  // the v0 lockdown (#768). Org-funded checkouts continue to roll up
  // into OrganizationInvoice via the INVOICE cycle cron; personal-card
  // consultees request a receipt via support@familiarise.work until v1.1
  // re-introduces a per-Payment surface.

  // --- Waitlist update ---
  if (metadata.fromWaitlist) {
    try {
      await markWaitlistAsBooked(metadata.fromWaitlist);
      console.log(
        JSON.stringify({
          event: "waitlist_booking_completed",
          waitlistId: metadata.fromWaitlist,
          paymentIntent: paymentIntentId,
          timestamp: new Date().toISOString(),
        }),
      );
    } catch (waitlistError) {
      console.error(
        `⚠️ Failed to update waitlist status for payment ${paymentId}:`,
        waitlistError,
      );
    }
  }

  // --- Novu notifications (M5 FIX: moved outside transaction) ---
  try {
    const appointmentForNotif = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        consultation: {
          include: {
            consultationPlan: {
              include: { consultantProfile: { include: { user: true } } },
            },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: {
              include: { consultantProfile: { include: { user: true } } },
            },
          },
        },
        webinar: {
          include: {
            webinarPlan: {
              include: { consultantProfile: { include: { user: true } } },
            },
          },
        },
        class: {
          include: {
            classPlan: {
              include: { consultantProfile: { include: { user: true } } },
            },
          },
        },
      },
    });

    const consultantProfileData =
      appointmentForNotif?.consultation?.consultationPlan?.consultantProfile ||
      appointmentForNotif?.subscription?.subscriptionPlan?.consultantProfile ||
      appointmentForNotif?.webinar?.webinarPlan?.consultantProfile ||
      appointmentForNotif?.class?.classPlan?.consultantProfile;

    const consultantNameForNotif =
      consultantProfileData?.user?.name || "Consultant";
    const consultantUserId = consultantProfileData?.user?.id;

    const planTitle = appointmentForNotif?.consultation?.consultationPlan
      ?.consultantProfile?.user?.name
      ? metadata.appointmentType
      : metadata.appointmentType || "Appointment";

    const dashboardUrl = `${getAppUrl()}/dashboard`;

    // Notify consultee of successful payment
    void notifyPaymentSuccess(userId, {
      amount,
      currency,
      consultantName: consultantNameForNotif,
      appointmentType: metadata.appointmentType,
      planTitle: metadata.planId || planTitle,
      dashboardUrl,
    });

    // Notify both consultant and consultee of the booked appointment
    const notifUserIds = [userId];
    if (consultantUserId && consultantUserId !== userId) {
      notifUserIds.push(consultantUserId);
    }

    void notifyAppointmentBooked(notifUserIds, {
      appointmentId,
      appointmentType: metadata.appointmentType,
      consultantName: consultantNameForNotif,
      consulteeName: userName || "User",
      planTitle: metadata.planId || planTitle,
      dashboardUrl,
    });
  } catch (novuError) {
    console.error(
      `⚠️ Failed to send Novu notifications for payment ${paymentId}:`,
      novuError,
    );
  }

  // --- Stream channel creation (truly fire-and-forget — does not block webhook response) ---
  void (async () => {
    try {
      const eventType = metadata.appointmentType?.toUpperCase();
      const appointmentForChannel = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          consultation: {
            include: {
              consultationPlan: {
                include: { consultantProfile: true },
              },
            },
          },
          subscription: {
            include: {
              subscriptionPlan: {
                include: { consultantProfile: true },
              },
            },
          },
          webinar: {
            include: {
              webinarPlan: {
                include: { consultantProfile: true },
              },
            },
          },
          class: {
            include: {
              classPlan: {
                include: { consultantProfile: true },
              },
            },
          },
        },
      });

      const consultantProfile =
        appointmentForChannel?.consultation?.consultationPlan
          ?.consultantProfile ||
        appointmentForChannel?.subscription?.subscriptionPlan
          ?.consultantProfile ||
        appointmentForChannel?.webinar?.webinarPlan?.consultantProfile ||
        appointmentForChannel?.class?.classPlan?.consultantProfile;

      const consultantUserId = consultantProfile?.userId;

      if (appointmentForChannel && consultantUserId) {
        const consultation = appointmentForChannel.consultation;
        const subscription = appointmentForChannel.subscription;
        const webinar = appointmentForChannel.webinar;
        const classEvent = appointmentForChannel.class;

        if (eventType === "CONSULTATION" && consultation) {
          await addUserToEventChannel("consultation", consultation.id, userId);
          await createDirectMessageChannel(consultantUserId, userId);
        } else if (eventType === "SUBSCRIPTION" && subscription) {
          await addUserToEventChannel("subscription", subscription.id, userId);
          await createDirectMessageChannel(consultantUserId, userId);
        } else if (eventType === "WEBINAR" && webinar) {
          await addUserToEventChannel("webinar", webinar.id, userId);
        } else if (eventType === "CLASS" && classEvent) {
          await addUserToEventChannel("class", classEvent.id, userId);
        }

        streamLogger.info("Stream channel created on payment success", {
          appointmentType: eventType,
          appointmentId,
          userId,
        });
      }
    } catch (channelError) {
      // Log but never fail the payment — sync job will catch up
      streamLogger.error(
        "Auto-channel creation failed on payment success",
        channelError,
        { appointmentId, userId },
      );
    }
  })();
}

/**
 * Handle failed payment - cleans up tentative appointments
 */
export async function handlePaymentFailure(paymentIntentId: string) {
  return await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { paymentIntent: paymentIntentId },
      include: {
        user: true,
        appointment: {
          include: {
            consultation: {
              include: {
                consultationPlan: {
                  include: {
                    consultantProfile: {
                      include: {
                        user: true,
                      },
                    },
                  },
                },
              },
            },
            subscription: {
              include: {
                subscriptionPlan: {
                  include: {
                    consultantProfile: {
                      include: {
                        user: true,
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

    if (!payment) {
      console.warn(
        `Payment record not found for failed intent: ${paymentIntentId}`,
      );
      return;
    }

    // FIX Issue #8: Idempotency check - prevent duplicate processing
    if (payment.paymentStatus === PaymentStatus.FAILED) {
      console.log(
        `Payment ${paymentIntentId} has already been marked as failed.`,
      );
      return;
    }

    // M7 FIX: Guard against SUCCEEDED → FAILED transition.
    // A late failure webhook must not override a payment that already succeeded.
    if (payment.paymentStatus === PaymentStatus.SUCCEEDED) {
      console.warn(
        `Payment ${paymentIntentId} already SUCCEEDED. Ignoring late failure webhook.`,
      );
      return;
    }

    // Guard against EXPIRED → FAILED transition.
    // Once a payment is expired by cleanup jobs, a late failure webhook should not overwrite it.
    if (payment.paymentStatus === PaymentStatus.EXPIRED) {
      console.log(
        `Payment ${paymentIntentId} already EXPIRED. Ignoring late failure webhook.`,
      );
      return;
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: { paymentStatus: PaymentStatus.FAILED },
    });

    if (payment.appointment) {
      await cleanupFailedPaymentAppointment(tx, payment.appointment.id);
    }

    // Send payment failure email
    await sendPaymentFailureNotification(tx, payment);

    // --- Novu notification (fire-and-forget) ---
    try {
      const consultantUser =
        payment.appointment?.consultation?.consultationPlan?.consultantProfile
          ?.user ||
        payment.appointment?.subscription?.subscriptionPlan?.consultantProfile
          ?.user;

      const consultantName = consultantUser?.name || "Consultant";
      const appointmentType =
        payment.appointment?.appointmentType || "CONSULTATION";

      void notifyPaymentFailed(payment.userId, {
        amount: payment.amount,
        currency: payment.currency,
        consultantName,
        appointmentType,
        failureReason: payment.description || "Payment could not be processed",
        retryUrl: `${getAppUrl()}/dashboard`,
      });
    } catch (novuError) {
      console.error(
        `⚠️ Failed to send Novu payment failed notification for payment ${payment.id}:`,
        novuError,
      );
    }

    console.log(
      `📧 Payment failure notification sent for payment ${paymentIntentId}`,
    );
  });
}

// ============================================================================
// Appointment Creation from Webhook Metadata
// ============================================================================

/**
 * Create appointment from webhook metadata based on appointment type
 */
async function createAppointmentFromWebhook(
  tx: Tx,
  metadata: Record<string, string>,
  payment: PaymentWithUser,
) {
  const {
    appointmentType,
    planId,
    eventId,
    slotStartTimeInUTC,
    slotEndTimeInUTC,
    schedulingPeriodStartsAt,
    schedulingPeriodEndsAt,
    notes,
  } = metadata;

  if (!payment.user.consulteeProfile) {
    throw new Error("User profile not found for payment");
  }

  const consulteeProfileId = payment.user.consulteeProfile.id;
  const userId = payment.user.id;

  let appointment;

  switch (appointmentType) {
    case AppointmentsType.CONSULTATION:
      appointment = await createConsultation(tx, {
        planId,
        slotStartTimeInUTC,
        slotEndTimeInUTC,
        notes,
        consulteeProfileId,
        userId,
      });
      break;
    case AppointmentsType.SUBSCRIPTION:
      // LEGACY FLOW WARNING: This should only happen for old payments
      // New subscriptions create placeholder appointment during checkout
      console.warn(
        JSON.stringify({
          event: "legacy_subscription_creation",
          warning:
            "Creating subscription via webhook - expected only for old payments",
          paymentId: payment.id,
          planId,
          timestamp: new Date().toISOString(),
        }),
      );
      appointment = await createSubscription(tx, {
        planId,
        slotStartTimeInUTC,
        slotEndTimeInUTC,
        schedulingPeriodStartsAt,
        schedulingPeriodEndsAt,
        notes,
        consulteeProfileId,
        userId,
      });
      break;
    case AppointmentsType.WEBINAR:
      appointment = await createWebinar(tx, { eventId, userId });
      break;
    case AppointmentsType.CLASS:
      appointment = await createClass(tx, { eventId, userId });
      break;
    default:
      throw new Error(`Unsupported appointment type: ${appointmentType}`);
  }

  await tx.payment.update({
    where: { id: payment.id },
    data: { appointmentId: appointment.id },
  });

  return appointment;
}

// ============================================================================
// Appointment Type-Specific Creation Functions
// ============================================================================

async function createConsultation(tx: Tx, data: ConsultationData) {
  const consultation = await tx.consultation.create({
    data: {
      consultationPlanId: data.planId,
      requestStatus: RequestStatus.PENDING,
      requestedById: data.consulteeProfileId,
      requestNotes: data.notes,
      bookingSource: "DIRECT_CHECKOUT",
    },
  });

  return await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.CONSULTATION,
      consultationId: consultation.id,
      slotsOfAppointment: {
        create: {
          startsAt: new Date(data.slotStartTimeInUTC),
          endsAt: new Date(data.slotEndTimeInUTC),
          isTentative: false,
          user: { connect: { id: data.userId } },
        },
      },
    },
    include: {
      slotsOfAppointment: true,
    },
  });
}

async function createSubscription(tx: Tx, data: SubscriptionData) {
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: data.planId },
  });
  if (!plan) throw new Error("Subscription plan not found");

  // Check if this is a scheduling period request (no slots) or direct slot booking
  const isSchedulingPeriodRequest =
    data.schedulingPeriodStartsAt && data.schedulingPeriodEndsAt;

  let startDate: Date;
  let endDate: Date;

  if (isSchedulingPeriodRequest) {
    // Use provided scheduling period dates (safe to assert since checked above)
    startDate = new Date(data.schedulingPeriodStartsAt!);
    endDate = new Date(data.schedulingPeriodEndsAt!);
  } else {
    // Calculate subscription period from current date
    startDate = new Date();
    endDate = calculateSubscriptionEndDate(startDate, plan.durationInMonths);
  }

  const subscription = await tx.subscription.create({
    data: {
      subscriptionPlanId: data.planId,
      requestStatus: RequestStatus.PENDING,
      requestedById: data.consulteeProfileId,
      requestNotes: data.notes,
      bookingSource: "DIRECT_CHECKOUT",
      schedulingPeriodStartsAt: startDate,
      schedulingPeriodEndsAt: endDate,
    },
  });

  // Build appointment data conditionally based on scheduling approach
  const appointmentData: Prisma.AppointmentUncheckedCreateInput = {
    appointmentType: AppointmentsType.SUBSCRIPTION,
    subscriptionId: subscription.id,
  };

  // Only add slots if NOT a scheduling period request
  if (
    !isSchedulingPeriodRequest &&
    data.slotStartTimeInUTC &&
    data.slotEndTimeInUTC
  ) {
    appointmentData.slotsOfAppointment = {
      create: {
        startsAt: new Date(data.slotStartTimeInUTC),
        endsAt: new Date(data.slotEndTimeInUTC),
        isTentative: false,
        user: { connect: { id: data.userId } },
      },
    };
  }

  // Single appointment creation call
  return await tx.appointment.create({
    data: appointmentData,
    include: {
      slotsOfAppointment: true,
    },
  });
}

async function createWebinar(tx: Tx, data: EventData) {
  const webinar = await tx.webinar.findUnique({
    where: { id: data.eventId },
    include: { appointment: { include: { slotsOfAppointment: true } } },
  });
  if (!webinar) throw new Error("Webinar not found");

  // Validate webinar has been scheduled (has an appointment with at least one slot)
  const masterSlot = webinar.appointment?.slotsOfAppointment?.[0];
  if (!webinar.appointment || !masterSlot) {
    throw new Error("Webinar has not been scheduled. Cannot create booking.");
  }

  // Use the master slot's times — guaranteed to exist after validation above
  await tx.slotOfAppointment.create({
    data: {
      appointmentId: webinar.appointment.id,
      startsAt: masterSlot.startsAt,
      endsAt: masterSlot.endsAt,
      isTentative: false,
      user: { connect: { id: data.userId } },
    },
  });

  const createdAppointment = await tx.appointment.findUnique({
    where: { id: webinar.appointment.id },
    include: { slotsOfAppointment: true },
  });
  if (!createdAppointment) {
    throw new Error("Failed to fetch created appointment");
  }
  return createdAppointment;
}

async function createClass(tx: Tx, data: EventData) {
  const classInstance = await tx.class.findUnique({
    where: { id: data.eventId },
    include: { classPlan: true },
  });
  if (!classInstance) throw new Error("Class not found");

  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.CLASS,
      classId: classInstance.id,
      slotsOfAppointment: {
        create: {
          startsAt: classInstance.schedulingPeriodStartsAt || new Date(),
          endsAt: classInstance.schedulingPeriodEndsAt || new Date(),
          isTentative: false,
          user: { connect: { id: data.userId } },
        },
      },
    },
  });

  const createdAppointment = await tx.appointment.findUnique({
    where: { id: appointment.id },
    include: { slotsOfAppointment: true },
  });
  if (!createdAppointment) {
    throw new Error("Failed to fetch created appointment");
  }
  return createdAppointment;
}

// ============================================================================
// Appointment State Management
// ============================================================================

/**
 * Confirm consultation or subscription status after successful payment
 * Transitions APPROVED_PENDING_PAYMENT → APPROVED
 */
async function confirmApprovalStatus(
  tx: Tx,
  entityType: "consultation" | "subscription",
  entityId: string,
): Promise<void> {
  if (entityType === "consultation") {
    const consultation = await tx.consultation.findUnique({
      where: { id: entityId },
    });

    if (!consultation) {
      throw new Error(`Consultation ${entityId} not found`);
    }

    // If status is APPROVED_PENDING_PAYMENT, confirm the appointment
    if (consultation.requestStatus === RequestStatus.APPROVED_PENDING_PAYMENT) {
      await tx.consultation.update({
        where: { id: entityId },
        data: { requestStatus: RequestStatus.APPROVED },
      });
      console.log(
        `✅ Consultation ${entityId} payment completed - moving from APPROVED_PENDING_PAYMENT to APPROVED`,
      );
    } else if (consultation.requestStatus !== RequestStatus.APPROVED) {
      // Only update if not already approved
      await tx.consultation.update({
        where: { id: entityId },
        data: { requestStatus: RequestStatus.APPROVED },
      });
    }
  } else {
    const subscription = await tx.subscription.findUnique({
      where: { id: entityId },
    });

    if (!subscription) {
      throw new Error(`Subscription ${entityId} not found`);
    }

    // For subscriptions: Only transition APPROVED_PENDING_PAYMENT → APPROVED
    // Do NOT change PENDING → APPROVED here!
    // Subscription stays PENDING until consultant allocates slots via Requests tab
    // SlotAllocationService.allocate() will set status to APPROVED when slots are allocated
    if (subscription.requestStatus === RequestStatus.APPROVED_PENDING_PAYMENT) {
      await tx.subscription.update({
        where: { id: entityId },
        data: { requestStatus: RequestStatus.APPROVED },
      });
      console.log(
        `✅ Subscription ${entityId} payment completed - moving from APPROVED_PENDING_PAYMENT to APPROVED`,
      );
    } else {
      console.log(
        `ℹ️ Subscription ${entityId} payment received - keeping status as ${subscription.requestStatus} (consultant will allocate slots)`,
      );
    }
  }
}

/**
 * Confirm appointment by making slots non-tentative and updating status
 *
 * FIX Issue #1 & #3: For multi-user events (WEBINAR, CLASS), only confirm
 * the paying user's slots, not all slots for the shared appointment.
 *
 * @param tx - Prisma transaction client
 * @param appointmentId - The appointment ID to confirm
 * @param userId - The paying user's ID (required for WEBINAR/CLASS to prevent confirming other users' slots)
 */
async function confirmExistingAppointment(
  tx: Tx,
  appointmentId: string,
  userId?: string,
) {
  // First fetch appointment to determine type
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: true,
      subscription: true,
      webinar: true,
      class: true,
    },
  });

  if (!appointment) {
    console.warn(`Appointment ${appointmentId} not found for confirmation`);
    return;
  }

  // FIX Issue #3: For CLASS, confirm ALL user's slots across all sessions
  // Classes have multiple appointments (one per session), but payment only links to first
  if (appointment.class && userId) {
    await tx.slotOfAppointment.updateMany({
      where: {
        appointment: { classId: appointment.class.id },
        user: { some: { id: userId } },
      },
      data: { isTentative: false },
    });

    console.log(
      JSON.stringify({
        event: "class_all_sessions_confirmed",
        classId: appointment.class.id,
        userId,
        timestamp: new Date().toISOString(),
      }),
    );
  }
  // FIX Issue #1: For WEBINAR, confirm only the paying user's slot
  // Webinars share one appointment among all participants
  else if (appointment.webinar && userId) {
    await tx.slotOfAppointment.updateMany({
      where: {
        appointmentId,
        user: { some: { id: userId } },
      },
      data: { isTentative: false },
    });

    console.log(
      JSON.stringify({
        event: "webinar_user_slot_confirmed",
        webinarId: appointment.webinar.id,
        userId,
        timestamp: new Date().toISOString(),
      }),
    );
  }
  // For CONSULTATION and SUBSCRIPTION: original behavior (single user per appointment)
  else {
    await tx.slotOfAppointment.updateMany({
      where: { appointmentId },
      data: { isTentative: false },
    });
  }

  // Update status for consultation and subscription
  if (appointment.consultation) {
    await confirmApprovalStatus(
      tx,
      "consultation",
      appointment.consultation.id,
    );
  }

  if (appointment.subscription) {
    await confirmApprovalStatus(
      tx,
      "subscription",
      appointment.subscription.id,
    );
  }

  // Update webinar status
  if (appointment.webinar) {
    await tx.webinar.update({
      where: { id: appointment.webinar.id },
      data: { status: "SCHEDULED" },
    });
  }

  // Update class status
  if (appointment.class) {
    await tx.class.update({
      where: { id: appointment.class.id },
      data: { status: "SCHEDULED" },
    });
  }
}

/**
 * Clean up tentative appointments for failed payments
 */
async function cleanupFailedPaymentAppointment(tx: Tx, appointmentId: string) {
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      slotsOfAppointment: true,
      consultation: true,
      subscription: true,
    },
  });

  if (!appointment) return;

  const tentativeSlots = appointment.slotsOfAppointment.filter(
    (slot) => slot.isTentative,
  );

  if (tentativeSlots.length > 0) {
    await tx.slotOfAppointment.deleteMany({
      where: { appointmentId, isTentative: true },
    });

    if (appointment.consultation || appointment.subscription) {
      const remainingSlots = await tx.slotOfAppointment.count({
        where: { appointmentId },
      });
      if (remainingSlots === 0) {
        // Soft-delete: transition to EXPIRED status instead of hard-deleting
        // to preserve audit trails for support/disputes/refunds
        if (appointment.consultation) {
          await tx.consultation.update({
            where: { id: appointment.consultation.id },
            data: { requestStatus: RequestStatus.EXPIRED },
          });
        }
        if (appointment.subscription) {
          await tx.subscription.update({
            where: { id: appointment.subscription.id },
            data: { requestStatus: RequestStatus.EXPIRED },
          });
        }
      }
    }
  }
}

// ============================================================================
// Email Notification Helpers
// ============================================================================

/**
 * Send payment success email notification
 */
async function sendPaymentSuccessNotification(
  tx: Tx,
  payment: PaymentWithUser,
  appointmentId: string,
  appointmentType: string,
) {
  try {
    const appointment = await tx.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: true,
                  },
                },
              },
            },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: true,
                  },
                },
              },
            },
          },
        },
        webinar: {
          include: {
            webinarPlan: {
              include: {
                consultantProfile: {
                  include: { user: { select: { name: true } } },
                },
              },
            },
          },
        },
        class: {
          include: {
            classPlan: {
              include: {
                consultantProfile: {
                  include: { user: { select: { name: true } } },
                },
              },
            },
          },
        },
      },
    });

    if (!appointment) {
      console.error(
        `Cannot send payment success email: appointment ${appointmentId} not found`,
      );
      return;
    }

    let consultantName = "Consultant";
    const amount = payment.amount;
    const currency = payment.currency;

    // Get consultant name based on appointment type
    if (appointment.consultation?.consultationPlan?.consultantProfile?.user) {
      consultantName =
        appointment.consultation.consultationPlan.consultantProfile.user.name ||
        "Consultant";
    } else if (
      appointment.subscription?.subscriptionPlan?.consultantProfile?.user
    ) {
      consultantName =
        appointment.subscription.subscriptionPlan.consultantProfile.user.name ||
        "Consultant";
    } else if (appointment.webinar?.webinarPlan?.consultantProfile?.user) {
      consultantName =
        appointment.webinar.webinarPlan.consultantProfile.user.name ||
        "Consultant";
    } else if (appointment.class?.classPlan?.consultantProfile?.user) {
      consultantName =
        appointment.class.classPlan.consultantProfile.user.name || "Consultant";
    }

    // Send email
    await sendPaymentSuccessEmail({
      email: payment.user.email || "",
      name: payment.user.name || "User",
      consultantName,
      appointmentType: appointmentType.toLowerCase() as
        | "consultation"
        | "subscription"
        | "webinar"
        | "class",
      amount,
      currency,
      dashboardUrl: `${getAppUrl()}/dashboard`,
    });

    console.log(
      `📧 Payment success email sent to ${payment.user.email} for ${appointmentType}`,
    );
  } catch (error) {
    // Don't throw - email failures shouldn't block payment processing
    console.error("Failed to send payment success email:", error);
  }
}

/**
 * Send payment failure email notification
 */
async function sendPaymentFailureNotification(
  tx: Tx,
  payment: MoneyAsNumber<
    Prisma.PaymentGetPayload<{
      include: {
        user: true;
        appointment: {
          include: {
            consultation: {
              include: {
                consultationPlan: {
                  include: {
                    consultantProfile: {
                      include: {
                        user: true;
                      };
                    };
                  };
                };
              };
            };
            subscription: {
              include: {
                subscriptionPlan: {
                  include: {
                    consultantProfile: {
                      include: {
                        user: true;
                      };
                    };
                  };
                };
              };
            };
          };
        };
      };
    }>
  >,
) {
  try {
    const appointment = await tx.appointment.findUnique({
      where: { id: payment.appointmentId || "" },
      include: {
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: true,
                  },
                },
              },
            },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!appointment) {
      console.error(
        `Cannot send payment failure email: appointment not found for payment ${payment.id}`,
      );
      return;
    }

    let consultantName = "Consultant";
    let appointmentType: "consultation" | "subscription" = "consultation";
    let retryUrl = `${getAppUrl()}/dashboard`;

    // Get consultant name and appointment type
    if (appointment.consultation?.consultationPlan?.consultantProfile?.user) {
      consultantName =
        appointment.consultation.consultationPlan.consultantProfile.user.name ||
        "Consultant";
      appointmentType = "consultation";
      retryUrl = `${getAppUrl()}/consultations/${appointment.consultation.id}/payment`;
    } else if (
      appointment.subscription?.subscriptionPlan?.consultantProfile?.user
    ) {
      consultantName =
        appointment.subscription.subscriptionPlan.consultantProfile.user.name ||
        "Consultant";
      appointmentType = "subscription";
      retryUrl = `${getAppUrl()}/subscriptions/${appointment.subscription.id}/payment`;
    }

    // Send email
    await sendPaymentFailedEmail({
      email: payment.user.email || "",
      name: payment.user.name || "User",
      consultantName,
      appointmentType,
      amount: payment.amount,
      currency: payment.currency,
      retryUrl,
      failureReason: payment.description || "Payment could not be processed",
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48 hours from now
    });

    console.log(
      `📧 Payment failure email sent to ${payment.user.email} for ${appointmentType}`,
    );
  } catch (error) {
    // Don't throw - email failures shouldn't block payment processing
    console.error("Failed to send payment failure email:", error);
  }
}

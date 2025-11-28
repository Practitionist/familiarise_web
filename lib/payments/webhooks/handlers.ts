/**
 * Payment Webhook Handlers
 * Core business logic for processing payment events
 * Can be used by both webhook API routes and direct checkout flows
 */

import prisma from "@/lib/prisma";
import {
  AppointmentsType,
  PaymentStatus,
  Prisma,
  RequestStatus,
} from "@prisma/client";
import { calculateSubscriptionEndDate } from "@/utils/dateUtils";
import { validateWebhookMetadata } from "@/schemas/webhooks/metadata";
import { ZodError } from "zod";
import {
  sendPaymentSuccessEmail,
  sendPaymentFailedEmail,
} from "@/lib/email";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Payment type with user and consultee profile included
 * Matches the Prisma query includes used in handlePaymentSuccess
 */
type PaymentWithUser = Prisma.PaymentGetPayload<{
  include: {
    user: {
      include: { consulteeProfile: true };
    };
  };
}>;

/**
 * Data required to create a consultation appointment
 */
interface ConsultationData {
  planId: string;
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
  notes?: string;
  consulteeProfileId: string;
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
 * Handle successful payment - creates or confirms appointments
 * Used by both webhook handlers and mock payment flows
 */
export async function handlePaymentSuccess(
  paymentIntentId: string,
  metadata: Record<string, string>,
): Promise<void> {
  return await prisma.$transaction(async (tx) => {
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
      return;
    }

    // VALIDATION: Check metadata before processing
    try {
      validateWebhookMetadata(metadata);
    } catch (validationError) {
      const errorMessage =
        validationError instanceof ZodError
          ? validationError.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")
          : validationError instanceof Error
            ? validationError.message
            : String(validationError);

      console.error(
        `❌ Metadata validation failed for payment ${paymentIntentId}:`,
        errorMessage,
      );

      // Mark payment as succeeded but flag for manual review
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          paymentStatus: PaymentStatus.SUCCEEDED,
          // Store error in description for manual recovery
          description: `Metadata validation failed: ${errorMessage}. Manual recovery required via admin panel.`,
        },
      });

      // Alert for monitoring
      console.error(
        `⚠️ ALERT: Payment ${payment.id} succeeded but appointment creation blocked due to invalid metadata. User: ${payment.userId}`,
      );

      // Exit early - appointment not created, requires manual intervention
      return;
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: { paymentStatus: PaymentStatus.SUCCEEDED },
    });

    let appointment;
    if (payment.appointmentId) {
      appointment = await tx.appointment.findUnique({
        where: { id: payment.appointmentId },
      });
    } else {
      appointment = await createAppointmentFromWebhook(tx, metadata, payment);
    }

    if (!appointment) {
      throw new Error("Failed to create or find appointment");
    }

    await confirmExistingAppointment(tx, appointment.id);

    // Send payment success email
    await sendPaymentSuccessNotification(
      tx,
      payment,
      appointment.id,
      metadata.appointmentType,
    );

    console.log(
      `✅ Payment ${paymentIntentId} processed successfully. Appointment ID: ${appointment.id}`,
    );
  });
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

    await tx.payment.update({
      where: { id: payment.id },
      data: { paymentStatus: PaymentStatus.FAILED },
    });

    if (payment.appointment) {
      await cleanupFailedPaymentAppointment(tx, payment.appointment.id);
    }

    // Send payment failure email
    await sendPaymentFailureNotification(tx, payment);

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
  tx: Prisma.TransactionClient,
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
      });
      break;
    case AppointmentsType.SUBSCRIPTION:
      appointment = await createSubscription(tx, {
        planId,
        slotStartTimeInUTC,
        slotEndTimeInUTC,
        schedulingPeriodStartsAt,
        schedulingPeriodEndsAt,
        notes,
        consulteeProfileId,
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

async function createConsultation(
  tx: Prisma.TransactionClient,
  data: ConsultationData,
) {
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
        },
      },
    },
    include: {
      slotsOfAppointment: true,
    },
  });
}

async function createSubscription(
  tx: Prisma.TransactionClient,
  data: SubscriptionData,
) {
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
  if (!isSchedulingPeriodRequest && data.slotStartTimeInUTC && data.slotEndTimeInUTC) {
    appointmentData.slotsOfAppointment = {
      create: {
        startsAt: new Date(data.slotStartTimeInUTC),
        endsAt: new Date(data.slotEndTimeInUTC),
        isTentative: false,
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

async function createWebinar(
  tx: Prisma.TransactionClient,
  data: EventData,
) {
  const webinar = await tx.webinar.findUnique({
    where: { id: data.eventId },
    include: { appointment: { include: { slotsOfAppointment: true } } },
  });
  if (!webinar) throw new Error("Webinar not found");

  let appointment = webinar.appointment;
  if (!appointment) {
    appointment = await tx.appointment.create({
      data: {
        appointmentType: AppointmentsType.WEBINAR,
        webinarId: webinar.id,
      },
      include: {
        slotsOfAppointment: true,
      },
    });
  }

  await tx.slotOfAppointment.create({
    data: {
      appointmentId: appointment.id,
      startsAt:
        webinar.appointment?.slotsOfAppointment[0]?.startsAt || new Date(),
      endsAt: webinar.appointment?.slotsOfAppointment[0]?.endsAt || new Date(),
      isTentative: false,
      user: { connect: { id: data.userId } },
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

async function createClass(
  tx: Prisma.TransactionClient,
  data: EventData,
) {
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
  tx: Prisma.TransactionClient,
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

    // If status is APPROVED_PENDING_PAYMENT, confirm the appointment
    if (subscription.requestStatus === RequestStatus.APPROVED_PENDING_PAYMENT) {
      await tx.subscription.update({
        where: { id: entityId },
        data: { requestStatus: RequestStatus.APPROVED },
      });
      console.log(
        `✅ Subscription ${entityId} payment completed - moving from APPROVED_PENDING_PAYMENT to APPROVED`,
      );
    } else if (subscription.requestStatus !== RequestStatus.APPROVED) {
      // Only update if not already approved
      await tx.subscription.update({
        where: { id: entityId },
        data: { requestStatus: RequestStatus.APPROVED },
      });
    }
  }
}

/**
 * Confirm appointment by making slots non-tentative and updating status
 */
async function confirmExistingAppointment(
  tx: Prisma.TransactionClient,
  appointmentId: string,
) {
  await tx.slotOfAppointment.updateMany({
    where: { appointmentId },
    data: { isTentative: false },
  });

  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: true,
      subscription: true,
      webinar: true,
      class: true,
    },
  });

  // Use helper for consultation and subscription
  if (appointment?.consultation) {
    await confirmApprovalStatus(tx, "consultation", appointment.consultation.id);
  }

  if (appointment?.subscription) {
    await confirmApprovalStatus(tx, "subscription", appointment.subscription.id);
  }
  if (appointment?.webinar) {
    await tx.webinar.update({
      where: { id: appointment.webinar.id },
      data: { status: "SCHEDULED" },
    });
  }
  if (appointment?.class) {
    await tx.class.update({
      where: { id: appointment.class.id },
      data: { status: "SCHEDULED" },
    });
  }
}

/**
 * Clean up tentative appointments for failed payments
 */
async function cleanupFailedPaymentAppointment(
  tx: Prisma.TransactionClient,
  appointmentId: string,
) {
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
        if (appointment.consultation) {
          await tx.consultation.delete({
            where: { id: appointment.consultation.id },
          });
        }
        if (appointment.subscription) {
          await tx.subscription.delete({
            where: { id: appointment.subscription.id },
          });
        }
        await tx.appointment.delete({ where: { id: appointmentId } });
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
  tx: Prisma.TransactionClient,
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
      },
    });

    if (!appointment) {
      console.error(
        `Cannot send payment success email: appointment ${appointmentId} not found`,
      );
      return;
    }

    let consultantName = "Consultant";
    let amount = payment.amount;
    let currency = payment.currency;

    // Get consultant name based on appointment type
    if (appointment.consultation?.consultationPlan?.consultantProfile?.user) {
      consultantName =
        appointment.consultation.consultationPlan.consultantProfile.user.name ||
        "Consultant";
    } else if (appointment.subscription?.subscriptionPlan?.consultantProfile?.user) {
      consultantName =
        appointment.subscription.subscriptionPlan.consultantProfile.user.name ||
        "Consultant";
    }

    // Send email
    await sendPaymentSuccessEmail({
      email: payment.user.email || "",
      name: payment.user.name || "User",
      consultantName,
      appointmentType:
        appointmentType === "CONSULTATION" ? "consultation" : "subscription",
      amount,
      currency,
      dashboardUrl: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
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
  tx: Prisma.TransactionClient,
  payment: Prisma.PaymentGetPayload<{
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
  }>,
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
    let retryUrl = `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`;

    // Get consultant name and appointment type
    if (appointment.consultation?.consultationPlan?.consultantProfile?.user) {
      consultantName =
        appointment.consultation.consultationPlan.consultantProfile.user.name ||
        "Consultant";
      appointmentType = "consultation";
      retryUrl = `${process.env.NEXT_PUBLIC_APP_URL}/consultations/${appointment.consultation.id}/payment`;
    } else if (appointment.subscription?.subscriptionPlan?.consultantProfile?.user) {
      consultantName =
        appointment.subscription.subscriptionPlan.consultantProfile.user.name ||
        "Consultant";
      appointmentType = "subscription";
      retryUrl = `${process.env.NEXT_PUBLIC_APP_URL}/subscriptions/${appointment.subscription.id}/payment`;
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

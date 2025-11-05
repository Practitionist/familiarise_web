import { createPaymentIntent } from "@/lib/payment";
import prisma from "@/lib/prisma";
import { CheckoutInput, checkoutSchema } from "@/schemas/checkout";
import { AppErrors, ErrorLogger } from "@/utils/errorHandling";
import {
  AppointmentsType,
  ClassStatus,
  PaymentGateway,
  PaymentStatus,
  Prisma,
  RequestStatus,
  WebinarStatus,
} from "@prisma/client";
import { calculateSubscriptionEndDate } from "@/utils/dateUtils";

// Re-export for backward compatibility
export const unifiedCheckoutSchema = checkoutSchema;
export type { CheckoutInput };

// Enhanced payment intent management with comprehensive cleanup
export class PaymentIntentManager {
  private static activeIntents = new Map<string, {
    userId: string;
    createdAt: number;
    paymentGateway: PaymentGateway;
  }>();

  // Cleanup old tracking entries periodically
  private static cleanupTracker() {
    const now = Date.now();
    const expiredThreshold = 60 * 60 * 1000; // 1 hour

    for (const [intentId, data] of Array.from(this.activeIntents.entries())) {
      if (now - data.createdAt > expiredThreshold) {
        this.activeIntents.delete(intentId);
      }
    }
  }

  static async createWithCleanup(params: {
    amount: number;
    currency: string;
    metadata: {
      appointmentId: string;
      appointmentType: string;
      userId: string;
      [key: string]: string;
    };
    paymentGateway: PaymentGateway;
  }) {
    try {
      const paymentResponse = await createPaymentIntent(params);

      // Track the intent for potential cleanup
      this.activeIntents.set(paymentResponse.id, {
        userId: params.metadata.userId,
        createdAt: Date.now(),
        paymentGateway: params.paymentGateway,
      });

      // Periodic cleanup of tracking
      if (this.activeIntents.size % 100 === 0) {
        this.cleanupTracker();
      }


      ErrorLogger.info("Payment intent created and tracked", {
        intentId: paymentResponse.id,
        gateway: params.paymentGateway,
        userId: params.metadata.userId,
      });

      return paymentResponse;
    } catch (error) {
      ErrorLogger.error("Payment intent creation failed", error, params);
      throw AppErrors.paymentProcessingError(
        "Failed to create payment intent. Please try again later."
      );
    }
  }

  static async cancelIntent(
    intentId: string,
    reason: string = "Database operation failed",
  ) {
    try {
      const trackedIntent = this.activeIntents.get(intentId);
      
      // Import and use the payment library cancellation
      const { cancelPaymentIntent } = await import("@/lib/payment");

      if (typeof cancelPaymentIntent === "function") {
        await cancelPaymentIntent(intentId, reason);
        
        ErrorLogger.info("Payment intent cancelled successfully", {
          intentId,
          reason,
          gateway: trackedIntent?.paymentGateway,
        });
      } else {
        ErrorLogger.warn("Payment intent cancellation not implemented", {
          intentId,
          reason,
        });
      }

      // Remove from tracking
      this.activeIntents.delete(intentId);
    } catch (error) {
      ErrorLogger.error("Failed to cancel payment intent", error, {
        intentId,
        reason,
      });
      // Don't throw here - this is cleanup, shouldn't break the main flow
    }
  }

  static async cleanup(intentId: string, reason: string) {
    if (this.activeIntents.has(intentId)) {
      await this.cancelIntent(intentId, reason);
    } else {
      // Even if not tracked, try to cancel (might be from previous session)
      try {
        await this.cancelIntent(intentId, reason);
      } catch (error) {
        ErrorLogger.warn("Failed to cleanup untracked payment intent", {
          intentId,
          reason,
          error,
        });
      }
    }
  }

  // Bulk cleanup method for scheduled jobs
  static async bulkCleanup(intentIds: string[], reason: string): Promise<{
    successful: number;
    failed: number;
  }> {
    let successful = 0;
    let failed = 0;

    for (const intentId of intentIds) {
      try {
        await this.cleanup(intentId, reason);
        successful++;
      } catch (error) {
        failed++;
        ErrorLogger.warn("Bulk cleanup failed for intent", {
          intentId,
          error,
        });
      }
    }


    ErrorLogger.info("Bulk payment intent cleanup completed", {
      successful,
      failed,
      total: intentIds.length,
      reason,
    });

    return { successful, failed };
  }

  // Get cleanup statistics
  static getTrackedIntents(): {
    totalTracked: number;
    oldestIntent: number | null;
    gatewayBreakdown: Record<PaymentGateway, number>;
  } {
    const _now = Date.now();
    const gatewayBreakdown: Record<PaymentGateway, number> = {
      STRIPE: 0,
      RAZORPAY: 0,
      LEMON_SQUEEZY: 0,
      XFLOW: 0,
      CARD: 0,
    };

    let oldestIntent: number | null = null;

    for (const [_, data] of Array.from(this.activeIntents.entries())) {
      (gatewayBreakdown as any)[data.paymentGateway]++;
      
      if (oldestIntent === null || data.createdAt < oldestIntent) {
        oldestIntent = data.createdAt;
      }
    }

    return {
      totalTracked: this.activeIntents.size,
      oldestIntent,
      gatewayBreakdown,
    };
  }
}

// Optimized amount calculation and validation with minimal transaction scope
export async function calculateAmountAndValidate(
  validatedData: CheckoutInput,
  userId: string,
) {
  // First, verify user exists outside transaction for better performance
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      consulteeProfile: {
        select: { id: true } // Only select what we need
      },
    },
  });

  if (!user?.consulteeProfile) {
    throw AppErrors.notFound("User profile");
  }

  const consulteeProfileId = user.consulteeProfile.id;

  // Use read transaction for validation and amount calculation
  return await prisma.$transaction(async (tx) => {
    let amount = 0;
    let plan;

    // Get plan and validate availability without creating records
    switch (validatedData.appointmentType) {
      case "CONSULTATION":
        plan = await tx.consultationPlan.findUnique({
          where: { id: validatedData.planId },
          select: {
            id: true,
            price: true,
            consultantProfile: {
              select: {
                id: true,
                user: {
                  select: { id: true, name: true }
                }
              }
            }
          },
        });

        if (!plan) {
          throw AppErrors.notFound("Consultation plan", validatedData.planId);
        }

        await validateSlotAvailability(
          tx,
          validatedData,
          consulteeProfileId,
        );
        amount = plan.price;
        break;

      case "SUBSCRIPTION":
        plan = await tx.subscriptionPlan.findUnique({
          where: { id: validatedData.planId },
          select: {
            id: true,
            price: true,
            durationInMonths: true,
            consultantProfile: {
              select: {
                id: true,
                user: {
                  select: { id: true, name: true }
                }
              }
            }
          },
        });

        if (!plan) {
          throw AppErrors.notFound("Subscription plan", validatedData.planId);
        }

        await validateSlotAvailability(
          tx,
          validatedData,
          consulteeProfileId,
        );
        amount = plan.price;
        break;

      case "WEBINAR":
        if (!validatedData.eventId) {
          throw AppErrors.invalidInput("Event ID is required for webinar");
        }
        const webinar = await tx.webinar.findUnique({
          where: { id: validatedData.eventId },
          select: {
            id: true,
            webinarPlan: {
              select: {
                id: true,
                price: true,
                maxParticipants: true,
              }
            },
            appointment: {
              select: {
                slotsOfAppointment: {
                  select: { id: true } // Just count
                }
              }
            },
          },
        });

        if (!webinar) {
          throw AppErrors.notFound("Webinar", validatedData.eventId);
        }

        plan = webinar.webinarPlan;
        const currentWebinarParticipants =
          webinar.appointment?.slotsOfAppointment?.length ?? 0;

        if (currentWebinarParticipants >= plan.maxParticipants) {
          throw AppErrors.maxParticipantsReached("Webinar", plan.maxParticipants);
        }

        amount = plan.price;
        break;

      case "CLASS":
        if (!validatedData.eventId) {
          throw new Error("Event ID is required for class");
        }
        const classInstance = await tx.class.findUnique({
          where: { id: validatedData.eventId },
          include: {
            classPlan: true,
            appointments: {
              include: {
                slotsOfAppointment: true,
              },
            },
          },
        });

        if (!classInstance) {
          throw new Error("Class not found");
        }

        plan = classInstance.classPlan;
        const currentClassParticipants = classInstance.appointments.reduce(
          (total: number, apt: any) => total + apt.slotsOfAppointment.length,
          0,
        );

        if (currentClassParticipants >= plan.maxParticipants) {
          throw new Error("Class is full");
        }

        amount = plan.price;
        break;

      default:
        throw new Error("Invalid appointment type");
    }

    // Apply discount if provided
    let discountCodeId = null;
    if (validatedData.discountCode) {
      const discount = await tx.discountCode.findUnique({
        where: { code: validatedData.discountCode },
      });

      if (discount) {
        discountCodeId = discount.id;
        amount =
          discount.discountType === "PERCENTAGE"
            ? amount * (1 - discount.discountValue / 100)
            : Math.max(0, amount - discount.discountValue);
      }
    }

    const currency =
      validatedData.paymentGateway === "RAZORPAY" ? "INR" : "USD";

    return { amount, currency, discountCodeId };
  });
}

// Optimized slot availability validation with better query structure
export async function validateSlotAvailability(
  tx: any,
  data: CheckoutInput,
  userId?: string,
) {
  if (!data.slotStartTimeInUTC || !data.slotEndTimeInUTC) return;

  const slotStart = new Date(data.slotStartTimeInUTC);
  const slotEnd = new Date(data.slotEndTimeInUTC);

  // 1. Check for confirmed overlapping appointments (optimized query)
  const existingBooking = await tx.slotOfAppointment.findFirst({
    where: {
      isTentative: false, // Use indexed field first
      OR: [
        {
          OR: [
            {
              AND: [
                { startsAt: { lte: slotStart } },
                { endsAt: { gt: slotStart } },
              ],
            },
            {
              AND: [
                { startsAt: { lt: slotEnd } },
                { endsAt: { gte: slotEnd } },
              ],
            },
          ],
        },
      ],
    },
    select: { id: true }, // Only select what we need
  });

  if (existingBooking) {
    throw AppErrors.slotUnavailable("Time slot is already booked");
  }

  // 2. Check for duplicate tentative bookings by the same user (NEW)
  if (userId) {
    const recentAttempt = await tx.slotOfAppointment.findFirst({
      where: {
        AND: [
          {
            OR: [
              {
                AND: [
                  { startsAt: { lte: slotStart } },
                  { endsAt: { gt: slotStart } },
                ],
              },
              {
                AND: [
                  { startsAt: { lt: slotEnd } },
                  { endsAt: { gte: slotEnd } },
                ],
              },
            ],
          },
          { isTentative: true },
          {
            appointment: {
              payment: {
                some: {
                  AND: [
                    { userId: userId },
                    { paymentStatus: "PENDING" },
                    {
                      OR: [
                        { expiresAt: { gt: new Date() } }, // Not yet expired
                        {
                          AND: [
                            { expiresAt: null }, // No expiration set
                            {
                              createdAt: {
                                gte: new Date(Date.now() - 5 * 60 * 1000),
                              },
                            }, // Within 5 min
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        ],
      },
      include: {
        appointment: {
          include: {
            payment: true,
          },
        },
      },
    });

    if (recentAttempt) {
      throw AppErrors.bookingConflict(
        "You already have a pending booking for this time slot. Please complete your current payment or wait a few minutes to try again.",
      );
    }
  }

  // 3. Check for excessive tentative bookings in general (rate limiting)
  const tentativeCount = await tx.slotOfAppointment.count({
    where: {
      AND: [
        {
          OR: [
            {
              AND: [
                { startsAt: { lte: slotStart } },
                { endsAt: { gt: slotStart } },
              ],
            },
            {
              AND: [
                { startsAt: { lt: slotEnd } },
                { endsAt: { gte: slotEnd } },
              ],
            },
          ],
        },
        { isTentative: true },
        {
          appointment: {
            payment: {
              some: {
                AND: [
                  { paymentStatus: "PENDING" },
                  {
                    OR: [
                      { expiresAt: { gt: new Date() } }, // Not yet expired
                      {
                        AND: [
                          { expiresAt: null }, // No expiration set
                          {
                            createdAt: {
                              gte: new Date(Date.now() - 30 * 60 * 1000),
                            },
                          }, // Within 30 min
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      ],
    },
  });

  // Allow max 3 pending attempts for the same slot (prevents spam)
  if (tentativeCount >= 3) {
    throw AppErrors.availabilityError(
      "This time slot is temporarily unavailable due to high demand. Please try again later.",
    );
  }
}

// Shared appointment creation functions
export async function handleConsultationCheckout(
  tx: Prisma.TransactionClient,
  data: CheckoutInput,
  consulteeProfileId: string,
  skipPayment: boolean,
) {
  const plan = await tx.consultationPlan.findUnique({
    where: { id: data.planId },
    include: {
      consultantProfile: {
        include: {
          user: true,
        },
      },
    },
  });

  if (!plan) {
    throw new Error("Consultation plan not found");
  }

  // Check slot availability
  await validateSlotAvailability(tx, data, consulteeProfileId);

  // Create consultation
  const consultation = await tx.consultation.create({
    data: {
      consultationPlanId: plan.id,
      requestStatus: skipPayment
        ? RequestStatus.APPROVED
        : RequestStatus.PENDING,
      requestedById: consulteeProfileId,
      requestNotes: data.notes,
      bookingSource: "DIRECT_CHECKOUT",
    },
  });

  // Create appointment
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.CONSULTATION,
      consultationId: consultation.id,
      slotsOfAppointment: {
        create: {
          startsAt: new Date(data.slotStartTimeInUTC!),
          endsAt: new Date(data.slotEndTimeInUTC!),
          isTentative: !skipPayment,
        },
      },
    },
  });

  return { appointment, plan, amount: plan.price };
}

export async function handleSubscriptionCheckout(
  tx: any,
  data: CheckoutInput,
  consulteeProfileId: string,
  skipPayment: boolean,
) {
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: data.planId },
    include: {
      consultantProfile: {
        include: {
          user: true,
        },
      },
    },
  });

  if (!plan) {
    throw new Error("Subscription plan not found");
  }

  // Check slot availability
  await validateSlotAvailability(tx, data, consulteeProfileId);

  // FIXED: Calculate subscription end date with proper month-end handling
  const startDate = new Date();
  const endDate = calculateSubscriptionEndDate(
    startDate,
    plan.durationInMonths,
  );

  // Create subscription
  const subscription = await tx.subscription.create({
    data: {
      subscriptionPlanId: plan.id,
      requestStatus: skipPayment
        ? RequestStatus.APPROVED
        : RequestStatus.PENDING,
      requestedById: consulteeProfileId,
      requestNotes: data.notes,
      bookingSource: "DIRECT_CHECKOUT",
      schedulingPeriodStartsAt: startDate,
      schedulingPeriodEndsAt: endDate,
    },
  });

  // Create appointment
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.SUBSCRIPTION,
      subscriptionId: subscription.id,
      slotsOfAppointment: {
        create: {
          startsAt: new Date(data.slotStartTimeInUTC!),
          endsAt: new Date(data.slotEndTimeInUTC!),
          isTentative: !skipPayment,
        },
      },
    },
  });

  return { appointment, plan, amount: plan.price };
}

export async function handleWebinarCheckout(
  tx: any,
  data: CheckoutInput,
  userId: string,
  skipPayment: boolean,
) {
  const webinar = await tx.webinar.findUnique({
    where: { id: data.eventId },
    include: {
      webinarPlan: true,
      waitlist: true,
      appointment: {
        include: {
          slotsOfAppointment: true,
        },
      },
    },
  });

  if (!webinar) {
    throw new Error("Webinar not found");
  }

  const plan = webinar.webinarPlan;
  const currentParticipants =
    webinar.appointment?.slotsOfAppointment?.length || 0;

  // Check if max participants reached
  if (currentParticipants >= plan.maxParticipants) {
    if (skipPayment) {
      // Add to waitlist
      await tx.waitlist.create({
        data: {
          userId,
          webinarId: webinar.id,
        },
      });

      throw new Error("Webinar is full. Added to waitlist.");
    } else {
      throw new Error("Webinar is full");
    }
  }

  // Create appointment (reuse existing one or create new)
  let appointment = webinar.appointment;
  if (!appointment) {
    appointment = await tx.appointment.create({
      data: {
        appointmentType: AppointmentsType.WEBINAR,
        webinarId: webinar.id,
      },
    });
  }

  // Add user to webinar
  await tx.slotOfAppointment.create({
    data: {
      appointmentId: appointment.id,
      startsAt:
        webinar.appointment?.slotsOfAppointment[0]?.startsAt || new Date(),
      endsAt: webinar.appointment?.slotsOfAppointment[0]?.endsAt || new Date(),
      isTentative: !skipPayment,
      user: {
        connect: { id: userId },
      },
    },
  });

  return { appointment, plan, amount: plan.price };
}

export async function handleClassCheckout(
  tx: any,
  data: CheckoutInput,
  userId: string,
  skipPayment: boolean,
) {
  const classInstance = await tx.class.findUnique({
    where: { id: data.eventId },
    include: {
      classPlan: true,
      waitlist: true,
      appointments: {
        include: {
          slotsOfAppointment: true,
        },
      },
    },
  });

  if (!classInstance) {
    throw new Error("Class not found");
  }

  const plan = classInstance.classPlan;
  const currentParticipants = classInstance.appointments.reduce(
    (total: number, apt: any) => total + apt.slotsOfAppointment.length,
    0,
  );

  // Check if max participants reached
  if (currentParticipants >= plan.maxParticipants) {
    if (skipPayment) {
      // Add to waitlist
      await tx.waitlist.create({
        data: {
          userId,
          classId: classInstance.id,
        },
      });

      throw new Error("Class is full. Added to waitlist.");
    } else {
      throw new Error("Class is full");
    }
  }

  // Create appointment for class
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.CLASS,
      classId: classInstance.id,
      slotsOfAppointment: {
        create: {
          startsAt: classInstance.schedulingPeriodStartsAt || new Date(),
          endsAt: classInstance.schedulingPeriodEndsAt || new Date(),
          isTentative: !skipPayment,
          user: {
            connect: { id: userId },
          },
        },
      },
    },
  });

  return { appointment, plan, amount: plan.price };
}

// Shared appointment confirmation
export async function confirmAppointment(
  tx: any,
  appointmentId: string,
  _appointmentType: string,
) {
  // Make slot non-tentative
  await tx.slotOfAppointment.updateMany({
    where: { appointmentId },
    data: { isTentative: false },
  });

  // Update specific appointment type status
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: true,
      subscription: true,
      webinar: true,
      class: true,
    },
  });

  if (appointment?.consultation) {
    await tx.consultation.update({
      where: { id: appointment.consultation.id },
      data: { requestStatus: RequestStatus.APPROVED },
    });
  }

  if (appointment?.subscription) {
    await tx.subscription.update({
      where: { id: appointment.subscription.id },
      data: { requestStatus: RequestStatus.APPROVED },
    });
  }

  if (appointment?.webinar) {
    await tx.webinar.update({
      where: { id: appointment.webinar.id },
      data: { status: WebinarStatus.SCHEDULED },
    });
  }

  if (appointment?.class) {
    await tx.class.update({
      where: { id: appointment.class.id },
      data: { status: ClassStatus.SCHEDULED },
    });
  }
}

// Optimized production checkout flow with better transaction management
export async function handleProductionCheckout(
  validatedData: CheckoutInput,
  userId: string,
) {
  ErrorLogger.info("Starting production checkout flow", {
    userId,
    appointmentType: validatedData.appointmentType,
    planId: validatedData.planId,
  });

  // Step 1: Calculate amount and validate data (optimized with read transaction)
  const { amount, currency, discountCodeId } = await calculateAmountAndValidate(
    validatedData,
    userId,
  );

  ErrorLogger.info("Amount calculated and validated", {
    amount,
    currency,
    discountCodeId,
  });


  // Step 2: Create payment intent first (external API call)
  let paymentResponse;
  try {
    paymentResponse = await PaymentIntentManager.createWithCleanup({
      amount,
      currency,
      metadata: {
        appointmentId: "pending", // Will be created after payment
        appointmentType: validatedData.appointmentType,
        userId: userId,
        planId: validatedData.planId,
        slotStartTimeInUTC: validatedData.slotStartTimeInUTC ?? "",
        slotEndTimeInUTC: validatedData.slotEndTimeInUTC ?? "",
        slotOfAvailabilityWeeklyId:
          validatedData.slotOfAvailabilityWeeklyId ?? "",
        slotOfAvailabilityCustomId:
          validatedData.slotOfAvailabilityCustomId ?? "",
        discountCode: validatedData.discountCode ?? "",
        notes: validatedData.notes ?? "",
        ...(validatedData.eventId && { eventId: validatedData.eventId }),
      },
      paymentGateway: validatedData.paymentGateway,
    });

    ErrorLogger.info("Payment intent created successfully", {
      paymentIntentId: paymentResponse.id,
      gateway: validatedData.paymentGateway,
    });
  } catch (paymentError) {
    ErrorLogger.error("Payment intent creation failed", paymentError);
    throw AppErrors.paymentProcessingError(
      "Failed to create payment intent. Please try again later."
    );
  }

  // Step 3: Create ONLY payment record (no appointment yet) - minimal transaction
  try {
    const paymentRecord = await prisma.payment.create({
      data: {
        amount,
        currency,
        paymentMethod: "CARD",
        paymentIntent: paymentResponse.id,
        paymentGateway: validatedData.paymentGateway,
        paymentStatus: PaymentStatus.PENDING,
        userId: userId,
        appointmentId: null, // No appointment created yet
        discountCodeId,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes from now
      },
    });

    ErrorLogger.info("Payment record created successfully", {
      paymentId: paymentRecord.id,
      paymentIntentId: paymentResponse.id,
    });

    return {
      success: true,
      paymentIntent: paymentResponse,
      message: "Payment intent created. Complete payment to book appointment.",
      amount,
      currency,
    };
  } catch (dbError) {
    ErrorLogger.error("Failed to create payment record", dbError);

    // CRITICAL: Cancel the payment intent since DB operation failed
    await PaymentIntentManager.cleanup(
      paymentResponse.id,
      "Database operation failed - preventing orphaned payment intent",
    );

    throw AppErrors.databaseError("Failed to record payment information. Please try again.");
  }
}

// Development checkout flow
export async function handleDevelopmentCheckout(
  validatedData: CheckoutInput,
  userId: string,
) {
  const result = await prisma.$transaction(async (tx) => {
    let appointment;
    let _plan;
    let amount = 0;

    // Get user profile
    const user = await tx.user.findUnique({
      where: { id: userId },
      include: {
        consulteeProfile: true,
      },
    });

    if (!user?.consulteeProfile) {
      throw AppErrors.notFound("User profile");
    }

    // Handle different appointment types
    switch (validatedData.appointmentType) {
      case "CONSULTATION":
        ({ appointment, plan: _plan, amount } = await handleConsultationCheckout(
          tx,
          validatedData,
          user.consulteeProfile.id,
          true, // skipPayment = true for dev
        ));
        break;

      case "SUBSCRIPTION":
        ({ appointment, plan: _plan, amount } = await handleSubscriptionCheckout(
          tx,
          validatedData,
          user.consulteeProfile.id,
          true, // skipPayment = true for dev
        ));
        break;

      case "WEBINAR":
        ({ appointment, plan: _plan, amount } = await handleWebinarCheckout(
          tx,
          validatedData,
          userId,
          true, // skipPayment = true for dev
        ));
        break;

      case "CLASS":
        ({ appointment, plan: _plan, amount } = await handleClassCheckout(
          tx,
          validatedData,
          userId,
          true, // skipPayment = true for dev
        ));
        break;

      default:
        throw new Error("Invalid appointment type");
    }

    // Apply discount if provided
    let discountCodeId = null;
    if (validatedData.discountCode) {
      const discount = await tx.discountCode.findUnique({
        where: { code: validatedData.discountCode },
      });

      if (discount) {
        discountCodeId = discount.id;
        amount =
          discount.discountType === "PERCENTAGE"
            ? amount * (1 - discount.discountValue / 100)
            : Math.max(0, amount - discount.discountValue);
      }
    }

    // Create successful payment record for skipped payment
    await tx.payment.create({
      data: {
        amount,
        currency: validatedData.paymentGateway === "RAZORPAY" ? "INR" : "USD",
        paymentMethod: "SKIPPED",
        paymentIntent: `skip_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        paymentGateway: validatedData.paymentGateway,
        paymentStatus: PaymentStatus.SUCCEEDED,
        userId: userId,
        appointmentId: appointment.id,
        discountCodeId,
      },
    });

    // Immediately confirm the appointment
    await confirmAppointment(tx, appointment.id, validatedData.appointmentType);

    return {
      success: true,
      message: "Appointment booked successfully (payment skipped)",
      appointmentId: appointment.id,
      skipPayment: true,
    };
  });

  return result;
}

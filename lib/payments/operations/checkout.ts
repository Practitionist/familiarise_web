/**
 * Checkout Operations
 * Handles the complete checkout flow for all appointment types
 */

import { CheckoutInput, checkoutSchema } from "@/schemas/checkout";
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
import { createPaymentIntent, cancelPaymentIntent } from "../index";
import { isMockPaymentId } from "./mock";
import { withPaymentTransaction, createPaymentRecord } from "../core/transactions";
import prisma from "@/lib/prisma";

// Re-export for backward compatibility
export const unifiedCheckoutSchema = checkoutSchema;
export type { CheckoutInput };

// ============================================================================
// Payment Intent Manager
// ============================================================================

/**
 * Manages payment intent creation and cleanup with proper error handling
 */
export class PaymentIntentManager {
  private static activeIntents = new Map<string, string>(); // intentId -> userId

  /**
   * Create payment intent with automatic cleanup tracking
   */
  static async createWithCleanup(params: {
    amount: number;
    currency: string;
    metadata: {
      appointmentId: string;
      appointmentType: string;
      [key: string]: string;
    };
    paymentGateway: PaymentGateway;
    isMockPayment?: boolean;
  }) {
    try {
      const paymentResponse = await createPaymentIntent(params);

      // Track the intent for potential cleanup
      this.activeIntents.set(paymentResponse.id, params.metadata.userId || "unknown");

      return paymentResponse;
    } catch (error) {
      console.error("Payment intent creation failed:", error);
      throw new Error(
        "Failed to create payment intent. Please try again later.",
      );
    }
  }

  /**
   * Cancel a payment intent and clean up tracking
   */
  static async cancelIntent(
    intentId: string,
    reason: string = "Database operation failed",
  ) {
    try {
      await cancelPaymentIntent(intentId, reason);
      this.activeIntents.delete(intentId);
    } catch (error) {
      console.error(`Failed to cancel payment intent ${intentId}:`, error);
      // Don't throw - cleanup should be best-effort
    }
  }

  /**
   * Cleanup tracked payment intent
   */
  static async cleanup(intentId: string, reason: string) {
    if (this.activeIntents.has(intentId)) {
      await this.cancelIntent(intentId, reason);
    }
  }
}

// ============================================================================
// Amount Calculation and Validation
// ============================================================================

/**
 * Calculate final amount with discount and validate plan availability
 * Does NOT create any appointment records - only validates
 */
export async function calculateAmountAndValidate(
  validatedData: CheckoutInput,
  userId: string,
) {
  return await prisma.$transaction(async (tx) => {
    let amount = 0;
    let plan;

    // Get user profile
    const user = await tx.user.findUnique({
      where: { id: userId },
      include: {
        consulteeProfile: true,
      },
    });

    if (!user?.consulteeProfile) {
      throw new Error("User profile not found");
    }

    // Get plan and validate availability without creating records
    switch (validatedData.appointmentType) {
      case "CONSULTATION":
        plan = await tx.consultationPlan.findUnique({
          where: { id: validatedData.planId },
          include: {
            consultantProfile: {
              include: { user: true },
            },
          },
        });

        if (!plan) {
          throw new Error("Consultation plan not found");
        }

        await validateSlotAvailability(
          tx,
          validatedData,
          user.consulteeProfile.id,
        );
        amount = plan.price;
        break;

      case "SUBSCRIPTION":
        plan = await tx.subscriptionPlan.findUnique({
          where: { id: validatedData.planId },
          include: {
            consultantProfile: {
              include: { user: true },
            },
          },
        });

        if (!plan) {
          throw new Error("Subscription plan not found");
        }

        await validateSlotAvailability(
          tx,
          validatedData,
          user.consulteeProfile.id,
        );
        amount = plan.price;
        break;

      case "WEBINAR":
        if (!validatedData.eventId) {
          throw new Error("Event ID is required for webinar");
        }
        const webinar = await tx.webinar.findUnique({
          where: { id: validatedData.eventId },
          include: {
            webinarPlan: true,
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

        plan = webinar.webinarPlan;
        const currentWebinarParticipants =
          webinar.appointment?.slotsOfAppointment?.length || 0;

        if (currentWebinarParticipants >= plan.maxParticipants) {
          throw new Error("Webinar is full");
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
          (total: number, apt: { slotsOfAppointment: unknown[] }) =>
            total + apt.slotsOfAppointment.length,
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

// ============================================================================
// Slot Availability Validation
// ============================================================================

/**
 * Validate slot availability with protection against race conditions
 * Checks for:
 * 1. Confirmed overlapping bookings
 * 2. Duplicate tentative bookings by same user
 * 3. Excessive tentative bookings (rate limiting)
 */
export async function validateSlotAvailability(
  tx: Prisma.TransactionClient,
  data: CheckoutInput,
  userId?: string,
) {
  if (!data.slotStartTimeInUTC || !data.slotEndTimeInUTC) return;

  const slotStart = new Date(data.slotStartTimeInUTC);
  const slotEnd = new Date(data.slotEndTimeInUTC);

  // 1. Check for confirmed overlapping appointments
  const existingBooking = await tx.slotOfAppointment.findFirst({
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
        { isTentative: false }, // Only confirmed bookings
      ],
    },
  });

  if (existingBooking) {
    throw new Error("Time slot is already booked");
  }

  // 2. Check for duplicate tentative bookings by the same user
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
    });

    if (recentAttempt) {
      throw new Error(
        "You already have a pending booking for this time slot. Please complete your current payment or wait a few minutes to try again.",
      );
    }
  }

  // 3. Check for excessive tentative bookings (rate limiting)
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
                      { expiresAt: { gt: new Date() } },
                      {
                        AND: [
                          { expiresAt: null },
                          {
                            createdAt: {
                              gte: new Date(Date.now() - 30 * 60 * 1000),
                            },
                          },
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

  // Allow max 3 pending attempts for the same slot
  if (tentativeCount >= 3) {
    throw new Error(
      "This time slot is temporarily unavailable due to high demand. Please try again later.",
    );
  }
}

// ============================================================================
// Appointment Creation Handlers (Type-Specific)
// ============================================================================

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
        include: { user: true },
      },
    },
  });

  if (!plan) {
    throw new Error("Consultation plan not found");
  }

  // Validate slot availability
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
  tx: Prisma.TransactionClient,
  data: CheckoutInput,
  consulteeProfileId: string,
  skipPayment: boolean,
) {
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: data.planId },
    include: {
      consultantProfile: {
        include: { user: true },
      },
    },
  });

  if (!plan) {
    throw new Error("Subscription plan not found");
  }

  // Validate slot availability
  await validateSlotAvailability(tx, data, consulteeProfileId);

  // Calculate subscription dates
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
  tx: Prisma.TransactionClient,
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

  // Create or reuse appointment
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
  tx: Prisma.TransactionClient,
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
    (total: number, apt: { slotsOfAppointment: unknown[] }) =>
      total + apt.slotsOfAppointment.length,
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

  // Create appointment
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

// ============================================================================
// Appointment Confirmation
// ============================================================================

/**
 * Confirm appointment by making slots non-tentative and updating status
 */
export async function confirmAppointment(
  tx: Prisma.TransactionClient,
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

// ============================================================================
// Main Checkout Flows
// ============================================================================

/**
 * Production checkout flow (real payments)
 * Steps:
 * 1. Validate data and calculate amount
 * 2. Create payment intent with gateway
 * 3. Create payment record with PENDING status
 * 4. Return payment intent for client to complete
 * 5. Appointment will be created via webhook after payment success
 */
export async function handleProductionCheckout(
  validatedData: CheckoutInput,
  userId: string,
  isMockPayment: boolean = false,
) {
  // Step 1: Calculate amount and validate
  const { amount, currency, discountCodeId } =
    await calculateAmountAndValidate(validatedData, userId);

  // Step 2: Create payment intent
  let paymentResponse;
  try {
    paymentResponse = await PaymentIntentManager.createWithCleanup({
      amount,
      currency,
      metadata: {
        appointmentId: "pending",
        appointmentType: validatedData.appointmentType,
        userId: userId,
        planId: validatedData.planId,
        slotStartTimeInUTC: validatedData.slotStartTimeInUTC || "",
        slotEndTimeInUTC: validatedData.slotEndTimeInUTC || "",
        slotOfAvailabilityWeeklyId:
          validatedData.slotOfAvailabilityWeeklyId || "",
        slotOfAvailabilityCustomId:
          validatedData.slotOfAvailabilityCustomId || "",
        discountCode: validatedData.discountCode || "",
        notes: validatedData.notes || "",
        ...(validatedData.eventId && { eventId: validatedData.eventId }),
      },
      paymentGateway: validatedData.paymentGateway,
      isMockPayment,
    });
  } catch (paymentError) {
    console.error("Payment intent creation failed:", paymentError);
    throw new Error("Failed to create payment intent. Please try again later.");
  }

  // Step 3: Create payment record
  try {
    await prisma.payment.create({
      data: {
        amount,
        currency,
        paymentMethod: "CARD",
        paymentIntent: paymentResponse.id,
        paymentGateway: validatedData.paymentGateway,
        paymentStatus: isMockPayment ? PaymentStatus.SUCCEEDED : PaymentStatus.PENDING,
        isMockPayment,
        userId: userId,
        appointmentId: null, // Created after payment success
        discountCodeId,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
      },
    });

    const logMessage = isMockPayment
      ? `🎭 Mock payment created: ${paymentResponse.id} - Bypassing gateway`
      : `💳 Payment intent created: ${paymentResponse.id} - Waiting for payment`;

    console.log(logMessage);

    return {
      success: true,
      paymentIntent: paymentResponse,
      message: isMockPayment
        ? "Mock payment created successfully"
        : "Payment intent created. Complete payment to book appointment.",
      amount,
      currency,
      isMockPayment,
    };
  } catch (dbError) {
    console.error("Failed to create payment record:", dbError);

    // CRITICAL: Cancel payment intent since DB operation failed
    await PaymentIntentManager.cleanup(
      paymentResponse.id,
      "Database operation failed - preventing orphaned payment intent",
    );

    throw new Error("Failed to record payment information. Please try again.");
  }
}

/**
 * Development checkout flow (skip payment entirely)
 * Creates appointment immediately with SUCCEEDED payment status
 *
 * @deprecated Use handleProductionCheckout with isMockPayment=true instead
 */
export async function handleDevelopmentCheckout(
  validatedData: CheckoutInput,
  userId: string,
) {
  const result = await prisma.$transaction(async (tx) => {
    let appointment;
    let plan;
    let amount = 0;

    // Get user profile
    const user = await tx.user.findUnique({
      where: { id: userId },
      include: {
        consulteeProfile: true,
      },
    });

    if (!user?.consulteeProfile) {
      throw new Error("User profile not found");
    }

    // Handle different appointment types
    switch (validatedData.appointmentType) {
      case "CONSULTATION":
        ({ appointment, plan, amount } = await handleConsultationCheckout(
          tx,
          validatedData,
          user.consulteeProfile.id,
          true, // skipPayment = true
        ));
        break;

      case "SUBSCRIPTION":
        ({ appointment, plan, amount } = await handleSubscriptionCheckout(
          tx,
          validatedData,
          user.consulteeProfile.id,
          true,
        ));
        break;

      case "WEBINAR":
        ({ appointment, plan, amount } = await handleWebinarCheckout(
          tx,
          validatedData,
          userId,
          true,
        ));
        break;

      case "CLASS":
        ({ appointment, plan, amount } = await handleClassCheckout(
          tx,
          validatedData,
          userId,
          true,
        ));
        break;

      default:
        throw new Error("Invalid appointment type");
    }

    // Apply discount
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

    // Create successful payment record
    await tx.payment.create({
      data: {
        amount,
        currency: validatedData.paymentGateway === "RAZORPAY" ? "INR" : "USD",
        paymentMethod: "SKIPPED",
        paymentIntent: `skip_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        paymentGateway: validatedData.paymentGateway,
        paymentStatus: PaymentStatus.SUCCEEDED,
        isMockPayment: true,
        userId: userId,
        appointmentId: appointment.id,
        discountCodeId,
      },
    });

    // Confirm appointment
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

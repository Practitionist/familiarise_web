import { createPaymentIntent } from "@/lib/payment";
import prisma from "@/lib/prisma";
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

// Re-export for backward compatibility
export const unifiedCheckoutSchema = checkoutSchema;
export type { CheckoutInput };

// Payment intent management with proper cleanup
export class PaymentIntentManager {
  private static activeIntents = new Map<string, string>(); // intentId -> userId

  static async createWithCleanup(params: {
    amount: number;
    currency: string;
    metadata: {
      appointmentId: string;
      appointmentType: string;
      [key: string]: string;
    };
    paymentGateway: PaymentGateway;
  }) {
    try {
      const paymentResponse = await createPaymentIntent(params);

      // Track the intent for potential cleanup
      this.activeIntents.set(paymentResponse.id, params.metadata.userId);

      return paymentResponse;
    } catch (error) {
      console.error("Payment intent creation failed:", error);
      throw new Error(
        "Failed to create payment intent. Please try again later.",
      );
    }
  }

  static async cancelIntent(
    intentId: string,
    reason: string = "Database operation failed",
  ) {
    try {
      // TODO: Implement gateway-specific cancellation
      // For now, we'll import the payment library and cancel
      const { cancelPaymentIntent } = await import("@/lib/payment");

      if (typeof cancelPaymentIntent === "function") {
        await cancelPaymentIntent(intentId, reason);
        console.log(
          `🚫 Payment intent cancelled: ${intentId} - Reason: ${reason}`,
        );
      } else {
        console.warn(
          `⚠️ Payment intent cancellation not implemented for intent: ${intentId}`,
        );
      }

      // Remove from tracking
      this.activeIntents.delete(intentId);
    } catch (error) {
      console.error(`Failed to cancel payment intent ${intentId}:`, error);
      // Don't throw here - this is cleanup, shouldn't break the main flow
    }
  }

  static async cleanup(intentId: string, reason: string) {
    if (this.activeIntents.has(intentId)) {
      await this.cancelIntent(intentId, reason);
    }
  }
}

// Shared amount calculation and validation
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
              include: {
                user: true,
              },
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
              include: {
                user: true,
              },
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

// Shared slot availability validation
export async function validateSlotAvailability(
  tx: any,
  data: CheckoutInput,
  userId?: string,
) {
  if (!data.slotStartTimeInUTC || !data.slotEndTimeInUTC) return;

  const slotStart = new Date(data.slotStartTimeInUTC);
  const slotEnd = new Date(data.slotEndTimeInUTC);

  // 1. Check for confirmed overlapping appointments (existing logic)
  const existingBooking = await tx.slotOfAppointment.findFirst({
    where: {
      AND: [
        {
          OR: [
            {
              AND: [
                { slotStartTimeInUTC: { lte: slotStart } },
                { slotEndTimeInUTC: { gt: slotStart } },
              ],
            },
            {
              AND: [
                { slotStartTimeInUTC: { lt: slotEnd } },
                { slotEndTimeInUTC: { gte: slotEnd } },
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

  // 2. Check for duplicate tentative bookings by the same user (NEW)
  if (userId) {
    const recentAttempt = await tx.slotOfAppointment.findFirst({
      where: {
        AND: [
          {
            OR: [
              {
                AND: [
                  { slotStartTimeInUTC: { lte: slotStart } },
                  { slotEndTimeInUTC: { gt: slotStart } },
                ],
              },
              {
                AND: [
                  { slotStartTimeInUTC: { lt: slotEnd } },
                  { slotEndTimeInUTC: { gte: slotEnd } },
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
      throw new Error(
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
                { slotStartTimeInUTC: { lte: slotStart } },
                { slotEndTimeInUTC: { gt: slotStart } },
              ],
            },
            {
              AND: [
                { slotStartTimeInUTC: { lt: slotEnd } },
                { slotEndTimeInUTC: { gte: slotEnd } },
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
    throw new Error(
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
      directlyBooked: true,
    },
  });

  // Create appointment
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.CONSULTATION,
      consultationId: consultation.id,
      slotsOfAppointment: {
        create: {
          slotStartTimeInUTC: new Date(data.slotStartTimeInUTC!),
          slotEndTimeInUTC: new Date(data.slotEndTimeInUTC!),
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

  // Calculate subscription end date
  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + plan.durationInMonths);

  // Create subscription
  const subscription = await tx.subscription.create({
    data: {
      subscriptionPlanId: plan.id,
      requestStatus: skipPayment
        ? RequestStatus.APPROVED
        : RequestStatus.PENDING,
      requestedById: consulteeProfileId,
      requestNotes: data.notes,
      startDate,
      endDate,
    },
  });

  // Create appointment
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.SUBSCRIPTION,
      subscriptionId: subscription.id,
      slotsOfAppointment: {
        create: {
          slotStartTimeInUTC: new Date(data.slotStartTimeInUTC!),
          slotEndTimeInUTC: new Date(data.slotEndTimeInUTC!),
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
      slotStartTimeInUTC:
        webinar.appointment?.slotsOfAppointment[0]?.slotStartTimeInUTC ||
        new Date(),
      slotEndTimeInUTC:
        webinar.appointment?.slotsOfAppointment[0]?.slotEndTimeInUTC ||
        new Date(),
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
          slotStartTimeInUTC: classInstance.startDate || new Date(),
          slotEndTimeInUTC: classInstance.endDate || new Date(),
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
  appointmentType: string,
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

// Production checkout flow with proper cleanup
export async function handleProductionCheckout(
  validatedData: CheckoutInput,
  userId: string,
) {
  // Step 1: Calculate amount and validate data (without creating appointment)
  const { amount, currency, discountCodeId } = await calculateAmountAndValidate(
    validatedData,
    userId,
  );

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
    });
  } catch (paymentError) {
    console.error("Payment intent creation failed:", paymentError);
    throw new Error("Failed to create payment intent. Please try again later.");
  }

  // Step 3: Create ONLY payment record (no appointment yet)
  try {
    await prisma.payment.create({
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

    console.log(
      `💳 Payment intent created: ${paymentResponse.id} - Waiting for payment completion`,
    );

    return {
      success: true,
      paymentIntent: paymentResponse,
      message: "Payment intent created. Complete payment to book appointment.",
      amount,
      currency,
    };
  } catch (dbError) {
    console.error("Failed to create payment record:", dbError);

    // CRITICAL: Cancel the payment intent since DB operation failed
    await PaymentIntentManager.cleanup(
      paymentResponse.id,
      "Database operation failed - preventing orphaned payment intent",
    );

    throw new Error("Failed to record payment information. Please try again.");
  }
}

// Development checkout flow
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
          true, // skipPayment = true for dev
        ));
        break;

      case "SUBSCRIPTION":
        ({ appointment, plan, amount } = await handleSubscriptionCheckout(
          tx,
          validatedData,
          user.consulteeProfile.id,
          true, // skipPayment = true for dev
        ));
        break;

      case "WEBINAR":
        ({ appointment, plan, amount } = await handleWebinarCheckout(
          tx,
          validatedData,
          userId,
          true, // skipPayment = true for dev
        ));
        break;

      case "CLASS":
        ({ appointment, plan, amount } = await handleClassCheckout(
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

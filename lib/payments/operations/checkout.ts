/**
 * Checkout Operations
 * Handles the complete checkout flow for all appointment types
 */

import prisma from "@/lib/prisma";
import { CheckoutInput, checkoutSchema } from "@/schemas/checkout";
import { calculateSubscriptionEndDate } from "@/utils/dateUtils";
import {
  AppointmentsType,
  PaymentGateway,
  PaymentStatus,
  Prisma,
  RequestStatus,
} from "@prisma/client";
import { cancelPaymentIntent, createPaymentIntent } from "../index";
import {
  lockSlotBooking,
  unlockSlotBooking,
  lockEventCheckout,
  unlockEventCheckout,
  ApprovalLock,
} from "@/utils/appointmentlock";
import {
  countUniqueParticipants,
  isUserEnrolled,
} from "@/lib/payments/utils/participants";

// Re-export for backward compatibility
export const unifiedCheckoutSchema = checkoutSchema;
export type { CheckoutInput };

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Unified return type for subscription checkout
 * FIX Issue #2: Creates placeholder appointment for payment linkage
 * This ensures webhook uses NEW FLOW (confirm) not LEGACY FLOW (create duplicate)
 * Consultant allocates specific slots later via Requests tab
 */
type SubscriptionCheckoutResult = {
  plan: Prisma.SubscriptionPlanGetPayload<{
    include: {
      consultantProfile: {
        include: { user: true };
      };
    };
  }>;
  amount: number;
  subscription: Prisma.SubscriptionGetPayload<Record<string, never>>;
  appointment: Prisma.AppointmentGetPayload<Record<string, never>>;
  isSchedulingPeriodRequest: boolean;
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build payment metadata for both payment intents and webhook handlers
 * Ensures consistency between payment creation and mock payment flows
 */
function buildPaymentMetadata(
  data: CheckoutInput,
  userId: string,
): { appointmentId: string; appointmentType: string; [key: string]: string } {
  return {
    appointmentId: "pending",
    appointmentType: data.appointmentType,
    userId: userId,
    planId: data.planId,
    slotStartTimeInUTC: data.slotStartTimeInUTC || "",
    slotEndTimeInUTC: data.slotEndTimeInUTC || "",
    slotOfAvailabilityWeeklyId: data.slotOfAvailabilityWeeklyId || "",
    slotOfAvailabilityCustomId: data.slotOfAvailabilityCustomId || "",
    schedulingPeriodStartsAt: data.schedulingPeriodStartsAt || "",
    schedulingPeriodEndsAt: data.schedulingPeriodEndsAt || "",
    discountCode: data.discountCode || "",
    notes: data.notes || "",
    ...(data.eventId && { eventId: data.eventId }),
  };
}

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
      this.activeIntents.set(
        paymentResponse.id,
        params.metadata.userId || "unknown",
      );

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
          plan.consultantProfile.user.id, // FIX: Pass consultant user ID to filter by consultant
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
          plan.consultantProfile.user.id, // FIX: Pass consultant user ID to filter by consultant
        );
        amount = plan.price;
        break;

      case "WEBINAR": {
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
      }

      case "CLASS": {
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
      }

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

    // Extract currency from plan based on appointment type
    let currency = "INR"; // Default fallback

    switch (validatedData.appointmentType) {
      case "CONSULTATION":
      case "SUBSCRIPTION":
      case "WEBINAR":
      case "CLASS":
        currency = (plan as { priceCurrency?: string })?.priceCurrency || "INR";
        break;
      default:
        currency = validatedData.paymentGateway === "RAZORPAY" ? "INR" : "USD";
    }

    return {
      amount,
      currency,
      discountCodeId,
      consulteeProfileId: user.consulteeProfile.id,
    };
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
  consultantUserId?: string, // NEW: Filter by consultant to prevent blocking across different consultants
) {
  if (!data.slotStartTimeInUTC || !data.slotEndTimeInUTC) return;

  const slotStart = new Date(data.slotStartTimeInUTC);
  const slotEnd = new Date(data.slotEndTimeInUTC);

  // 1. Check for confirmed overlapping appointments FOR THIS CONSULTANT ONLY
  // FIX: Previously checked ALL consultants globally, now filters by specific consultant
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
        // FIX: Filter by consultant - only check slots belonging to this consultant
        ...(consultantUserId
          ? [
              {
                user: {
                  some: {
                    id: consultantUserId,
                  },
                },
              },
            ]
          : []),
      ],
    },
  });

  if (existingBooking) {
    throw new Error("Time slot is already booked");
  }

  // 2. Check for duplicate tentative bookings by the same user FOR THIS CONSULTANT
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
          // FIX: Filter by consultant - only check tentative slots for this consultant
          ...(consultantUserId
            ? [
                {
                  user: {
                    some: {
                      id: consultantUserId,
                    },
                  },
                },
              ]
            : []),
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

  // 3. Check for excessive tentative bookings (rate limiting) FOR THIS CONSULTANT
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
        // FIX: Filter by consultant - only count tentative slots for this consultant
        ...(consultantUserId
          ? [
              {
                user: {
                  some: {
                    id: consultantUserId,
                  },
                },
              },
            ]
          : []),
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

  // Allow max 3 pending attempts for the same slot for this consultant
  if (tentativeCount >= 3) {
    throw new Error(
      "This time slot is temporarily unavailable due to high demand. Please try again later.",
    );
  }
}

// ============================================================================
// Checkout Lock Management
// ============================================================================

/**
 * Get plan data needed for lock acquisition
 * Returns consultant profile info for slot-based locking
 */
async function getPlanDataForLock(
  data: CheckoutInput,
): Promise<{ consultantProfile?: { userId: string } }> {
  // For CONSULTATION and SUBSCRIPTION, we need consultant ID for slot locking
  if (data.appointmentType === "CONSULTATION") {
    const plan = await prisma.consultationPlan.findUnique({
      where: { id: data.planId },
      select: {
        consultantProfile: {
          select: { userId: true },
        },
      },
    });
    if (!plan) throw new Error("Consultation plan not found");
    return plan;
  }

  if (data.appointmentType === "SUBSCRIPTION") {
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: data.planId },
      select: {
        consultantProfile: {
          select: { userId: true },
        },
      },
    });
    if (!plan) throw new Error("Subscription plan not found");
    return plan;
  }

  // For WEBINAR/CLASS, we don't need consultant ID (event-based locking)
  return {};
}

/**
 * Acquire appropriate lock based on checkout type
 * Returns lock or null if no locking needed
 */
async function acquireCheckoutLock(
  data: CheckoutInput,
  planData: { consultantProfile?: { userId: string } },
): Promise<ApprovalLock | null> {
  const appointmentType = data.appointmentType;

  // Strategy A: Slot-based locking (CONSULTATION + direct SUBSCRIPTION)
  if (data.slotStartTimeInUTC && data.slotEndTimeInUTC) {
    // Get consultant user ID from plan
    let consultantUserId: string;

    if (
      appointmentType === "CONSULTATION" ||
      appointmentType === "SUBSCRIPTION"
    ) {
      consultantUserId = planData.consultantProfile!.userId;
    } else {
      // For WEBINAR/CLASS with slots (shouldn't happen but handle gracefully)
      throw new Error(
        "Invalid checkout configuration: slot-based checkout for event type",
      );
    }

    console.log(
      JSON.stringify({
        event: "checkout_lock_acquiring",
        type: "slot-based",
        appointmentType,
        consultantUserId,
        slot: data.slotStartTimeInUTC,
        timestamp: new Date().toISOString(),
      }),
    );

    return await lockSlotBooking(consultantUserId, data.slotStartTimeInUTC);
  }

  // Strategy B: Event-based locking (WEBINAR, CLASS, scheduling-period SUBSCRIPTION)
  if (appointmentType === "WEBINAR" || appointmentType === "CLASS") {
    if (!data.eventId) {
      throw new Error(`${appointmentType} checkout requires event ID`);
    }

    console.log(
      JSON.stringify({
        event: "checkout_lock_acquiring",
        type: "event-based",
        appointmentType,
        eventId: data.eventId,
        timestamp: new Date().toISOString(),
      }),
    );

    return await lockEventCheckout(appointmentType, data.eventId);
  }

  // Scheduling period SUBSCRIPTION (no slots during checkout)
  if (appointmentType === "SUBSCRIPTION" && data.schedulingPeriodStartsAt) {
    console.log(
      JSON.stringify({
        event: "checkout_lock_acquiring",
        type: "event-based",
        appointmentType: "SUBSCRIPTION",
        planId: data.planId,
        timestamp: new Date().toISOString(),
      }),
    );

    return await lockEventCheckout(appointmentType, data.planId);
  }

  // Should not reach here if validation is correct
  console.warn(
    JSON.stringify({
      event: "checkout_no_lock_needed",
      appointmentType,
      data,
      timestamp: new Date().toISOString(),
    }),
  );

  return null;
}

/**
 * Release checkout lock safely (for finally blocks)
 */
async function releaseCheckoutLock(
  lock: ApprovalLock | null,
  lockType: string,
): Promise<void> {
  if (!lock) return;

  if (lockType === "slot-based") {
    await unlockSlotBooking(lock);
  } else {
    await unlockEventCheckout(lock);
  }

  console.log(
    JSON.stringify({
      event: "checkout_lock_released",
      lockType,
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * BUG-E: Verify plan still exists inside lock
 * Prevents race condition where plan is deleted between initial validation and checkout
 */
async function verifyPlanExistsInsideLock(
  tx: Prisma.TransactionClient,
  appointmentType: string,
  planId: string,
): Promise<void> {
  let planExists = false;

  switch (appointmentType) {
    case "CONSULTATION":
      planExists = !!(await tx.consultationPlan.findUnique({
        where: { id: planId },
        select: { id: true },
      }));
      break;
    case "SUBSCRIPTION":
      planExists = !!(await tx.subscriptionPlan.findUnique({
        where: { id: planId },
        select: { id: true },
      }));
      break;
    case "WEBINAR":
      planExists = !!(await tx.webinarPlan.findUnique({
        where: { id: planId },
        select: { id: true },
      }));
      break;
    case "CLASS":
      planExists = !!(await tx.classPlan.findUnique({
        where: { id: planId },
        select: { id: true },
      }));
      break;
  }

  if (!planExists) {
    throw new Error(
      "This plan is no longer available. Please refresh and try again.",
    );
  }
}

/**
 * Re-validate availability inside the lock
 * Critical for preventing TOCTOU race conditions
 */
async function revalidateInsideLock(
  data: CheckoutInput,
  userId: string,
): Promise<void> {
  // Re-run the same validation as calculateAmountAndValidate
  // but this time we're inside the lock, so it's safe
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      include: { consulteeProfile: true },
    });

    if (!user?.consulteeProfile) {
      throw new Error("User profile not found");
    }

    // BUG-E: Re-validate plan still exists (could be deleted between initial validation and lock)
    await verifyPlanExistsInsideLock(tx, data.appointmentType, data.planId);

    // Re-validate slot availability based on appointment type
    switch (data.appointmentType) {
      case "CONSULTATION": {
        // Only validate if there are slots
        if (data.slotStartTimeInUTC && data.slotEndTimeInUTC) {
          // FIX: Fetch plan to get consultant user ID for filtering
          const consultationPlan = await tx.consultationPlan.findUnique({
            where: { id: data.planId },
            include: { consultantProfile: { include: { user: true } } },
          });
          if (!consultationPlan) throw new Error("Consultation plan not found");

          await validateSlotAvailability(
            tx,
            data,
            user.consulteeProfile.id,
            consultationPlan.consultantProfile.user.id,
          );
        }
        break;
      }
      case "SUBSCRIPTION": {
        // Only validate if there are slots
        if (data.slotStartTimeInUTC && data.slotEndTimeInUTC) {
          // FIX: Fetch plan to get consultant user ID for filtering
          const subscriptionPlan = await tx.subscriptionPlan.findUnique({
            where: { id: data.planId },
            include: { consultantProfile: { include: { user: true } } },
          });
          if (!subscriptionPlan) throw new Error("Subscription plan not found");

          await validateSlotAvailability(
            tx,
            data,
            user.consulteeProfile.id,
            subscriptionPlan.consultantProfile.user.id,
          );
        }
        break;
      }

      case "WEBINAR": {
        if (!data.eventId) throw new Error("Event ID is required for webinar");

        const webinar = await tx.webinar.findUnique({
          where: { id: data.eventId },
          include: {
            webinarPlan: true,
            appointment: {
              include: { slotsOfAppointment: true },
            },
          },
        });

        if (!webinar) throw new Error("Webinar not found");

        const currentParticipants =
          webinar.appointment?.slotsOfAppointment?.length || 0;

        if (currentParticipants >= webinar.webinarPlan.maxParticipants) {
          throw new Error("Webinar is full");
        }
        break;
      }

      case "CLASS": {
        if (!data.eventId) throw new Error("Event ID is required for class");

        const classInstance = await tx.class.findUnique({
          where: { id: data.eventId },
          include: {
            classPlan: true,
            appointments: {
              include: { slotsOfAppointment: true },
            },
          },
        });

        if (!classInstance) throw new Error("Class not found");

        const currentParticipants = classInstance.appointments.reduce(
          (total: number, apt: { slotsOfAppointment: unknown[] }) =>
            total + apt.slotsOfAppointment.length,
          0,
        );

        if (currentParticipants >= classInstance.classPlan.maxParticipants) {
          throw new Error("Class is full");
        }
        break;
      }

      default:
        throw new Error("Invalid appointment type");
    }
  });
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
  // FIX: Pass consultant user ID to filter by consultant
  await validateSlotAvailability(
    tx,
    data,
    consulteeProfileId,
    plan.consultantProfile.user.id,
  );

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
): Promise<SubscriptionCheckoutResult> {
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

  // Determine if this is a scheduling period request or direct slot booking
  const isSchedulingPeriodRequest =
    data.schedulingPeriodStartsAt && data.schedulingPeriodEndsAt;

  // Calculate subscription dates based on booking type
  const startDate = isSchedulingPeriodRequest
    ? new Date(data.schedulingPeriodStartsAt!)
    : new Date();
  const endDate = isSchedulingPeriodRequest
    ? new Date(data.schedulingPeriodEndsAt!)
    : calculateSubscriptionEndDate(startDate, plan.durationInMonths);

  // Check for existing pending/approved subscriptions with overlapping periods
  // This prevents same user from double-buying the same plan
  const existingSubscription = await tx.subscription.findFirst({
    where: {
      subscriptionPlanId: plan.id,
      requestedById: consulteeProfileId,
      requestStatus: {
        in: [
          RequestStatus.PENDING,
          RequestStatus.APPROVED,
          RequestStatus.APPROVED_PENDING_PAYMENT,
        ],
      },
      OR: [
        {
          AND: [
            { schedulingPeriodStartsAt: { lte: endDate } },
            { schedulingPeriodEndsAt: { gte: startDate } },
          ],
        },
      ],
    },
  });

  if (existingSubscription) {
    throw new Error(
      "You already have a pending or active subscription for this plan with overlapping dates.",
    );
  }

  // Create subscription - consultant will allocate slots via Requests tab
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

  // FIX Issue #2: Create placeholder appointment for payment linkage
  // This ensures webhook uses NEW FLOW (confirm) not LEGACY FLOW (create duplicate)
  // Makes this handler symmetrical with others - consultant allocates slots later
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.SUBSCRIPTION,
      subscriptionId: subscription.id,
      // No slots created - consultant allocates later via Requests tab
    },
  });

  return {
    appointment,
    subscription,
    plan,
    amount: plan.price,
    isSchedulingPeriodRequest: !!isSchedulingPeriodRequest,
  };
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
          slotsOfAppointment: {
            include: {
              user: { select: { id: true } },
            },
          },
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

  // FIX Issue #5: Validate webinar is scheduled before allowing booking
  // Prevents slot timing from defaulting to new Date()
  if (!webinar.appointment?.slotsOfAppointment?.[0]) {
    throw new Error(
      "This webinar has not been scheduled yet. Please wait for the consultant to set a date and time.",
    );
  }

  // Allow late joiners: SCHEDULED and IN_PROGRESS webinars can accept new registrations
  // TODO: (Optional) Add configurable buffer time before webinar ends if needed in future
  //       e.g., block registration 5 minutes before scheduled end time
  const blockedStatuses = ["COMPLETED", "CANCELLED"] as const;
  if (
    blockedStatuses.includes(webinar.status as (typeof blockedStatuses)[number])
  ) {
    const message =
      webinar.status === "COMPLETED"
        ? "This webinar has already ended."
        : "This webinar has been cancelled.";
    throw new Error(message);
  }

  // Check if user is already registered for this webinar
  const isAlreadyRegistered = webinar.appointment?.slotsOfAppointment?.some(
    (slot) => slot.user?.some((u) => u.id === userId),
  );
  if (isAlreadyRegistered) {
    throw new Error("You are already registered for this webinar");
  }

  // Create or reuse appointment
  let appointment = webinar.appointment;
  if (!appointment) {
    appointment = await tx.appointment.create({
      data: {
        appointmentType: AppointmentsType.WEBINAR,
        webinarId: webinar.id,
      },
      include: {
        slotsOfAppointment: {
          include: {
            user: { select: { id: true } },
          },
        },
      },
    });
  }

  // Add user to webinar (appointment is guaranteed to exist here)
  if (appointment) {
    await tx.slotOfAppointment.create({
      data: {
        appointmentId: appointment.id,
        startsAt:
          webinar.appointment?.slotsOfAppointment[0]?.startsAt || new Date(),
        endsAt:
          webinar.appointment?.slotsOfAppointment[0]?.endsAt || new Date(),
        isTentative: !skipPayment,
        user: {
          connect: { id: userId },
        },
      },
    });
  }

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
          slotsOfAppointment: {
            include: {
              user: true,
            },
          },
        },
      },
    },
  });

  if (!classInstance) {
    throw new Error("Class not found");
  }

  const plan = classInstance.classPlan;

  // OPT-2: Use extracted utility for participant counting
  const currentParticipants = countUniqueParticipants(
    classInstance.appointments,
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

  // Check if user is already enrolled - OPT-2: Use extracted utility
  if (isUserEnrolled(classInstance.appointments, userId)) {
    throw new Error("You are already enrolled in this class");
  }

  // Create SlotOfAppointment for the user for ALL class appointments (sessions)
  const createdSlots = [];
  for (const appointment of classInstance.appointments) {
    // Get timing from the first existing slot or use appointment times
    const existingSlot = appointment.slotsOfAppointment[0];

    const slot = await tx.slotOfAppointment.create({
      data: {
        appointmentId: appointment.id,
        startsAt:
          existingSlot?.startsAt ||
          appointment.slotsOfAppointment[0]?.startsAt ||
          new Date(),
        endsAt:
          existingSlot?.endsAt ||
          appointment.slotsOfAppointment[0]?.endsAt ||
          new Date(),
        isTentative: !skipPayment,
        user: {
          connect: { id: userId },
        },
      },
    });
    createdSlots.push(slot);
  }

  // Return the first appointment for compatibility
  const firstAppointment = classInstance.appointments[0];
  if (!firstAppointment) {
    throw new Error("No class sessions found");
  }

  return {
    appointment: firstAppointment,
    plan,
    amount: plan.price,
    slotsCreated: createdSlots.length,
  };
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
export async function handleCheckout(
  validatedData: CheckoutInput,
  userId: string,
  isMockPayment: boolean = false,
) {
  let lock: ApprovalLock | null = null;
  let lockType = "";
  // TYPE-1: Properly typed payment response instead of any
  let paymentResponse: { id: string; client_secret: string | null } | null =
    null;

  try {
    // STEP 1: Calculate amount and fetch plan data (OUTSIDE LOCK - just pricing)
    const { amount, currency, discountCodeId, consulteeProfileId } =
      await calculateAmountAndValidate(validatedData, userId);

    // Get plan data for consultant ID (needed for lock acquisition)
    const planData = await getPlanDataForLock(validatedData);

    // STEP 2: ACQUIRE DISTRIBUTED LOCK (prevents race conditions)
    lock = await acquireCheckoutLock(validatedData, planData);
    lockType = validatedData.slotStartTimeInUTC ? "slot-based" : "event-based";

    console.log(
      JSON.stringify({
        event: "checkout_lock_acquired",
        lockType,
        appointmentType: validatedData.appointmentType,
        timestamp: new Date().toISOString(),
      }),
    );

    // STEP 3: RE-VALIDATE INSIDE LOCK (critical for preventing TOCTOU race conditions)
    await revalidateInsideLock(validatedData, userId);

    console.log(
      JSON.stringify({
        event: "checkout_revalidation_passed",
        appointmentType: validatedData.appointmentType,
        timestamp: new Date().toISOString(),
      }),
    );

    // STEP 4: Create payment intent (INSIDE LOCK)
    try {
      paymentResponse = await PaymentIntentManager.createWithCleanup({
        amount,
        currency,
        metadata: buildPaymentMetadata(validatedData, userId),
        paymentGateway: validatedData.paymentGateway,
        isMockPayment,
      });
    } catch (paymentError) {
      console.error("Payment intent creation failed:", paymentError);
      throw new Error(
        "Failed to create payment intent. Please try again later.",
      );
    }

    // STEP 5: Create tentative appointment + payment record (INSIDE LOCK)
    // This prevents race conditions by making validation see tentative bookings
    try {
      const result = await prisma.$transaction(async (tx) => {
        let createdAppointment;

        // Create appointment based on type (with isTentative flag)
        switch (validatedData.appointmentType) {
          case "CONSULTATION": {
            const consultationResult = await handleConsultationCheckout(
              tx,
              validatedData,
              consulteeProfileId,
              isMockPayment, // skipPayment = isMockPayment
            );
            createdAppointment = consultationResult.appointment;
            break;
          }

          case "SUBSCRIPTION": {
            const subscriptionResult = await handleSubscriptionCheckout(
              tx,
              validatedData,
              consulteeProfileId,
              isMockPayment,
            );
            // Use placeholder appointment for payment linkage
            // This ensures webhook uses NEW FLOW (confirm) not LEGACY FLOW (create duplicate)
            createdAppointment = subscriptionResult.appointment;
            break;
          }

          case "WEBINAR": {
            const webinarResult = await handleWebinarCheckout(
              tx,
              validatedData,
              userId,
              isMockPayment,
            );
            createdAppointment = webinarResult.appointment;
            break;
          }

          case "CLASS": {
            const classResult = await handleClassCheckout(
              tx,
              validatedData,
              userId,
              isMockPayment,
            );
            // Class creates slots across multiple appointments
            // Use first appointment for payment linkage
            createdAppointment = classResult.appointment || null;
            break;
          }

          default:
            throw new Error(
              `Unsupported appointment type: ${validatedData.appointmentType}`,
            );
        }

        // Create payment record linked to appointment (if created)
        // paymentResponse is guaranteed to be set at this point (we'd have thrown in the try-catch above)
        const payment = await tx.payment.create({
          data: {
            amount,
            currency,
            paymentMethod: "CARD",
            paymentIntent: paymentResponse!.id,
            paymentGateway: validatedData.paymentGateway,
            paymentStatus: PaymentStatus.PENDING,
            isMockPayment,
            userId: userId,
            appointmentId: createdAppointment?.id || null,
            discountCodeId,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
          },
        });

        // FIX Issue #6: Update mock payment status directly (no webhook for mock payments)
        if (isMockPayment) {
          await tx.payment.update({
            where: { id: payment.id },
            data: { paymentStatus: PaymentStatus.SUCCEEDED },
          });
        }

        return { appointmentId: createdAppointment?.id };
      });

      const logMessage = isMockPayment
        ? `🎭 Mock payment + tentative appointment created: ${paymentResponse.id}`
        : `💳 Payment intent + tentative appointment created: ${paymentResponse.id} - Waiting for payment confirmation`;

      console.log(logMessage);
      console.log(
        JSON.stringify({
          event: "checkout_appointment_created",
          appointmentType: validatedData.appointmentType,
          appointmentId: result.appointmentId,
          isMockPayment,
          timestamp: new Date().toISOString(),
        }),
      );

      return {
        success: true,
        paymentIntent: paymentResponse,
        message: isMockPayment
          ? "Mock payment completed and appointment created successfully"
          : "Payment intent created. Complete payment to book appointment.",
        amount,
        currency,
        isMockPayment,
      };
    } catch (dbError) {
      console.error("Failed to create payment record:", dbError);

      // CRITICAL: Cancel payment intent since DB operation failed
      if (paymentResponse) {
        await PaymentIntentManager.cleanup(
          paymentResponse.id,
          "Database operation failed - preventing orphaned payment intent",
        );
      }

      // Preserve specific error messages (duplicate registration, full capacity, etc.)
      if (dbError instanceof Error) {
        const preservedMessages = [
          "already registered",
          "already enrolled",
          "full",
          "cancelled",
          "ended",
          "not been scheduled",
        ];
        if (preservedMessages.some((msg) => dbError.message.includes(msg))) {
          throw dbError;
        }
      }

      throw new Error(
        "Failed to record payment information. Please try again.",
      );
    }
  } catch (error) {
    // Enhanced error handling with lock-specific errors
    if (error instanceof Error) {
      if (
        error.message.includes("currently checking out") ||
        error.message.includes("currently being booked")
      ) {
        throw new Error(
          "Another user is currently booking this slot. Please wait a few seconds and try again.",
        );
      }
    }
    throw error;
  } finally {
    // ALWAYS RELEASE LOCK (even on error)
    if (lock) {
      await releaseCheckoutLock(lock, lockType);
    }
  }
}

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
  TrialSessionStatus,
} from "@prisma/client";
import { cancelPaymentIntent, createPaymentIntent } from "../index";
import {
  lockSlotBooking,
  unlockSlotBooking,
  lockEventCheckout,
  unlockEventCheckout,
  ApprovalLock,
} from "@/utils/appointmentlock";
import { validateSlotTiming } from "@/lib/payments/utils/slot-validation";
import { isMinuteWithinWeeklySlot } from "@/utils/slotAllocation/slotTimeUtils";
import {
  countUniqueParticipants,
  isUserEnrolled,
  countWebinarParticipants,
} from "@/lib/payments/utils/participants";
import { markWaitlistAsBooked } from "@/lib/waitlist/slot-handler";
import { getExchangeRates } from "@/lib/currency";
import {
  applyCreditsToPayment,
  getUserCredits,
  processQualifyingAction,
  processConsultantBookingReferral,
} from "@/lib/referrals/service";
import { TAX_CONSTANTS } from "@/lib/payments/payouts/constants";
import {
  createEarningsFromPayment,
  type AppointmentType,
} from "@/lib/payments/payouts";
import {
  determineTax,
  appointmentTypeToServiceType,
} from "@/lib/payments/tax/tax-engine";
import {
  validatePlanCurrency,
  validateDiscountCurrency,
} from "@/lib/payments/validation/currency-guards";

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
    ...(data.fromWaitlist && { fromWaitlist: data.fromWaitlist }),
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
  buyerCountry: string = "IN",
) {
  return await prisma.$transaction(async (tx) => {
    let amount = 0;
    let plan;
    let priceCurrency = "INR";

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
        priceCurrency = plan.priceCurrency;
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
        priceCurrency = plan.priceCurrency;
        break;

      case "WEBINAR": {
        if (!validatedData.eventId) {
          throw new Error("Event ID is required for webinar");
        }
        const webinar = await tx.webinar.findUnique({
          where: { id: validatedData.eventId },
          include: {
            webinarPlan: {
              include: {
                consultantProfile: true,
              },
            },
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

        plan = webinar.webinarPlan;
        const consultantUserId = plan.consultantProfile?.userId;
        const currentWebinarParticipants = countWebinarParticipants(
          webinar.appointment,
          [consultantUserId || ""],
        );

        if (currentWebinarParticipants >= plan.maxParticipants) {
          throw new Error("Webinar is full");
        }

        amount = plan.price;
        priceCurrency = plan.priceCurrency;
        break;
      }

      case "CLASS": {
        if (!validatedData.eventId) {
          throw new Error("Event ID is required for class");
        }
        const classInstance = await tx.class.findUnique({
          where: { id: validatedData.eventId },
          include: {
            classPlan: {
              include: { consultantProfile: true },
            },
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

        plan = classInstance.classPlan;
        const classConsultantUserId = plan.consultantProfile?.userId;
        // FIX: Count unique participants, not total slots
        // A user enrolled in a class with 8 sessions should count as 1 participant, not 8
        const currentClassParticipants = countUniqueParticipants(
          classInstance.appointments,
          classConsultantUserId ? [classConsultantUserId] : [],
        );

        if (currentClassParticipants >= plan.maxParticipants) {
          throw new Error("Class is full");
        }

        amount = plan.price;
        priceCurrency = plan.priceCurrency;
        break;
      }

      default:
        throw new Error("Invalid appointment type");
    }

    // Capture original plan price before any discounts/credits
    // This is used for consultant earnings — discounts are platform-funded, not consultant-funded
    const originalAmount = amount;

    // Apply discount if provided - with full backend re-validation
    let discountCodeId = null;
    if (validatedData.discountCode) {
      const discount = await tx.discountCode.findUnique({
        where: { code: validatedData.discountCode.toUpperCase().trim() },
      });

      if (discount) {
        // Re-validate all conditions (don't trust frontend validation)
        if (!discount.isActive) {
          throw new Error("Discount code is no longer active");
        }

        if (discount.expiresAt && new Date() > discount.expiresAt) {
          throw new Error("Discount code has expired");
        }

        if (
          discount.maxUses !== null &&
          discount.currentUses >= discount.maxUses
        ) {
          throw new Error("Discount code has reached maximum uses");
        }

        discountCodeId = discount.id;

        // Validate FIXED_AMOUNT discount currency matches plan currency (INR for MVP)
        if (
          !validateDiscountCurrency(
            {
              discountType: discount.discountType,
              currency: discount.currency,
            },
            priceCurrency,
          )
        ) {
          throw new Error(
            "Discount code currency does not match plan currency",
          );
        }

        // Calculate discounted amount with maxDiscount cap
        if (discount.discountType === "PERCENTAGE") {
          let discountAmount = amount * (discount.discountValue / 100);
          // Apply maxDiscount cap if set
          if (
            discount.maxDiscount !== null &&
            discountAmount > discount.maxDiscount
          ) {
            discountAmount = discount.maxDiscount;
          }
          amount = amount - discountAmount;
        } else if (discount.discountType === "FIXED_AMOUNT") {
          amount = Math.max(0, amount - discount.discountValue);
        }

        // NOTE: currentUses increment is done in the payment transaction
        // to ensure count only increases when payment is successfully created
      }
    }

    // Use priceCurrency extracted from plan (set in the switch above)
    const currency = priceCurrency;

    // Validate plan currency (MVP: all plans must be INR)
    validatePlanCurrency(currency);

    // Calculate GST on the discounted price (tax-exclusive: plan.price + 18% GST)
    // Zero-rate GST for international buyers (export of services is zero-rated under IGST Act §2(6))
    // BUG FIX: Previously used `currency !== "INR"` which never triggered since all plans default to INR.
    // Now uses buyer country detection for correct tax jurisdiction determination.
    const isInternational = buyerCountry !== "IN";
    const taxDetermination = determineTax({
      baseAmountPaise: amount,
      buyerCountry,
      serviceType: appointmentTypeToServiceType(validatedData.appointmentType),
    });
    const taxAmount = taxDetermination.taxAmount;
    amount = amount + taxAmount;

    // Apply referral credits AFTER tax (credits act as a payment method, not a trade discount)
    // Both credits and amount are now in paise — no conversion needed
    let creditsApplied = 0;
    if (validatedData.useReferralCredits && amount > 0) {
      const { totalAvailable } = await getUserCredits(userId, tx);
      if (totalAvailable > 0) {
        creditsApplied = Math.min(totalAvailable, amount);
        amount = amount - creditsApplied;
      }
    }

    return {
      amount,
      originalAmount,
      taxAmount,
      currency,
      discountCodeId,
      consulteeProfileId: user.consulteeProfile.id,
      creditsApplied,
      buyerCountry,
      isInternational,
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

  // 0. Validate slot is not in the past or too soon (minimum lead time check)
  const timingError = validateSlotTiming(slotStart);
  if (timingError) {
    throw new Error(timingError);
  }

  // 0b. Validate slot falls within the specified availability window
  if (data.slotOfAvailabilityWeeklyId) {
    const avail = await tx.slotOfAvailabilityWeekly.findUnique({
      where: { id: data.slotOfAvailabilityWeeklyId },
      include: { consultantProfile: { select: { userId: true } } },
    });
    if (!avail) {
      throw new Error("Availability slot not found");
    }
    // Verify the availability slot belongs to the correct consultant
    if (
      consultantUserId &&
      avail.consultantProfile.userId !== consultantUserId
    ) {
      throw new Error(
        "Availability slot does not belong to the specified consultant",
      );
    }
    // Overnight-aware check: use shared utility instead of same-day-only guard
    const candidateDay = slotStart.getUTCDay();
    const candidateMinutes =
      slotStart.getUTCHours() * 60 + slotStart.getUTCMinutes();
    const slotDurationMinutes = Math.round(
      (slotEnd.getTime() - slotStart.getTime()) / (60 * 1000),
    );

    // FIX #520 Bug 2: Diagnostic logging for intermittent slot validation failures
    const slotValidationResult = isMinuteWithinWeeklySlot(
      candidateDay,
      candidateMinutes,
      slotDurationMinutes,
      avail.startDay,
      avail.startTimeUtc,
      avail.endTimeUtc,
      avail.utcOffsetMinutes,
    );

    if (!slotValidationResult) {
      console.error(
        JSON.stringify({
          event: "slot_validation_failed",
          candidateDay,
          candidateMinutes,
          slotDurationMinutes,
          availStartDay: avail.startDay,
          availStartTimeUtc: avail.startTimeUtc,
          availEndTimeUtc: avail.endTimeUtc,
          utcOffsetMinutes: avail.utcOffsetMinutes,
          slotStartISO: data.slotStartTimeInUTC,
          slotEndISO: data.slotEndTimeInUTC,
          availId: data.slotOfAvailabilityWeeklyId,
          timestamp: new Date().toISOString(),
        }),
      );
      throw new Error(
        "Selected slot does not fall within the specified availability window",
      );
    }
  } else if (data.slotOfAvailabilityCustomId) {
    const avail = await tx.slotOfAvailabilityCustom.findUnique({
      where: { id: data.slotOfAvailabilityCustomId },
      include: { consultantProfile: { select: { userId: true } } },
    });
    if (!avail) {
      throw new Error("Custom availability slot not found");
    }
    // Verify the custom availability slot belongs to the correct consultant
    if (
      consultantUserId &&
      avail.consultantProfile.userId !== consultantUserId
    ) {
      throw new Error(
        "Availability slot does not belong to the specified consultant",
      );
    }
    if (slotStart < avail.startsAt || slotEnd > avail.endsAt) {
      throw new Error(
        "Selected slot does not fall within the specified availability window",
      );
    }
  }

  // 1. Check for confirmed overlapping appointments FOR THIS CONSULTANT ONLY
  // FIX Bug #05: Use canonical overlap predicate that catches all 4 overlap shapes
  // (partial start, partial end, full containment, and exact match)
  const existingBooking = await tx.slotOfAppointment.findFirst({
    where: {
      AND: [
        { startsAt: { lt: slotEnd } },
        { endsAt: { gt: slotStart } },
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
  // FIX Bug #05: Use canonical overlap predicate
  if (userId) {
    const recentAttempt = await tx.slotOfAppointment.findFirst({
      where: {
        AND: [
          { startsAt: { lt: slotEnd } },
          { endsAt: { gt: slotStart } },
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
  // FIX Bug #05: Use canonical overlap predicate
  const tentativeCount = await tx.slotOfAppointment.count({
    where: {
      AND: [
        { startsAt: { lt: slotEnd } },
        { endsAt: { gt: slotStart } },
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
 *
 * FIX Bug #04: Changed from userId to id (consultantProfileId) to match
 * the lock key used in request-for-approval flow. All slot locks must use
 * the same identity (consultantProfileId) to prevent parallel bypass.
 */
async function getPlanDataForLock(
  data: CheckoutInput,
): Promise<{ consultantProfile?: { id: string } }> {
  // For CONSULTATION and SUBSCRIPTION, we need consultant profile ID for slot locking
  if (data.appointmentType === "CONSULTATION") {
    const plan = await prisma.consultationPlan.findUnique({
      where: { id: data.planId },
      select: {
        consultantProfile: {
          select: { id: true },
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
          select: { id: true },
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
  planData: { consultantProfile?: { id: string } },
): Promise<ApprovalLock | null> {
  const appointmentType = data.appointmentType;

  // Strategy A: Slot-based locking (CONSULTATION + direct SUBSCRIPTION)
  // FIX Bug #04: Use consultantProfileId (not userId) to match request-for-approval lock key
  if (data.slotStartTimeInUTC && data.slotEndTimeInUTC) {
    let consultantProfileId: string;

    if (
      appointmentType === "CONSULTATION" ||
      appointmentType === "SUBSCRIPTION"
    ) {
      consultantProfileId = planData.consultantProfile!.id;
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
        consultantProfileId,
        slot: data.slotStartTimeInUTC,
        timestamp: new Date().toISOString(),
      }),
    );

    return await lockSlotBooking(consultantProfileId, data.slotStartTimeInUTC);
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
            webinarPlan: {
              include: {
                consultantProfile: true,
              },
            },
            appointment: {
              include: { slotsOfAppointment: true },
            },
          },
        });

        if (!webinar) throw new Error("Webinar not found");

        const plan = webinar.webinarPlan;
        const consultantUserId = plan.consultantProfile?.userId;
        const currentParticipants = countWebinarParticipants(
          webinar.appointment,
          [consultantUserId || ""],
        );

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
            classPlan: {
              include: { consultantProfile: true },
            },
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

        if (!classInstance) throw new Error("Class not found");

        // FIX: Count unique participants, not total slots
        const ownerUserId = classInstance.classPlan.consultantProfile?.userId;
        const currentParticipants = countUniqueParticipants(
          classInstance.appointments,
          ownerUserId ? [ownerUserId] : [],
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
  userId: string,
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

  // userId is the consultee's user ID (passed by caller — no extra DB lookup needed)
  const consultantUserId = plan.consultantProfile.user.id;
  const consulteeUserId = userId;

  // Validate slot availability
  // FIX: Pass consultant user ID to filter by consultant
  await validateSlotAvailability(
    tx,
    data,
    consulteeProfileId,
    consultantUserId,
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

  // Create appointment with 30-min slot chunks (consistent with SlotAllocationService).
  // Each SlotOfAppointment is exactly 30 minutes so conflict detection works correctly.
  // Both consultant and consultee are connected so the user-scoped conflict filter works.
  const SLOT_MS = 30 * 60 * 1000;
  const startTime = new Date(data.slotStartTimeInUTC!);
  const endTime = new Date(data.slotEndTimeInUTC!);
  const slotChunks: { startsAt: Date; endsAt: Date }[] = [];
  let cur = new Date(startTime);
  while (cur < endTime) {
    slotChunks.push({
      startsAt: new Date(cur),
      endsAt: new Date(cur.getTime() + SLOT_MS),
    });
    cur = new Date(cur.getTime() + SLOT_MS);
  }
  if (slotChunks.length === 0)
    throw new Error("Invalid slot: start must be before end");

  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.CONSULTATION,
      consultationId: consultation.id,
      slotsOfAppointment: {
        create: slotChunks.map((chunk) => ({
          startsAt: chunk.startsAt,
          endsAt: chunk.endsAt,
          isTentative: !skipPayment,
          // Connect BOTH consultant and consultee so the user-scoped conflict
          // filter in validateNoConflicts (user.some.id === consultantUserId)
          // can see this slot. dev branch only connected the consultee, which
          // left the slot invisible to auto/manual allocation conflict checks.
          user: {
            connect: [{ id: consultantUserId }, { id: consulteeUserId }],
          },
        })),
      },
    },
  });

  return { appointment, plan, amount: plan.price };
}

export async function handleSubscriptionCheckout(
  tx: Prisma.TransactionClient,
  data: CheckoutInput,
  consulteeProfileId: string,
  _skipPayment: boolean,
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
      requestStatus: RequestStatus.PENDING, // Always PENDING until consultant allocates slots
      requestedById: consulteeProfileId,
      requestNotes: data.notes,
      bookingSource: "DIRECT_CHECKOUT",
      schedulingPeriodStartsAt: startDate,
      schedulingPeriodEndsAt: endDate,
    },
  });

  // Link any completed trial to this subscription (trial conversion tracking)
  // Find a completed trial from the same consultee for this consultant
  const completedTrial = await tx.trialSession.findFirst({
    where: {
      consulteeProfileId,
      consultantProfileId: plan.consultantProfileId,
      status: TrialSessionStatus.COMPLETED, // Only link completed trials, not pending/scheduled
      convertedToSubscriptionId: null, // Not already linked to another subscription
    },
  });

  if (completedTrial) {
    // Mark the trial as converted and link to this subscription
    await tx.trialSession.update({
      where: { id: completedTrial.id },
      data: {
        status: TrialSessionStatus.CONVERTED,
        convertedToSubscriptionId: subscription.id,
      },
    });

    console.log(
      JSON.stringify({
        event: "trial_converted",
        trialId: completedTrial.id,
        subscriptionId: subscription.id,
        consulteeProfileId,
        consultantProfileId: plan.consultantProfileId,
        timestamp: new Date().toISOString(),
      }),
    );
  }

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
  _skipPayment: boolean,
) {
  const webinar = await tx.webinar.findUnique({
    where: { id: data.eventId },
    include: {
      webinarPlan: {
        include: {
          consultantProfile: true,
        },
      },
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
  const consultantUserId = plan.consultantProfile?.userId;
  const currentParticipants = countWebinarParticipants(webinar.appointment, [
    consultantUserId || "",
  ]);

  // Check if max participants reached
  // NOTE: Waitlist creation happens OUTSIDE the transaction in handleCheckout's catch block,
  // because creating it here (inside the transaction) would be rolled back on throw.
  if (currentParticipants >= plan.maxParticipants) {
    throw new Error("Webinar is full");
  }

  // FIX Issue #5: Validate webinar is scheduled before allowing booking
  // Prevents slot timing from defaulting to new Date()
  if (!webinar.appointment?.slotsOfAppointment?.[0]) {
    throw new Error(
      "This webinar has not been scheduled yet. Please wait for the consultant to set a date and time.",
    );
  }

  // Block booking for COMPLETED or CANCELLED webinars
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

  // BUG-A FIX: Block booking if the webinar's scheduled end time has already passed.
  // This catches stale SCHEDULED webinars where the consultant never updated the status.
  // Late joiners to IN_PROGRESS webinars are still allowed as long as the end time hasn't passed.
  const masterSlot = webinar.appointment.slotsOfAppointment[0];
  if (masterSlot.endsAt < new Date()) {
    throw new Error(
      "This webinar has already ended. It can no longer accept registrations.",
    );
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

  // Add user to webinar by linking them to ALL existing slots.
  // Webinar participants attend the entire session, so they must be
  // connected to every SlotOfAppointment (not given a new duplicate slot).
  if (appointment && appointment.slotsOfAppointment.length > 0) {
    for (const slot of appointment.slotsOfAppointment) {
      await tx.slotOfAppointment.update({
        where: { id: slot.id },
        data: {
          user: { connect: { id: userId } },
        },
      });
    }
  }

  return { appointment, plan, amount: plan.price };
}

export async function handleClassCheckout(
  tx: Prisma.TransactionClient,
  data: CheckoutInput,
  userId: string,
  _skipPayment: boolean,
) {
  const classInstance = await tx.class.findUnique({
    where: { id: data.eventId },
    include: {
      classPlan: {
        include: { consultantProfile: true },
      },
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
  const consultantUserId = plan.consultantProfile?.userId;

  // OPT-2: Use extracted utility for participant counting
  const currentParticipants = countUniqueParticipants(
    classInstance.appointments,
    consultantUserId ? [consultantUserId] : [],
  );

  // Check if max participants reached
  // NOTE: Waitlist creation happens OUTSIDE the transaction in handleCheckout's catch block,
  // because creating it here (inside the transaction) would be rolled back on throw.
  if (currentParticipants >= plan.maxParticipants) {
    throw new Error("Class is full");
  }

  // H5 FIX: Validate class hasn't already ended (all sessions past).
  // Similar to webinar validation — prevents booking a class whose last session is over.
  if (classInstance.appointments.length > 0) {
    const lastSession =
      classInstance.appointments[classInstance.appointments.length - 1];
    const lastMasterSlot = lastSession.slotsOfAppointment[0];
    if (lastMasterSlot && lastMasterSlot.endsAt < new Date()) {
      throw new Error(
        "This class has already ended. It can no longer accept enrollments.",
      );
    }
  }

  // Check if user is already enrolled - OPT-2: Use extracted utility
  if (isUserEnrolled(classInstance.appointments, userId)) {
    throw new Error("You are already enrolled in this class");
  }

  // Link user to ALL existing slots of ALL class appointments (sessions).
  // Class participants attend every session, so they must be connected to
  // every existing SlotOfAppointment (not given duplicate slots).
  let linkedSlotCount = 0;
  for (const appointment of classInstance.appointments) {
    for (const slot of appointment.slotsOfAppointment) {
      await tx.slotOfAppointment.update({
        where: { id: slot.id },
        data: {
          user: { connect: { id: userId } },
        },
      });
      linkedSlotCount++;
    }
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
    slotsLinked: linkedSlotCount,
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
  buyerCountry: string = "IN",
) {
  let lock: ApprovalLock | null = null;
  let lockType = "";
  // TYPE-1: Properly typed payment response instead of any
  let paymentResponse: { id: string; client_secret: string | null } | null =
    null;

  try {
    // STEP 1: Calculate amount and fetch plan data (OUTSIDE LOCK - just pricing)
    const {
      amount,
      originalAmount,
      taxAmount,
      currency,
      discountCodeId,
      consulteeProfileId,
      creditsApplied,
      buyerCountry: detectedBuyerCountry,
      isInternational,
    } = await calculateAmountAndValidate(validatedData, userId, buyerCountry);

    const displayCurrencyAtCheckout =
      validatedData.displayCurrency?.toUpperCase() || currency;

    // Snapshot the displayed exchange rate for auditability.
    let exchangeRateAtCheckout: number | null = null;
    if (displayCurrencyAtCheckout !== "INR") {
      try {
        const rates = await getExchangeRates();
        exchangeRateAtCheckout = rates[displayCurrencyAtCheckout] ?? null;
      } catch {
        // Non-critical — don't block checkout if rate fetch fails
      }
    }

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

    // FIX #520: Detect zero-amount payments (credits fully cover cost)
    // Both Stripe and Razorpay reject amount <= 0, so we skip the gateway
    // entirely and treat this like a "free" payment that succeeds immediately.
    const isZeroAmountPayment = amount === 0 && creditsApplied > 0;

    // STEP 4: Create payment intent (INSIDE LOCK)
    if (isZeroAmountPayment) {
      const freePaymentId = `free_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      paymentResponse = { id: freePaymentId, client_secret: null };
      console.log(
        JSON.stringify({
          event: "zero_amount_payment_detected",
          creditsApplied,
          originalAmount,
          userId,
          timestamp: new Date().toISOString(),
        }),
      );
    } else {
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
    }

    // STEP 5: Create tentative appointment + payment record (INSIDE LOCK)
    // This prevents race conditions by making validation see tentative bookings
    try {
      const result = await prisma.$transaction(
        async (tx) => {
          let createdAppointment;

          // FIX #520: Zero-amount payments (credits cover full cost) skip the
          // gateway, so slots should be confirmed immediately just like mock payments.
          const skipPayment = isMockPayment || isZeroAmountPayment;

          // Create appointment based on type (with isTentative flag)
          switch (validatedData.appointmentType) {
            case "CONSULTATION": {
              const consultationResult = await handleConsultationCheckout(
                tx,
                validatedData,
                consulteeProfileId,
                userId,
                skipPayment,
              );
              createdAppointment = consultationResult.appointment;
              break;
            }

            case "SUBSCRIPTION": {
              const subscriptionResult = await handleSubscriptionCheckout(
                tx,
                validatedData,
                consulteeProfileId,
                skipPayment,
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
                skipPayment,
              );
              createdAppointment = webinarResult.appointment;
              break;
            }

            case "CLASS": {
              const classResult = await handleClassCheckout(
                tx,
                validatedData,
                userId,
                skipPayment,
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
              originalAmount,
              taxAmount,
              currency,
              paymentMethod: isZeroAmountPayment ? "CREDITS" : "CARD",
              paymentIntent: paymentResponse!.id,
              paymentGateway: validatedData.paymentGateway,
              // FIX #520: Zero-amount and mock payments succeed immediately (no webhook)
              paymentStatus: skipPayment
                ? PaymentStatus.SUCCEEDED
                : PaymentStatus.PENDING,
              isMockPayment: isMockPayment || isZeroAmountPayment,
              userId: userId,
              appointmentId: createdAppointment?.id || null,
              discountCodeId,
              expiresAt: skipPayment
                ? null
                : new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
              buyerCountry: detectedBuyerCountry,
              isInternational,
              displayCurrencyAtCheckout,
              exchangeRateAtCheckout,
            },
          });

          // Increment discount code usage count atomically (only after payment is created)
          // This ensures count only increases when payment is successfully created
          if (discountCodeId) {
            await tx.discountCode.update({
              where: { id: discountCodeId },
              data: { currentUses: { increment: 1 } },
            });
          }

          // FIX A3: Re-read credits inside the main transaction to prevent stale reads.
          // creditsApplied was calculated in TX1 (calculateAmountAndValidate), but between
          // TX1 and TX2, concurrent checkouts may have consumed the credits.
          let actualCreditsApplied = 0;
          if (creditsApplied > 0) {
            const { totalAvailable } = await getUserCredits(userId, tx);
            // Both creditsApplied and totalAvailable are in paise — direct comparison
            const actualCredits = Math.min(totalAvailable, creditsApplied);

            if (actualCredits > 0) {
              await applyCreditsToPayment(
                userId,
                actualCredits,
                tx,
                payment.id,
              );
              console.log(
                `🎁 Applied ${actualCredits} paise referral credits for user ${userId}` +
                  (actualCredits !== creditsApplied
                    ? ` (requested ${creditsApplied} paise, available ${totalAvailable} paise)`
                    : ""),
              );
            }

            // FIX #2: If fewer credits were available than expected (due to concurrent
            // checkout consuming them between TX1 and TX2), abort the transaction.
            // The payment intent was created with a reduced amount based on TX1's
            // credit calculation, so proceeding would undercharge the user.
            if (actualCredits < creditsApplied) {
              throw new Error(
                `CREDIT_SHORTFALL: expected ${creditsApplied} paise credits but only ${actualCredits} available. ` +
                  `Payment ${payment.id} amount is stale. Aborting for retry.`,
              );
            }
            actualCreditsApplied = creditsApplied; // In paise
          }

          return {
            appointmentId: createdAppointment?.id,
            creditsApplied: actualCreditsApplied,
          };
        },
        {
          timeout: 25000,
          // H6 FIX: Use Serializable isolation for booking transactions to prevent
          // phantom reads on capacity-limited events (webinars, classes). The
          // distributed lock serializes per-event, but Serializable adds DB-level
          // safety for edge cases like lock expiry under high load.
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );

      const logMessage = isZeroAmountPayment
        ? `🎁 Zero-amount payment (credits covered full cost) + appointment created: ${paymentResponse.id}`
        : isMockPayment
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

      // Mock/zero-amount payment post-processing: referral qualifying action + waitlist
      // Real payments handle this via handlePaymentSuccess() in the webhook,
      // but mock and zero-amount payments bypass webhooks entirely.
      if (isMockPayment || isZeroAmountPayment) {
        // Trigger referral reward if this is the user's first paid booking
        try {
          await processQualifyingAction(userId, "first_paid_booking");
        } catch (referralError) {
          console.error(
            `⚠️ Failed to process referral qualifying action for user ${userId}:`,
            referralError,
          );
        }

        // Create consultant earnings (mock payments bypass webhooks, so earnings must be created here)
        try {
          const paymentWithAppointment = await prisma.payment.findUnique({
            where: { paymentIntent: paymentResponse!.id },
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
              paymentWithAppointment.appointment.class?.classPlan
                ?.consultantProfile;

            if (consultantProfile) {
              const appointmentTypeMap: Record<string, AppointmentType> = {
                CONSULTATION: "CONSULTATION",
                SUBSCRIPTION: "SUBSCRIPTION",
                WEBINAR: "WEBINAR",
                CLASS: "CLASS",
              };

              const earningsAppointmentType =
                appointmentTypeMap[validatedData.appointmentType] ||
                "CONSULTATION";

              const paymentForEarnings = {
                ...paymentWithAppointment,
                appointment: {
                  ...paymentWithAppointment.appointment,
                  consultantProfile: { id: consultantProfile.id },
                  webinar: paymentWithAppointment.appointment.webinar
                    ? {
                        webinarPlanId:
                          paymentWithAppointment.appointment.webinar
                            .webinarPlanId,
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
                `💰 Mock payment earnings created for consultant ${consultantProfile.id}`,
              );
            }
          }
        } catch (earningsError) {
          // Log but don't fail — sync-payment-earnings job will pick up the gap
          console.error(
            `⚠️ Failed to create earnings for mock payment:`,
            earningsError,
          );
        }

        // FIX #437: Consultant qualifying action (receiving first paid booking)
        try {
          await processConsultantBookingReferral(
            { paymentIntent: paymentResponse!.id },
            userId,
          );
        } catch (consultantRefError) {
          console.error(
            `⚠️ Failed to process consultant referral qualifying action:`,
            consultantRefError,
          );
        }

        // Update waitlist status if coming from waitlist flow
        if (validatedData.fromWaitlist) {
          try {
            await markWaitlistAsBooked(validatedData.fromWaitlist);
            console.log(
              JSON.stringify({
                event: "waitlist_booking_completed",
                waitlistId: validatedData.fromWaitlist,
                timestamp: new Date().toISOString(),
              }),
            );
          } catch (waitlistError) {
            // Log but don't fail the checkout - payment was successful
            console.error("Failed to update waitlist status:", waitlistError);
          }
        }
      }

      return {
        success: true,
        paymentIntent: paymentResponse,
        message: isZeroAmountPayment
          ? "Payment completed via referral credits. Appointment booked successfully."
          : isMockPayment
            ? "Mock payment completed and appointment created successfully"
            : "Payment intent created. Complete payment to book appointment.",
        amount,
        currency,
        isMockPayment: isMockPayment || isZeroAmountPayment,
        isZeroAmountPayment,
      };
    } catch (dbError) {
      console.error("Failed to create payment record:", dbError);

      // CRITICAL: Cancel payment intent since DB operation failed
      // (Skip cleanup for zero-amount payments — they have no real gateway intent)
      if (paymentResponse && !isZeroAmountPayment) {
        await PaymentIntentManager.cleanup(
          paymentResponse.id,
          "Database operation failed - preventing orphaned payment intent",
        );
      }

      // Waitlist creation for full webinar — must happen OUTSIDE the transaction
      // (transaction was rolled back above, so any tx.waitlist.create would be lost)
      // NOTE: The capacity check in revalidateInsideLock also throws "Webinar is full",
      // but that lands in the outer catch(error) block, not here. Both are handled.
      if (
        dbError instanceof Error &&
        dbError.message === "Webinar is full" &&
        validatedData.appointmentType === "WEBINAR" &&
        validatedData.eventId
      ) {
        try {
          await prisma.waitlist.create({
            data: { userId, webinarId: validatedData.eventId },
          });
          throw new Error("Webinar is full. Added to waitlist.");
        } catch (waitlistError) {
          console.error("[WAITLIST CREATE ERROR]", waitlistError);
          // Re-throw if it's our own "Added to waitlist" error
          if (
            waitlistError instanceof Error &&
            waitlistError.message.includes("Added to waitlist")
          ) {
            throw waitlistError;
          }
          // Waitlist creation failed (e.g., already on waitlist) — fall through
        }
      }

      // Waitlist creation for full class — same pattern as webinar above
      if (
        dbError instanceof Error &&
        dbError.message === "Class is full" &&
        validatedData.appointmentType === "CLASS" &&
        validatedData.eventId
      ) {
        try {
          await prisma.waitlist.create({
            data: { userId, classId: validatedData.eventId },
          });
          throw new Error("Class is full. Added to waitlist.");
        } catch (waitlistError) {
          console.error("[WAITLIST CREATE ERROR]", waitlistError);
          if (
            waitlistError instanceof Error &&
            waitlistError.message.includes("Added to waitlist")
          ) {
            throw waitlistError;
          }
        }
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
          "already have a pending or active subscription",
          "overlapping dates",
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

      // Waitlist creation for full webinar — handles capacity check from revalidateInsideLock
      // (which runs OUTSIDE the inner try/catch(dbError), so errors land here)
      if (
        error.message === "Webinar is full" &&
        validatedData.appointmentType === "WEBINAR" &&
        validatedData.eventId
      ) {
        try {
          await prisma.waitlist.create({
            data: { userId, webinarId: validatedData.eventId },
          });
          throw new Error("Webinar is full. Added to waitlist.");
        } catch (waitlistError) {
          if (
            waitlistError instanceof Error &&
            waitlistError.message.includes("Added to waitlist")
          ) {
            throw waitlistError;
          }
          // Waitlist creation failed (e.g., already on waitlist) — rethrow original
        }
      }

      // Waitlist creation for full class — same pattern as webinar above
      if (
        error.message === "Class is full" &&
        validatedData.appointmentType === "CLASS" &&
        validatedData.eventId
      ) {
        try {
          await prisma.waitlist.create({
            data: { userId, classId: validatedData.eventId },
          });
          throw new Error("Class is full. Added to waitlist.");
        } catch (waitlistError) {
          if (
            waitlistError instanceof Error &&
            waitlistError.message.includes("Added to waitlist")
          ) {
            throw waitlistError;
          }
        }
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

/**
 * Checkout Operations
 * Handles the complete checkout flow for all appointment types
 */

import { reportSentryError } from "@/lib/observability/report";
import prisma, { type Tx } from "@/lib/prisma";
import { CheckoutInput, checkoutSchema } from "@/schemas/checkout";
import { calculateSubscriptionEndDate } from "@/utils/dateUtils";
import {
  AppointmentsType,
  type Currency,
  PaymentGateway,
  PaymentStatus,
  Prisma,
  AppointmentStatus,
  TrialSessionStatus,
} from "@prisma/client";
import { cancelPaymentIntent, createPaymentIntent } from "../index";
import {
  lockSlotBooking,
  unlockSlotBooking,
  lockEventCheckout,
  unlockEventCheckout,
  lockConsulteeBooking,
  unlockConsulteeBooking,
  extendLock,
  CHECKOUT_LOCK_TTL_MS,
  ApprovalLock,
} from "@/utils/appointmentlock";
import { validateSlotTiming } from "@/lib/payments/utils/slot-validation";
import { ensureConsulteeProfile } from "@/lib/profiles/ensure-consultee-profile";
import { isMinuteWithinWeeklySlot } from "@/utils/slotAllocation/slotTimeUtils";
import { buildOccupiedAppointmentFilter } from "@/utils/slotAllocation/occupancyPolicy";
import { isUserEnrolled } from "@/lib/payments/utils/participants";
import { getClassCapacity, getWebinarCapacity } from "@/lib/events/capacity";
import { getExchangeRates } from "@/lib/currency";
import {
  applyCreditsToPayment,
  getUserCredits,
  processQualifyingAction,
  processConsultantBookingReferral,
} from "@/lib/referrals/service";
import { MIN_CREDIT_REDEMPTION_PAISE } from "@/lib/referrals/constants";
import {
  createEarningsFromPayment,
  type AppointmentType,
} from "@/lib/payments/payouts";
import { walletDebit } from "@/lib/api/organizations/wallet";
import {
  isWalletFrozen,
  WalletFrozenError,
} from "@/lib/payments/wallet-freeze";
import { recordSystemError } from "@/lib/enterprise/system-events";
import {
  recordBookingUtilization,
  ProgramAssignmentLimitError,
} from "@/lib/api/organizations/program-helpers";
import {
  determineTax,
  appointmentTypeToServiceType,
} from "@/lib/payments/tax/tax-engine";
import {
  validatePlanCurrency,
  validateDiscountCurrency,
} from "@/lib/payments/validation/currency-guards";
import { checkPaymentLegsSumToAmount } from "@/lib/payments/payment-legs";
import { recordOverageAtCheckout } from "@/lib/payments/billing/overage-settlement";
import {
  getInvoiceCreditLimitPaise,
  assertVerifiedDomainOrThrow,
} from "@/lib/enterprise/governance";
import { checkConsent } from "@/lib/compliance/dpdp";
import { PURPOSE_CODES } from "@/lib/compliance/purpose-codes";
import { ENABLE_DUNNING_SUSPEND } from "@/lib/feature-flags";
import {
  notifyOrgProgramExhausted,
  notifyOrgProgramCapNear,
} from "@/lib/novu/org-workflows";
import { sumPaise } from "@/lib/payments/utils/money";
import { resolveCancellationPolicySnapshot } from "@/lib/payments/operations/cancellation-policy";

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
  // #780 — extended-client reads return price/trialPriceInPaise as number;
  // GetPayload says bigint.
  plan: Omit<
    Prisma.SubscriptionPlanGetPayload<{
      include: {
        consultantProfile: {
          include: { user: true };
        };
      };
    }>,
    "price" | "trialPriceInPaise"
  > & { price: number; trialPriceInPaise: number };
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
 * Ensures consistency between payment creation and mock payment flows.
 *
 * When the booking is org-sponsored, `organizationId` and `fundingSource`
 * are stamped into the gateway's `notes` (C.1, #687). This lets the
 * webhook attribute the payment to the org without an extra DB lookup
 * and gives invoice-fraud reconcilers a server-side proof that the
 * booker's claimed org matches the gateway's record.
 */
function buildPaymentMetadata(
  data: CheckoutInput,
  userId: string,
  orgContext?: {
    organizationId: string | null;
    fundingSource: "PERSONAL" | "WALLET" | "INVOICE" | "LICENSE" | null;
  },
): { appointmentId: string; appointmentType: string; [key: string]: string } {
  return {
    appointmentId: "pending",
    appointmentType: data.appointmentType,
    userId: userId,
    planId: data.planId,
    startsAt: data.startsAt || "",
    endsAt: data.endsAt || "",
    slotOfAvailabilityWeeklyId: data.slotOfAvailabilityWeeklyId || "",
    slotOfAvailabilityCustomId: data.slotOfAvailabilityCustomId || "",
    schedulingPeriodStartsAt: data.schedulingPeriodStartsAt || "",
    schedulingPeriodEndsAt: data.schedulingPeriodEndsAt || "",
    discountCode: data.discountCode || "",
    notes: data.notes || "",
    ...(data.eventId && { eventId: data.eventId }),
    ...(orgContext?.organizationId && {
      organizationId: orgContext.organizationId,
    }),
    ...(orgContext?.fundingSource && {
      fundingSource: orgContext.fundingSource,
    }),
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
      reportSentryError(error, { subsystem: "payments" });
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
      reportSentryError(error, { subsystem: "payments", level: "warning" });
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
    let priceCurrency: Currency = "INR";

    // Lazy-create ConsulteeProfile if this is the user's first
    // consumer action. ORG_WORKSPACE / CONSULTANT users who also book
    // personal sessions (valid, if rare) would hit "User profile not
    // found" before this helper existed — now we seed the profile on
    // demand inside the checkout tx.
    await ensureConsulteeProfile(tx, userId);
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

        // #781 §B — soft-deleted expert is not bookable
        if (plan.consultantProfile?.deletedAt) {
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

        // #781 §B — soft-deleted expert is not bookable
        if (plan.consultantProfile?.deletedAt) {
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

        // #781 §B — soft-deleted expert is not bookable
        if (plan.consultantProfile?.deletedAt) {
          throw new Error("Webinar not found");
        }

        const consultantUserId = plan.consultantProfile?.userId;
        const webinarCapacity = getWebinarCapacity({
          webinar,
          plan: webinar.webinarPlan,
          excludeUserIds: consultantUserId ? [consultantUserId] : [],
        });

        if (webinarCapacity.isFull) {
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

        // #781 §B — soft-deleted expert is not bookable
        if (plan.consultantProfile?.deletedAt) {
          throw new Error("Class not found");
        }

        const classConsultantUserId = plan.consultantProfile?.userId;
        const classCapacity = getClassCapacity({
          classInstance,
          plan: classInstance.classPlan,
          excludeUserIds: classConsultantUserId ? [classConsultantUserId] : [],
        });

        if (classCapacity.isFull) {
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
          // Guard: discountValue must be 1–100 for PERCENTAGE (data integrity check)
          if (discount.discountValue < 1 || discount.discountValue > 100) {
            throw new Error(
              `Invalid discount code: percentage value must be between 1 and 100, got ${discount.discountValue}`,
            );
          }
          let discountAmount = Math.round(
            amount * (discount.discountValue / 100),
          );
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
    // #880 — credits redeem only when the order is ₹500+ so a credit never
    // exceeds the value of the booking it discounts.
    let creditsApplied = 0;
    if (
      validatedData.useReferralCredits &&
      amount >= MIN_CREDIT_REDEMPTION_PAISE
    ) {
      const { totalAvailable } = await getUserCredits(userId, tx);
      if (totalAvailable > 0) {
        creditsApplied = Math.min(totalAvailable, amount);
        amount = amount - creditsApplied;
      }
    }

    // Guard: reject amounts in the 1-99 paise range (> ₹0 but < ₹1).
    // Razorpay requires a minimum order value of ₹1 (100 paise). An amount of exactly 0
    // is allowed — it triggers the mock/zero-amount payment path (free tier, full-credit cover).
    const MINIMUM_CHECKOUT_AMOUNT_PAISE = 100;
    if (amount > 0 && amount < MINIMUM_CHECKOUT_AMOUNT_PAISE) {
      throw new Error(
        `Final checkout amount (${amount} paise) is below the ₹1 minimum after discounts and credits. ` +
          `Please adjust the discount or use a free-session mechanism for zero-price bookings.`,
      );
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
  tx: Tx,
  data: CheckoutInput,
  userId?: string,
  consultantUserId?: string, // NEW: Filter by consultant to prevent blocking across different consultants
) {
  if (!data.startsAt || !data.endsAt) return;

  const slotStart = new Date(data.startsAt);
  const slotEnd = new Date(data.endsAt);

  // 0. Validate slot is not in the past or too soon (minimum lead time check)
  const timingError = validateSlotTiming(slotStart);
  if (timingError) {
    throw new Error(timingError);
  }

  // 0b. Validate slot falls within the specified availability window
  if (data.slotOfAvailabilityWeeklyId) {
    const avail = await tx.slotOfAvailabilityWeekly.findUnique({
      where: { id: data.slotOfAvailabilityWeeklyId },
      include: {
        consultantProfile: { select: { userId: true, deletedAt: true } },
      },
    });
    if (!avail) {
      throw new Error("Availability slot not found");
    }
    // B13 — the plan-level soft-delete check can race a deletion landing
    // between plan fetch and slot validation; recheck at the slot level.
    if (avail.consultantProfile.deletedAt) {
      throw new Error("This expert is no longer accepting bookings");
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
          slotStartISO: data.startsAt,
          slotEndISO: data.endsAt,
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
  // FIX #540: Only check slots belonging to occupied (active) appointments.
  // Cancelled/rejected/expired appointment slots should NOT block new bookings.
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
        // FIX #540: Only count slots from active/occupied appointments
        {
          appointment: {
            OR: buildOccupiedAppointmentFilter(),
          },
        },
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
  if (data.startsAt && data.endsAt) {
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
        slot: data.startsAt,
        timestamp: new Date().toISOString(),
      }),
    );

    return await lockSlotBooking(
      consultantProfileId,
      data.startsAt,
      CHECKOUT_LOCK_TTL_MS[appointmentType], // #832 — per-type budget
    );
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

    return await lockEventCheckout(
      appointmentType,
      data.eventId,
      CHECKOUT_LOCK_TTL_MS[appointmentType], // #832 — per-type budget
    );
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

    return await lockEventCheckout(
      appointmentType,
      data.planId,
      CHECKOUT_LOCK_TTL_MS[appointmentType], // #832 — per-type budget
    );
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
  tx: Tx,
  appointmentType: string,
  planId: string,
): Promise<{
  consultantProfileId: string | null;
  organizationId: string | null;
}> {
  // ADR 18 — also surface the plan's consultant + org ownership so the
  // allowlist/exclusivity checks below reuse this lookup.
  const select = { consultantProfileId: true, organizationId: true } as const;
  let plan: {
    consultantProfileId: string | null;
    organizationId: string | null;
  } | null = null;

  switch (appointmentType) {
    case "CONSULTATION":
      plan = await tx.consultationPlan.findUnique({
        where: { id: planId },
        select,
      });
      break;
    case "SUBSCRIPTION":
      plan = await tx.subscriptionPlan.findUnique({
        where: { id: planId },
        select,
      });
      break;
    case "WEBINAR":
      plan = await tx.webinarPlan.findUnique({
        where: { id: planId },
        select,
      });
      break;
    case "CLASS":
      plan = await tx.classPlan.findUnique({
        where: { id: planId },
        select,
      });
      break;
  }

  if (!plan) {
    throw new Error(
      "This plan is no longer available. Please refresh and try again.",
    );
  }
  return plan;
}

/**
 * Re-validate availability inside the lock
 * Critical for preventing TOCTOU race conditions
 */
async function revalidateInsideLock(
  data: CheckoutInput,
  userId: string,
  // ADR 18 — Program funding this org-sponsored booking; null for
  // PERSONAL/marketplace checkouts. Drives the curated-panel check.
  programId: string | null = null,
): Promise<void> {
  // Re-run the same validation as calculateAmountAndValidate
  // but this time we're inside the lock, so it's safe
  await prisma.$transaction(async (tx) => {
    await ensureConsulteeProfile(tx, userId);
    const user = await tx.user.findUnique({
      where: { id: userId },
      include: {
        consulteeProfile: true,
        // For the self-booking guard below. A user may hold both profiles —
        // ConsultantProfile and ConsulteeProfile are independent 1:1s and
        // deliberately not mutually exclusive (ADR 18, and the roles doc says
        // so outright), which is exactly what makes the guard necessary.
        consultantProfile: { select: { id: true } },
      },
    });

    if (!user?.consulteeProfile) {
      throw new Error("User profile not found");
    }

    // BUG-E: Re-validate plan still exists (could be deleted between initial validation and lock)
    const plan = await verifyPlanExistsInsideLock(
      tx,
      data.appointmentType,
      data.planId,
    );

    // Nobody buys their own plan. Because one person can hold both profiles,
    // a LEARNER in a sponsoring org who also sells on the marketplace could
    // book their OWN plan against the org's credit pool and route the
    // sponsor's money into their own payout account. The same-org
    // EXPERT+LEARNER block doesn't reach this: it needs only a
    // ConsulteeProfile and a plan, and `ProgramConsultantAllowlist` — the one
    // thing that would have caught it — is empty by default under ADR 18's
    // open network.
    //
    // Blocked for personal checkouts too. There the loss is the platform fee
    // rather than someone else's money, so it is self-punishing rather than
    // dangerous, but there is no legitimate reason to buy your own session and
    // a rule with no exceptions needs no explanation at the call site.
    if (
      plan.consultantProfileId &&
      user.consultantProfile &&
      plan.consultantProfileId === user.consultantProfile.id
    ) {
      throw new Error("You cannot book your own plan.");
    }

    // ADR 18 — curated-panel enforcement (#971 shipped the stub). Rows on
    // the funding Program restrict org-sponsored bookings to listed
    // consultants; zero rows keep the sponsor network open. Checked under
    // the distributed lock to close the check-then-book race.
    if (programId) {
      const panel = await tx.programConsultantAllowlist.findMany({
        where: { programId },
        select: { consultantProfileId: true },
      });
      if (
        panel.length > 0 &&
        !panel.some(
          (row) => row.consultantProfileId === plan.consultantProfileId,
        )
      ) {
        throw new Error(
          "This consultant is not on your organization's approved panel for this program. Choose a listed consultant or ask your organization admin.",
        );
      }
    }

    // ADR 18 — exclusiveEngagement blocks the consultant's independent
    // plans (no org ownership) while an ACTIVE membership declares
    // exclusivity. Org-owned plans stay bookable. The "hide" half
    // (marketplace visibility filtering) remains future work per the ADR.
    if (plan.consultantProfileId && !plan.organizationId) {
      const exclusive = await tx.membership.findFirst({
        where: {
          consultantProfileId: plan.consultantProfileId,
          exclusiveEngagement: true,
          status: "ACTIVE",
        },
        select: { id: true },
      });
      if (exclusive) {
        throw new Error(
          "This consultant works exclusively through their organization; their independent plans cannot be booked.",
        );
      }
    }

    // Re-validate slot availability based on appointment type
    switch (data.appointmentType) {
      case "CONSULTATION": {
        // Only validate if there are slots
        if (data.startsAt && data.endsAt) {
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

          // Consultee-side conflict check.
          //
          // validateNoConflicts (SlotValidationService) is scoped to the
          // consultant's User ID — it ensures the consultant is not double-booked
          // but says nothing about the learner's own calendar. A learner who is
          // a member of two orgs (e.g., Org A with SEAT_PACK and Org B with
          // PREPAID_UNLIMITED) faces zero cost friction on either side, making
          // it easy to accidentally book overlapping sessions with two different
          // consultants. Both would pass the consultant-side check because they
          // involve different consultants, leaving the learner double-booked.
          //
          // The same scenario exists on the open marketplace — any consultee can
          // book overlapping sessions with two different consultants. Enterprise
          // multi-org membership increases the probability because the learner
          // has multiple "free" billing paths with no payment step to slow them.
          //
          // We run this query inside the distributed lock and inside the
          // Serializable transaction (TOCTOU-safe). We reuse
          // buildOccupiedAppointmentFilter so the occupancy definition matches
          // validateNoConflicts exactly — TENTATIVE and CONFIRMED both block.
          const consulteeConflict = await tx.appointment.findFirst({
            where: {
              AND: [
                { OR: buildOccupiedAppointmentFilter() },
                {
                  slotsOfAppointment: {
                    some: {
                      AND: [
                        { startsAt: { lt: new Date(data.endsAt!) } },
                        { endsAt: { gt: new Date(data.startsAt!) } },
                        // userId (User.id) is the right scope — slots are
                        // connected to User records, not ConsulteeProfile records.
                        // This catches conflicts regardless of which org the
                        // conflicting booking came from or whether it was a
                        // marketplace booking with no org context at all.
                        { user: { some: { id: userId } } },
                      ],
                    },
                  },
                },
              ],
            },
            select: { id: true },
          });
          if (consulteeConflict) {
            throw new Error(
              "You already have a session booked during this time.",
            );
          }
        }
        break;
      }
      case "SUBSCRIPTION": {
        // Only validate if there are slots
        if (data.startsAt && data.endsAt) {
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

          // Consultee-side conflict check for direct-slot subscriptions.
          // Same reasoning as the CONSULTATION case above — a subscription
          // booked with an explicit slot window must not overlap an existing
          // consultee appointment, regardless of which org or marketplace
          // context that prior appointment came from.
          const subscriptionConsulteeConflict = await tx.appointment.findFirst({
            where: {
              AND: [
                { OR: buildOccupiedAppointmentFilter() },
                {
                  slotsOfAppointment: {
                    some: {
                      AND: [
                        { startsAt: { lt: new Date(data.endsAt!) } },
                        { endsAt: { gt: new Date(data.startsAt!) } },
                        { user: { some: { id: userId } } },
                      ],
                    },
                  },
                },
              ],
            },
            select: { id: true },
          });
          if (subscriptionConsulteeConflict) {
            throw new Error(
              "You already have a session booked during this time.",
            );
          }
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
              // `user` is load-bearing: without it the participant count is
              // silently 0 and this whole recheck is dead.
              include: {
                slotsOfAppointment: {
                  include: { user: { select: { id: true } } },
                },
              },
            },
          },
        });

        if (!webinar) throw new Error("Webinar not found");

        const plan = webinar.webinarPlan;
        const consultantUserId = plan.consultantProfile?.userId;
        const capacity = getWebinarCapacity({
          webinar,
          plan,
          excludeUserIds: consultantUserId ? [consultantUserId] : [],
        });

        if (capacity.isFull) {
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

        const ownerUserId = classInstance.classPlan.consultantProfile?.userId;
        const capacity = getClassCapacity({
          classInstance,
          plan: classInstance.classPlan,
          excludeUserIds: ownerUserId ? [ownerUserId] : [],
        });

        if (capacity.isFull) {
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
  tx: Tx,
  data: CheckoutInput,
  consulteeProfileId: string,
  userId: string,
  skipPayment: boolean,
  /**
   * Resolved org context for this checkout (already validated by caller).
   * Passed through to `Appointment.organizationId` so the org dashboard's
   * `/api/organizations/[orgId]/appointments` query (which filters by
   * `Appointment.organizationId`) actually surfaces fresh org-funded
   * bookings. Without this stamp, only the `Payment` row carried the org
   * tag — leaving the appointment invisible to org admins until backfill.
   *
   * Issue: #674 (personal vs org scope split). The runtime-stamping gap
   * was flagged in the May 2026 production-readiness audit.
   */
  organizationId: string | null,
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
      status: skipPayment
        ? AppointmentStatus.APPROVED
        : AppointmentStatus.PENDING,
      requestedById: consulteeProfileId,
      requestNotes: data.notes,
      bookingSource: "DIRECT_CHECKOUT",
    },
  });

  // Create appointment with 30-min slot chunks (consistent with SlotAllocationService).
  // Each SlotOfAppointment is exactly 30 minutes so conflict detection works correctly.
  // Both consultant and consultee are connected so the user-scoped conflict filter works.
  const SLOT_MS = 30 * 60 * 1000;
  const startTime = new Date(data.startsAt!);
  const endTime = new Date(data.endsAt!);
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
      organizationId,
      // B1 — freeze the refund terms at booking; the cancel flow reads this.
      cancellationPolicySnapshot: JSON.parse(
        JSON.stringify(resolveCancellationPolicySnapshot()),
      ),
      slotsOfAppointment: {
        create: slotChunks.map((chunk) => ({
          startsAt: chunk.startsAt,
          endsAt: chunk.endsAt,
          isTentative: !skipPayment,
          // #440 — denormalized for the DB-level overlap guard.
          consultantProfileId: plan.consultantProfileId,
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
  tx: Tx,
  data: CheckoutInput,
  consulteeProfileId: string,
  _skipPayment: boolean,
  /** Resolved org context — see handleConsultationCheckout for rationale. */
  organizationId: string | null,
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
      status: {
        in: [
          AppointmentStatus.PENDING,
          AppointmentStatus.APPROVED,
          AppointmentStatus.APPROVED_PENDING_PAYMENT,
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
      status: AppointmentStatus.PENDING, // Always PENDING until consultant allocates slots
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
      organizationId,
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
  tx: Tx,
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
  const capacity = getWebinarCapacity({
    webinar,
    plan,
    excludeUserIds: consultantUserId ? [consultantUserId] : [],
  });

  if (capacity.isFull) {
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
    // Webinar appointments are SHARED across registrants — multiple
    // attendees from different orgs can join the same webinar. So we
    // tag with the WebinarPlan owner's org (the event host's org), not
    // the first registrant's booking org. This makes "events we host"
    // discoverable in the org dashboard, and avoids first-registrant-
    // wins org leakage.
    appointment = await tx.appointment.create({
      data: {
        appointmentType: AppointmentsType.WEBINAR,
        webinarId: webinar.id,
        organizationId: plan.organizationId ?? null,
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
  tx: Tx,
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

  const capacity = getClassCapacity({
    classInstance,
    plan,
    excludeUserIds: consultantUserId ? [consultantUserId] : [],
  });

  if (capacity.isFull) {
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

  // B11 — a partially-scheduled class (consultant hasn't allocated every
  // session yet) must not accept paid enrollments: the loop below links the
  // buyer only to EXISTING sessions, silently shorting them the rest.
  const expectedSessions = classInstance.classPlan?.totalSessions;
  if (
    typeof expectedSessions === "number" &&
    expectedSessions > 0 &&
    classInstance.appointments.length < expectedSessions
  ) {
    throw new Error(
      `This class is not fully scheduled yet (${classInstance.appointments.length} of ${expectedSessions} sessions). Enrollment opens once all sessions are scheduled.`,
    );
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
    // For enterprise cap counting (issue #710): one engagement per
    // class day. The learner is enrolling in every existing class
    // appointment at this moment, so the count is fully known here.
    engagementsConsumed: classInstance.appointments.length,
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
  // #898 follow-up — tier-2 consultee lock (acquired alongside the checkout lock
  // below; see the ordering note at STEP 2).
  let consulteeLock: ApprovalLock | null = null;
  // TYPE-1: Properly typed payment response instead of any
  let paymentResponse: { id: string; client_secret: string | null } | null =
    null;

  // Enterprise (Arch 4-Modified): resolve org + Program context up-front.
  //
  //   fundingSource=PERSONAL → org is tagged for reporting only; learner pays.
  //   fundingSource=WALLET   → debit BillingAccount.walletBalance atomically.
  //   fundingSource=INVOICE  → accrue to the org's monthly invoice.
  //   fundingSource=LICENSE  → absorbed by a LICENSED_SEAT program, amount=0.
  //
  // Every non-PERSONAL path also requires an ACTIVE `ProgramAssignment`
  // whose Program covers the current `appointmentType` — that's the source
  // of truth for "is this booking sponsored?". A missing assignment on a
  // WALLET/INVOICE/LICENSE org fails closed: we refuse rather than
  // silently bill the learner's card.
  const appointmentType = validatedData.appointmentType as
    | "CONSULTATION"
    | "SUBSCRIPTION"
    | "WEBINAR"
    | "CLASS";

  let organizationId: string | null = null;
  let billingAccountId: string | null = null;
  let fundingSource: "PERSONAL" | "WALLET" | "INVOICE" | "LICENSE" | null =
    null;
  let programAssignmentId: string | null = null;
  // ADR 18 — Program behind the assignment above; feeds the curated-panel
  // check in revalidateInsideLock.
  let fundingProgramId: string | null = null;
  let callerMembershipId: string | null = null;
  // #785 B6 — effective INVOICE credit limit; threaded to the Serializable
  // booking tx for a race-safe re-check (the pre-lock check below is fast-fail only).
  let creditEffectiveLimit: number | null = null;

  if (validatedData.organizationId) {
    const org = await prisma.organization.findUnique({
      where: { id: validatedData.organizationId },
      select: {
        id: true,
        status: true,
        canSponsor: true,
        billingAccount: {
          select: {
            id: true,
            fundingSource: true,
            creditLimit: true,
            walletBalance: true,
          },
        },
      },
    });
    if (!org) {
      throw new Error("Organization not found.");
    }
    // PR-1d: PENDING_VERIFICATION orgs may transact for INVOICE bookings
    // under the credit-limit gate (#687 invoice-fraud guard). Anything
    // else still requires fully ACTIVE status.
    if (org.status !== "ACTIVE" && org.status !== "PENDING_VERIFICATION") {
      throw new Error(
        `Organization is ${org.status.toLowerCase()}; cannot process bookings.`,
      );
    }
    if (!org.canSponsor) {
      throw new Error(
        "This organization is not configured to sponsor bookings (canSponsor=false).",
      );
    }

    // #812 — dunning-suspend gate (config-gated, default off). The dunning cron's
    // Stage 3 stamps OrganizationInvoice.dunningSuspendedAt once an invoice is
    // unpaid past the grace window; while any such invoice is still OVERDUE, new
    // sponsored bookings for the org are blocked until it is paid. Paying the
    // invoice clears its OVERDUE status, which lifts this gate naturally.
    if (ENABLE_DUNNING_SUSPEND) {
      const suspended = await prisma.organizationInvoice.findFirst({
        where: {
          organizationId: org.id,
          status: "OVERDUE",
          dunningSuspendedAt: { not: null },
        },
        select: { invoiceNumber: true },
        // #750 — cite the OLDEST overdue invoice in the block message, not an
        // arbitrary one.
        orderBy: { dueDate: "asc" },
      });
      if (suspended) {
        throw new Error(
          `This organization has an overdue invoice (${suspended.invoiceNumber}) and is suspended from new sponsored bookings until it is paid.`,
        );
      }
    }

    // SECURITY: Verify the caller is an active Membership of this org.
    const callerMembership = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId: org.id } },
      select: { role: true, status: true, id: true },
    });
    if (!callerMembership || callerMembership.status !== "ACTIVE") {
      throw new Error("You are not an active member of this organization.");
    }

    // #701 — DPDP consent gate. The member is having a session booked + paid on
    // their behalf by the org; require a live SESSION_BOOKING consent artifact
    // before processing it. Fail-closed (checkConsent is false with no artifact).
    if (
      !(await checkConsent({
        userId,
        purposeCode: PURPOSE_CODES.SESSION_BOOKING,
      }))
    ) {
      throw Object.assign(
        new Error(
          "Consent required before your organization can book sessions for you. Grant session-booking consent in your organization's privacy settings.",
        ),
        {
          httpStatus: 403,
          code: "CONSENT_REQUIRED",
          purposeCode: "SESSION_BOOKING",
        },
      );
    }

    organizationId = org.id;
    callerMembershipId = callerMembership.id;
    billingAccountId = org.billingAccount?.id ?? null;
    fundingSource = org.billingAccount?.fundingSource ?? "PERSONAL";

    // Block personal referral credits on org-funded bookings.
    if (validatedData.useReferralCredits && fundingSource !== "PERSONAL") {
      validatedData = { ...validatedData, useReferralCredits: false };
    }

    // INVOICE fundingSource: enforce creditLimit. PR-1d (#687):
    // unverified orgs (PENDING_VERIFICATION) get an automatic
    // governance credit-limit even when the BillingAccount.creditLimit
    // column is null — the default ₹50k starter blocks the
    // book-everything-then-ghost abuse pattern. The cap auto-lifts
    // once the org is verified OR pays its first invoice.
    if (fundingSource === "INVOICE") {
      // K-02 / #687 — an org may not accrue INVOICE debt without a verified
      // domain. The credit-limit gate below caps unverified-STATUS orgs; this
      // asserts the orthogonal domain-ownership proof (OrgDomainClaim), the
      // gate governance.ts documents for INVOICE funding but had no caller.
      await assertVerifiedDomainOrThrow(prisma, org.id, "INVOICE_FUNDING");

      const explicitLimit = org.billingAccount?.creditLimit ?? null;
      const isVerified = org.status === "ACTIVE";
      const governanceLimit = isVerified ? null : getInvoiceCreditLimitPaise();
      const effectiveLimit =
        explicitLimit === null
          ? governanceLimit
          : governanceLimit === null
            ? explicitLimit
            : Math.min(explicitLimit, governanceLimit);
      creditEffectiveLimit = effectiveLimit;

      if (effectiveLimit !== null) {
        const [accrualAgg, outstandingAgg] = await Promise.all([
          prisma.paymentLeg.aggregate({
            where: {
              source: { in: ["INVOICE_ACCRUAL", "OVERAGE_INVOICE_ACCRUAL"] },
              payment: {
                organizationId: org.id,
                paymentStatus: "SUCCEEDED",
                billableToOrgInvoiceId: null,
              },
            },
            _sum: { amountPaise: true },
          }),
          prisma.organizationInvoice.aggregate({
            where: {
              organizationId: org.id,
              status: { in: ["ISSUED", "OVERDUE"] },
            },
            _sum: { totalPaise: true },
          }),
        ]);
        const exposure =
          sumPaise(accrualAgg._sum.amountPaise) +
          sumPaise(outstandingAgg._sum.totalPaise);
        if (exposure >= effectiveLimit) {
          throw new Error(
            `Organization has reached its invoice credit limit (${effectiveLimit} paise). Outstanding invoices must be paid before new bookings.`,
          );
        }
      }
    }

    // Resolve a currently-active ProgramAssignment for this member that
    // covers the appointment type. The assignment's Program must be
    // ACTIVE and attached to an ACTIVE contract still within its
    // effectiveFrom..effectiveTo window. The Program's
    // `coveredPlanTypes` array filters which appointment types it
    // sponsors (empty array = covers everything).
    if (fundingSource !== "PERSONAL") {
      const now = new Date();
      const assignment = await prisma.programAssignment.findFirst({
        where: {
          membershipId: callerMembership.id,
          periodStart: { lte: now },
          periodEnd: { gte: now },
          program: {
            status: "ACTIVE",
            OR: [
              { coveredPlanTypes: { isEmpty: true } },
              { coveredPlanTypes: { has: appointmentType } },
            ],
            contract: {
              organizationId: org.id,
              status: "ACTIVE",
              effectiveFrom: { lte: now },
              OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
            },
          },
        },
        orderBy: { periodEnd: "desc" },
        select: { id: true, programId: true },
      });

      if (!assignment) {
        throw new Error(
          "No active program assignment covers this booking. Ask your organization admin to assign you to a Program that covers " +
            appointmentType +
            ".",
        );
      }
      programAssignmentId = assignment.id;

      // ADR 18 — the Program is resolved HERE, but the authoritative
      // curated-panel check runs inside revalidateInsideLock, where the
      // plan's consultant is loaded and the distributed lock closes the
      // TOCTOU window: allowlist rows exist for the resolved Program ⇒ the
      // booked plan's consultant must be listed. Absent rows keep the
      // network open — sponsors fund any marketplace consultant by design.
      fundingProgramId = assignment.programId;
    }
  }

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
    // #898 follow-up — also serialize on the consultee so the SAME person can't
    // book two DIFFERENT consultants at overlapping times via concurrent direct
    // checkout. The GiST overlap guard is consultant-keyed, so the consultee-slot
    // conflict in revalidateInsideLock below is otherwise a check-then-write
    // (TOCTOU) window. Global lock order (a total order ⇒ deadlock-free):
    // event/consultant → consultee → slot. So for a slot-based checkout
    // (consultation) the consultee lock is taken BEFORE the slot lock; for an
    // event-based checkout it is taken AFTER the event lock.
    const isSlotBasedCheckout = !!validatedData.startsAt;
    if (isSlotBasedCheckout) {
      consulteeLock = await lockConsulteeBooking(userId);
    }
    lock = await acquireCheckoutLock(validatedData, planData);
    lockType = validatedData.startsAt ? "slot-based" : "event-based";
    if (!isSlotBasedCheckout) {
      consulteeLock = await lockConsulteeBooking(userId);
    }

    console.log(
      JSON.stringify({
        event: "checkout_lock_acquired",
        lockType,
        appointmentType: validatedData.appointmentType,
        timestamp: new Date().toISOString(),
      }),
    );

    // STEP 3: RE-VALIDATE INSIDE LOCK (critical for preventing TOCTOU race conditions)
    await revalidateInsideLock(validatedData, userId, fundingProgramId);

    console.log(
      JSON.stringify({
        event: "checkout_revalidation_passed",
        appointmentType: validatedData.appointmentType,
        timestamp: new Date().toISOString(),
      }),
    );

    // Enterprise funding derived from BillingAccount.fundingSource +
    // ProgramAssignment (both resolved above). These booleans gate the
    // "skip the gateway entirely" path — org-funded bookings never go
    // through Stripe/Razorpay at checkout time.
    const isOrgWalletPayment =
      fundingSource === "WALLET" && !!programAssignmentId;
    const isOrgInvoicedPayment =
      fundingSource === "INVOICE" && !!programAssignmentId;
    const isOrgLicensedPayment =
      fundingSource === "LICENSE" && !!programAssignmentId;
    const isOrgSponsoredPayment =
      isOrgWalletPayment || isOrgInvoicedPayment || isOrgLicensedPayment;

    // FIX #520: Detect zero-amount payments (credits fully cover cost)
    // Both Stripe and Razorpay reject amount <= 0, so we skip the gateway
    // entirely and treat this like a "free" payment that succeeds immediately.
    const isZeroAmountPayment = amount === 0 && creditsApplied > 0;

    // STEP 4: Create payment intent (INSIDE LOCK)

    // #832 — one checked renewal at the long-latency boundary (gateway call
    // + tentative-booking tx still ahead). A false return means the lock
    // already expired and another buyer may hold it; proceeding is exactly
    // the double-booking hazard the lock exists to prevent. A timer-based
    // heartbeat is deliberately avoided: serverless freeze makes intervals
    // unreliable, and the message must contain "already in progress" so
    // classifyError maps it to LOCK_CONTENTION → 409.
    if (lock) {
      const renewed = await extendLock(
        lock,
        CHECKOUT_LOCK_TTL_MS[validatedData.appointmentType] ?? 60_000,
      );
      if (!renewed) {
        throw new Error(
          "Checkout took too long and its hold expired — another checkout for this slot may be already in progress. Please try again.",
        );
      }
    }

    // Enterprise org funding skips the gateway entirely.
    if (isOrgSponsoredPayment) {
      const prefix = isOrgWalletPayment
        ? "org_wallet"
        : isOrgLicensedPayment
          ? "org_license"
          : "org_invoice";
      const syntheticId = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      paymentResponse = { id: syntheticId, client_secret: null };
    } else if (isZeroAmountPayment) {
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
          metadata: buildPaymentMetadata(validatedData, userId, {
            organizationId,
            fundingSource,
          }),
          paymentGateway: validatedData.paymentGateway,
          isMockPayment,
        });
      } catch (paymentError) {
        console.error("Payment intent creation failed:", paymentError);
        reportSentryError(paymentError, { subsystem: "payments" });
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
          // #785 B6 — re-check the INVOICE credit limit INSIDE the Serializable
          // tx. The pre-lock check ran on the global client before this tx, so
          // two concurrent disjoint-slot bookings (which take different per-slot
          // locks) could both pass it. Reading the accrual set here — the same
          // rows this tx is about to add to — makes SSI abort one of a racing
          // pair; the retry then sees the sibling's committed accrual.
          if (
            isOrgInvoicedPayment &&
            creditEffectiveLimit !== null &&
            organizationId
          ) {
            const [accrualAgg, outstandingAgg] = await Promise.all([
              tx.paymentLeg.aggregate({
                where: {
                  source: {
                    in: ["INVOICE_ACCRUAL", "OVERAGE_INVOICE_ACCRUAL"],
                  },
                  payment: {
                    organizationId,
                    paymentStatus: "SUCCEEDED",
                    billableToOrgInvoiceId: null,
                  },
                },
                _sum: { amountPaise: true },
              }),
              tx.organizationInvoice.aggregate({
                where: {
                  organizationId,
                  status: { in: ["ISSUED", "OVERDUE"] },
                },
                _sum: { totalPaise: true },
              }),
            ]);
            const exposure =
              sumPaise(accrualAgg._sum.amountPaise) +
              sumPaise(outstandingAgg._sum.totalPaise);
            // Same gate as the pre-lock check (>= limit), re-run inside the tx so
            // a concurrent sibling's just-committed accrual is visible — SSI then
            // aborts the loser of a racing pair instead of both straddling the cap.
            if (exposure >= creditEffectiveLimit) {
              throw new Error(
                `Organization has reached its invoice credit limit (${creditEffectiveLimit} paise). Outstanding invoices must be paid before new bookings.`,
              );
            }
          }

          let createdAppointment;
          // Engagement count for enterprise cap (issue #710). One
          // engagement = one Appointment row = one calendar occurrence.
          //   - CONSULTATION/WEBINAR: 1 (single Appointment created here)
          //   - CLASS: N (count of appointments the learner enrolled in,
          //     all known at checkout because consultant pre-allocated)
          //   - SUBSCRIPTION: null → SKIP recordBookingUtilization at
          //     checkout. Slots are allocated lazily by the consultant;
          //     debits land in SlotAllocationService.createAppointments,
          //     1 per allocation batch.
          let engagementsForCap: number | null = null;

          // FIX #520: Zero-amount payments (credits cover full cost) skip the
          // gateway, so slots should be confirmed immediately just like mock payments.
          // Enterprise: org-sponsored payments also skip the gateway.
          const skipPayment =
            isMockPayment || isZeroAmountPayment || isOrgSponsoredPayment;

          // Create appointment based on type (with isTentative flag)
          switch (validatedData.appointmentType) {
            case "CONSULTATION": {
              const consultationResult = await handleConsultationCheckout(
                tx,
                validatedData,
                consulteeProfileId,
                userId,
                skipPayment,
                organizationId,
              );
              createdAppointment = consultationResult.appointment;
              engagementsForCap = 1;
              break;
            }

            case "SUBSCRIPTION": {
              const subscriptionResult = await handleSubscriptionCheckout(
                tx,
                validatedData,
                consulteeProfileId,
                skipPayment,
                organizationId,
              );
              // Use placeholder appointment for payment linkage
              // This ensures webhook uses NEW FLOW (confirm) not LEGACY FLOW (create duplicate)
              createdAppointment = subscriptionResult.appointment;
              // engagementsForCap stays null — debit happens at
              // SlotAllocationService.createAppointments time.
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
              engagementsForCap = 1;
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
              engagementsForCap = classResult.engagementsConsumed;
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
              paymentMethod: isOrgWalletPayment
                ? "WALLET"
                : isOrgInvoicedPayment
                  ? "INVOICE"
                  : isOrgLicensedPayment
                    ? "LICENSE"
                    : isZeroAmountPayment
                      ? "CREDITS"
                      : "CARD",
              paymentIntent: paymentResponse!.id,
              // #828 — unique; a concurrent duplicate attempt dies on P2002
              // and the route replays this payment's original response.
              clientIdempotencyKey: validatedData.clientIdempotencyKey ?? null,
              paymentGateway: validatedData.paymentGateway,
              // FIX #520: Zero-amount and mock payments succeed immediately (no webhook)
              paymentStatus: skipPayment
                ? PaymentStatus.SUCCEEDED
                : PaymentStatus.PENDING,
              isMockPayment:
                isMockPayment || isZeroAmountPayment || isOrgSponsoredPayment,
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
              // Enterprise (Arch 4): org tag for reporting / billing.
              organizationId,
              billingAccountId,
            },
          });

          // Enterprise: WALLET fundingSource — debit from BillingAccount
          // atomically via the wallet helper (raw-SQL conditional UPDATE).
          // Triggered only when we also have a resolved program assignment,
          // which guarantees the booking is actually sponsored.
          if (isOrgWalletPayment && billingAccountId) {
            // #837 — refuse to spend a wallet whose cache drifted from the
            // journal (frozen by the ledger-reconcile job): the balance can't
            // be trusted until ops reconciles. Chargeback recovery is NOT gated
            // (see wallet-freeze.ts).
            if (await isWalletFrozen(tx, billingAccountId)) {
              throw new WalletFrozenError(billingAccountId);
            }
            await walletDebit(tx, {
              billingAccountId,
              amountPaise: amount,
              reason: "BOOKING",
              paymentId: payment.id,
              membershipId: callerMembershipId ?? undefined,
            });
          }

          // Enterprise: write the Program utilization row + a PaymentLeg
          // that describes where the money (or commitment) actually came
          // from. This is the runtime source of truth for sponsorship
          // attribution — analytics / invoicing / cap enforcement all read
          // these rows rather than back-deriving from `paymentMethod`.
          if (
            programAssignmentId &&
            isOrgSponsoredPayment &&
            engagementsForCap !== null
          ) {
            let utilizationResult: Awaited<
              ReturnType<typeof recordBookingUtilization>
            > = {
              wasOverage: false,
              engagementsConsumedDelta: 0,
              engagementsUsedAfter: 0,
              cap: null,
              programType: "LICENSED_SEAT",
              consumedPaiseAfter: 0,
              creditBudgetPaise: null,
            };
            try {
              utilizationResult = await recordBookingUtilization(tx, {
                programAssignmentId,
                paymentId: payment.id,
                engagementsConsumed: engagementsForCap,
                priceAtBookingPaise: amount,
              });
            } catch (err) {
              if (err instanceof ProgramAssignmentLimitError) {
                // Fire-and-forget bell notification to the assignee + org
                // operators. Lookup uses the outer prisma client (not the
                // about-to-roll-back `tx`) so the query runs against
                // committed state. The TX still rolls back on throw —
                // the notification is the correct signal whether or not
                // the booking eventually succeeds.
                //
                // `Program.organizationId` lives on its parent Contract,
                // not on Program itself, so the select chain hops
                // Program → Contract → Organization.
                prisma.programAssignment
                  .findUnique({
                    where: { id: programAssignmentId },
                    select: {
                      membership: {
                        select: {
                          userId: true,
                          user: { select: { name: true, email: true } },
                        },
                      },
                      program: {
                        select: {
                          name: true,
                          contract: {
                            select: {
                              organizationId: true,
                              organization: { select: { name: true } },
                            },
                          },
                        },
                      },
                    },
                  })
                  .then((ctx) => {
                    if (!ctx) return;
                    const orgId = ctx.program.contract.organizationId;
                    return notifyOrgProgramExhausted(
                      orgId,
                      ctx.membership.userId,
                      {
                        orgName: ctx.program.contract.organization.name,
                        programName: ctx.program.name,
                        assigneeName:
                          ctx.membership.user.name ?? ctx.membership.user.email,
                        dashboardUrl: `/dashboard/organization/${orgId}/programs`,
                      },
                    );
                  })
                  .catch((notifyErr) => {
                    console.error(
                      "[notifyOrgProgramExhausted] failed:",
                      notifyErr,
                    );
                    reportSentryError(notifyErr, {
                      subsystem: "payments",
                      level: "warning",
                    });
                  });

                throw new Error(
                  "Your program has hit its session cap for this cycle. Ask your organization admin to upgrade the program or wait for the next cycle.",
                );
              }
              throw err;
            }

            await tx.paymentLeg.create({
              data: {
                paymentId: payment.id,
                source: isOrgWalletPayment
                  ? "WALLET"
                  : isOrgLicensedPayment
                    ? "LICENSE"
                    : "INVOICE_ACCRUAL",
                // LICENSE absorbs the cost entirely at the contract level
                // — the per-booking leg is zero so totals across all legs
                // still reconcile to the Payment amount.
                amountPaise: isOrgLicensedPayment ? 0 : amount,
                sourceRef: programAssignmentId,
              },
            });

            // #768 #22 — 80% cap-near early warning. Fire ONCE per cycle on
            // the <80% → >=80% transition (not on every booking past 80%).
            // Integer-only threshold cross: before/cap < 0.8 (before*5 <
            // cap*4) AND after/cap >= 0.8 (after*5 >= cap*4). Skipped when
            // cap is null (unlimited) or 0. Fire-and-forget on the outer
            // prisma client + same roster as the 100% event — mirrors the
            // notifyOrgProgramExhausted call below.
            {
              // #775 — LICENSED_SEAT meters in engagements, CREDIT_POOL in
              // paise (consumedPaise vs creditBudgetPaise). The 80% transition
              // math is unit-agnostic; the Novu payload reports credits for
              // pools (÷100) and engagements for seats.
              const isCredit = utilizationResult.programType === "CREDIT_POOL";
              const capAfter = isCredit
                ? utilizationResult.creditBudgetPaise
                : utilizationResult.cap;
              const after = isCredit
                ? utilizationResult.consumedPaiseAfter
                : utilizationResult.engagementsUsedAfter;
              const before = isCredit
                ? after - amount
                : after - utilizationResult.engagementsConsumedDelta;
              if (
                capAfter != null &&
                capAfter > 0 &&
                before * 5 < capAfter * 4 &&
                after * 5 >= capAfter * 4
              ) {
                const usedPct = Math.round((after / capAfter) * 100);
                const reportUsed = isCredit ? Math.round(after / 100) : after;
                const reportCap = isCredit
                  ? Math.round(capAfter / 100)
                  : capAfter;
                prisma.programAssignment
                  .findUnique({
                    where: { id: programAssignmentId },
                    select: {
                      membership: {
                        select: {
                          userId: true,
                          user: { select: { name: true, email: true } },
                        },
                      },
                      program: {
                        select: {
                          name: true,
                          contract: {
                            select: {
                              organizationId: true,
                              organization: { select: { name: true } },
                            },
                          },
                        },
                      },
                    },
                  })
                  .then((ctx) => {
                    if (!ctx) return;
                    const orgId = ctx.program.contract.organizationId;
                    return notifyOrgProgramCapNear(
                      orgId,
                      ctx.membership.userId,
                      {
                        orgName: ctx.program.contract.organization.name,
                        programName: ctx.program.name,
                        assigneeName:
                          ctx.membership.user.name ?? ctx.membership.user.email,
                        engagementsUsed: reportUsed,
                        cap: reportCap,
                        usedPct,
                        dashboardUrl: `/dashboard/organization/${orgId}/programs`,
                      },
                    );
                  })
                  .catch((notifyErr) => {
                    console.error(
                      "[notifyOrgProgramCapNear] failed:",
                      notifyErr,
                    );
                    reportSentryError(notifyErr, {
                      subsystem: "payments",
                      level: "warning",
                    });
                  });
              }
            }

            // C2: overage charging. recordBookingUtilization above flagged
            // `wasOverage = true` if the increment crossed the cap (only
            // possible when overageBehavior is CHARGE_MEMBER or CHARGE_ORG;
            // BLOCK throws inside the helper). Branch on the program's
            // configured behavior (#775):
            //   - CHARGE_ORG: write an OVERAGE_INVOICE_ACCRUAL PaymentLeg +
            //     OverageEvent(PENDING). The monthly invoice rollup picks it
            //     up (→ ACCRUED) and the invoice-paid handler marks it CHARGED.
            //   - CHARGE_MEMBER: the booking proceeds; the member owes the
            //     marginal. Create a parent-linked PENDING side-Payment +
            //     OverageEvent(PENDING). The member completes it via the
            //     resume-checkout surface (order created there, not in this TX)
            //     and the gateway webhook transitions it → CHARGED.
            //   - BLOCK behavior: never reaches here (helper already threw).
            //     The circuit-breaker veto is the only BLOCK decision here.
            if (utilizationResult.wasOverage) {
              // #778 elegance — extracted to recordOverageAtCheckout (resolves
              // the behaviour via computeOverage, enforces the circuit breaker,
              // persists the OverageEvent + CHARGE_MEMBER side-Payment /
              // CHARGE_ORG accrual leg). Throws PROGRAM_CAP_EXHAUSTED (402) on
              // the breaker veto.
              await recordOverageAtCheckout({
                tx,
                programAssignmentId,
                utilization: {
                  programType: utilizationResult.programType,
                  engagementsConsumedDelta:
                    utilizationResult.engagementsConsumedDelta,
                  engagementsUsedAfter: utilizationResult.engagementsUsedAfter,
                  consumedPaiseAfter: utilizationResult.consumedPaiseAfter,
                  creditBudgetPaise: utilizationResult.creditBudgetPaise,
                },
                bookingPricePaise: amount,
                currency,
                paymentId: payment.id,
                userId,
                organizationId,
                paymentGateway: validatedData.paymentGateway,
              });
            }
          }

          // Enterprise: every successful Payment must have at least one
          // PaymentLeg (`docs/enterprise/10-money-and-ledger/09-payment-legs.md`). For non-
          // org-sponsored learner-pays-via-gateway flows that's the CARD
          // leg, written here so the invariant holds whether or not the
          // payment ever transitions to SUCCEEDED. We record the gateway
          // payment-intent id in `sourceRef` so refund / reconciliation
          // jobs can join back to the gateway txn without scanning the
          // Payment table. `amount` is the post-credit gateway charge,
          // mirroring the field-level comment on `Payment.amount`. The
          // REFERRAL_CREDIT leg (if any) is written by
          // `applyCreditsToPayment` further down in this same TX.
          if (!isOrgSponsoredPayment && amount > 0) {
            await tx.paymentLeg.create({
              data: {
                paymentId: payment.id,
                source: "CARD",
                amountPaise: amount,
                sourceRef: paymentResponse!.id,
              },
            });
          }

          // Increment discount code usage count atomically (only after payment is created)
          // This ensures count only increases when payment is successfully created.
          // Re-validate maxUses inside the Serializable TX: two concurrent checkouts could
          // both pass the check in calculateAmountAndValidate (non-Serializable TX) and
          // both reach here. The Serializable re-read ensures only one succeeds.
          if (discountCodeId) {
            const discountForIncrement = await tx.discountCode.findUnique({
              where: { id: discountCodeId },
              select: { maxUses: true, currentUses: true },
            });

            if (!discountForIncrement) {
              throw new Error(
                "Discount code is no longer available. Please remove the code and try again.",
              );
            }

            if (
              discountForIncrement.maxUses !== null &&
              discountForIncrement.currentUses >= discountForIncrement.maxUses
            ) {
              throw new Error(
                "Discount code has reached maximum uses — please remove the code and try again.",
              );
            }
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

          // Invariant sweep: every Payment should have legs that sum to
          // `Payment.amount` (`docs/enterprise/10-money-and-ledger/09-payment-legs.md`). We
          // log-only here rather than throw because the hot checkout
          // path is the worst place to discover a leg-accounting drift
          // — a surprise 500 blocks real bookings. A mismatch signals
          // either (a) an org branch above wrote the wrong amount, or
          // (b) a future PaymentLegSource was added without updating
          // its write site. Reconciliation jobs + tests call the
          // hard-throwing `assertPaymentLegsSumToAmount` instead.
          if (!isMockPayment) {
            const writtenLegs = await tx.paymentLeg.findMany({
              where: { paymentId: payment.id },
              select: { source: true, amountPaise: true },
            });
            const legMismatch = checkPaymentLegsSumToAmount({
              paymentAmountPaise: payment.amount,
              legs: writtenLegs,
            });
            if (legMismatch) {
              console.warn(
                JSON.stringify({
                  event: "payment_leg_sum_mismatch",
                  paymentId: payment.id,
                  organizationId: validatedData.organizationId ?? null,
                  appointmentType: validatedData.appointmentType,
                  ...legMismatch,
                }),
              );
            }
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

      // Mock/zero-amount/org-sponsored payment post-processing: referral
      // qualifying action. Real payments handle this via
      // handlePaymentSuccess() in the webhook, but these flows bypass
      // webhooks entirely.
      if (isMockPayment || isZeroAmountPayment || isOrgSponsoredPayment) {
        // Trigger referral reward if this is the user's first paid booking
        try {
          await processQualifyingAction(userId, "first_paid_booking");
        } catch (referralError) {
          console.error(
            `⚠️ Failed to process referral qualifying action for user ${userId}:`,
            referralError,
          );
          reportSentryError(referralError, { subsystem: "payments", level: "warning" });
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
          // C-01 #837 — payment + booking are committed but earnings + the
          // BOOKING journal are not. Real money moved, so we don't roll back
          // and we don't pretend success with a silent warning: page (ERROR)
          // and durably record the ledger gap. The healer is the data-state
          // sync-payment-earnings scan (SUCCEEDED payment + earnings:none),
          // keyed on row state — not on this marker — so it's guaranteed and
          // idempotent even if this alert is lost.
          await recordSystemError({
            category: "PAYOUT",
            summary: `Earnings + booking journal not written for committed payment ${paymentResponse!.id} (checkout mock/zero/sponsored path)`,
            err: earningsError,
            correlationId: paymentResponse!.id,
            context: {
              paymentIntent: paymentResponse!.id,
              userId,
              appointmentType: validatedData.appointmentType,
              path: "checkout",
            },
          });
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
          reportSentryError(consultantRefError, {
            subsystem: "payments",
            level: "warning",
          });
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
      // Classification for Sentry tagging ONLY — deliberately NOT the same
      // list `preservedMessages` below uses for the rethrow decision, so
      // adding a tagging-only pattern here can never change which message
      // reaches the caller.
      const modelledOutcomePatterns = [
        "already registered",
        "already enrolled",
        "full",
        "cancelled",
        "ended",
        "not been scheduled",
        "already have a pending or active subscription",
        "overlapping dates",
        "insufficient credits",
        "session cap", // ProgramAssignmentLimitError-derived message, above
      ];
      // Typed errors and stable codes first — a substring is a last resort,
      // not the mechanism. recordOverageAtCheckout stamps
      // code: "PROGRAM_CAP_EXHAUSTED" on its 402, which this used to miss
      // entirely and report as a fault.
      const dbErrorCode = (dbError as { code?: unknown } | null)?.code;
      const isModelledOutcome =
        dbError instanceof WalletFrozenError ||
        dbError instanceof ProgramAssignmentLimitError ||
        dbErrorCode === "PROGRAM_CAP_EXHAUSTED" ||
        (dbError instanceof Error &&
          modelledOutcomePatterns.some((msg) =>
            // Word-bounded: bare `includes` let "full" match "successful" and
            // "ended" match "unintended", tagging real faults as routine.
            new RegExp(`\\b${msg}\\b`, "i").test(dbError.message),
          ));
      reportSentryError(dbError, { subsystem: "payments", expected: isModelledOutcome });

      // CRITICAL: Cancel payment intent since DB operation failed
      // (Skip cleanup for zero-amount payments — they have no real gateway intent)
      if (paymentResponse && !isZeroAmountPayment) {
        await PaymentIntentManager.cleanup(
          paymentResponse.id,
          "Database operation failed - preventing orphaned payment intent",
        );
      }

      // #837 — WalletFrozenError carries httpStatus=409 + an actionable reason;
      // don't let it collapse into the generic "Failed to record payment
      // information" below. Rethrow so the route surfaces the 409.
      if (dbError instanceof WalletFrozenError) {
        throw dbError;
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
          "insufficient credits",
        ];
        if (
          preservedMessages.some((msg) =>
            dbError.message.toLowerCase().includes(msg),
          )
        ) {
          throw dbError;
        }
      }

      throw new Error(
        "Failed to record payment information. Please try again.",
      );
    }
  } catch (error) {
    // Outermost boundary — also catches validation errors from
    // calculateAmountAndValidate/acquireCheckoutLock/revalidateInsideLock
    // (steps 1-3, above the STEP-5 try/catch that already reports) which
    // otherwise reach here uncaptured. Lock contention is a modelled,
    // expected race between two concurrent checkouts; anything else here is
    // unclassified and reported as a fault by default.
    const isLockContention =
      error instanceof Error &&
      (error.message.includes("currently checking out") ||
        error.message.includes("currently being booked"));
    reportSentryError(error, { subsystem: "payments", expected: isLockContention });
    // Enhanced error handling with lock-specific errors
    if (isLockContention) {
      throw new Error(
        "Another user is currently booking this slot. Please wait a few seconds and try again.",
      );
    }
    throw error;
  } finally {
    // ALWAYS RELEASE LOCKS (even on error). Release order doesn't affect
    // deadlock-freedom (only acquisition order does), so both are freed here.
    if (lock) {
      await releaseCheckoutLock(lock, lockType);
    }
    if (consulteeLock) {
      await unlockConsulteeBooking(consulteeLock);
    }
  }
}

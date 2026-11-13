// The one price derivation: plan gates, discount, GST, referral credits and
// the buyer country, read in its own transaction before any lock.

import { seatHoldingParticipant } from "@/utils/scheduling-engine/occupancyPolicy";
import prisma from "@/lib/prisma";
import type { CheckoutInput } from "@/schemas/checkout";
import {
  type BookingMode,
  type Currency,
  type OfferingPlanStatus,
  type OrgPlanVisibility,
  PaymentStatus,
} from "@prisma/client";
import { Refusal } from "@/lib/errors/refusal";
import { ensureConsulteeProfile } from "@/lib/profiles/ensure-consultee-profile";
import { getClassCapacity, getWebinarCapacity } from "@/lib/events/capacity";
import { resolveSchedulingTimezone } from "@/lib/scheduling/schedulingTimezone";
import { getUserCredits } from "@/lib/referrals/service";
import { resolveCheckoutAttribution } from "@/lib/referrals/attribution";
import {
  deriveCheckoutAmount,
  type CheckoutDiscountInput,
} from "@/lib/payments/pricing/derive-checkout-amount";
import { appointmentTypeToServiceType } from "@/lib/payments/tax/tax-engine";
import { currentGstRegime } from "@/lib/payments/tax/gst-regime";
import {
  validatePlanCurrency,
  validateDiscountCurrency,
} from "@/lib/payments/validation/currency-guards";
import { DiscountExhaustedError } from "@/lib/payments/pricing/discount-exhausted-error";
import {
  MARKETPLACE_VISIBILITY,
  planSaleRefusal,
} from "@/lib/api/plans/visibility";
import { classEnrolmentFrom } from "@/lib/booking/class-enrolment";
import {
  BookingRuleError,
  REQUEST_APPROVAL_REQUIRED_MESSAGE,
} from "@/lib/booking/booking-rule-error";
import { assertWindowMatchesPlanDuration } from "@/lib/booking/slot-validation";
import {
  holdsSettledSeat,
  alreadyHeldSeatError,
  findPriorSeatPayment,
  assertSeatRemintable,
  assertClassEnrolmentOpen,
} from "@/lib/payments/checkout/seats";
import { resolveSubscriptionCheckoutPeriod } from "@/lib/payments/checkout/renewal";
import { validateSlotAvailability } from "@/lib/payments/checkout/occupancy-validate";
import {
  openOrderTargetOf,
  ownOpenOrderHolds,
} from "@/lib/payments/checkout/order-reuse";

/**
 * Calculate final amount with discount and validate plan availability
 * Does NOT create any appointment records - only validates
 */
export async function calculateAmountAndValidate(
  validatedData: CheckoutInput,
  userId: string,
  buyerCountry: string = "IN",
  /**
   * #1465-triage — the org scope `handleCheckout` already resolved (membership
   * verified) before it calls this. Only reaches the slot-availability gate,
   * where it scopes the self-hold exclusion to holds this request could
   * actually resume. Null default keeps every non-org caller personal.
   */
  organizationId: string | null = null,
  /** The signed own-link cookie and whether an org funds this booking; null for neither. */
  referral: { viaToken: string | null; orgFunded: boolean } | null = null,
) {
  // Refuses before any read when PLATFORM_GSTIN is set but unusable.
  const gstRegime = currentGstRegime();
  return await prisma.$transaction(async (tx) => {
    let amount = 0;
    let plan;
    let priceCurrency: Currency = "INR";
    let classSessionsQuoted: number | null = null;
    let subscriptionSchedulingPeriod: { startsAt: Date; endsAt: Date } | null =
      null;

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
    // E2E-audit P1 fix — purchase-path storefront gates. Detail pages hide
    // unverified consultants' profiles and archived (withdrawn-from-sale)
    // plans, but this transaction looked rows up by bare id, so a stale or
    // hand-built URL could still pay an unverified seller or buy a pulled
    // plan. Mirror lib/data/consultant-detail.ts's VERIFIED rule and
    // eventPlanDiscoverableWhere's archivedAt/marketplace rules here, inside
    // the lock. Non-marketplace (ORG_ONLY) plans stay purchasable only via
    // the org-sponsored path — whose membership/assignment/contract gates
    // run below and inside revalidateInsideLock.
    const assertPlanPurchasable = (
      p: {
        archivedAt: Date | null;
        visibility: OrgPlanVisibility;
        organizationId: string | null;
        status?: OfferingPlanStatus | null;
        consultantProfile: {
          verificationStatus: string;
          acceptingRequests: boolean;
          bookingMode: BookingMode;
        } | null;
      },
      label: string,
    ) => {
      // A paused expert takes no new 1:1 booking; webinar and class seats keep
      // selling, and approved pay-links are minted elsewhere.
      const oneToOne =
        validatedData.appointmentType === "CONSULTATION" ||
        validatedData.appointmentType === "SUBSCRIPTION";
      if (oneToOne && p.consultantProfile?.acceptingRequests === false) {
        throw new BookingRuleError(
          "NOT_ACCEPTING_BOOKINGS",
          "This expert is not taking new 1:1 bookings right now. Pick another expert, or try again later.",
        );
      }
      // A review-first expert's 1:1 is requested, approved, then paid by its pay link, never bought here.
      if (
        validatedData.appointmentType === "CONSULTATION" &&
        p.consultantProfile?.bookingMode === "REQUEST"
      ) {
        throw new BookingRuleError(
          "REQUEST_APPROVAL_REQUIRED",
          REQUEST_APPROVAL_REQUIRED_MESSAGE,
        );
      }
      // #1527 Q4 — new sales only. Pay-links minted for approved requests
      // (approval-payment.ts) deliberately skip this, so unpublishing a plan
      // never strands a booking the consultant already accepted.
      if (planSaleRefusal(p)) {
        throw new BookingRuleError(
          "PLAN_NOT_PUBLISHED",
          `${label} isn't available to book right now.`,
        );
      }
      if (
        p.consultantProfile &&
        p.consultantProfile.verificationStatus !== "VERIFIED"
      ) {
        throw new BookingRuleError(
          "EXPERT_NOT_VERIFIED",
          `${label} isn't available to book until the expert is verified.`,
        );
      }
      if (p.archivedAt) {
        throw new Error(`${label} is no longer available`);
      }
      // A non-marketplace plan sells only to its own org's sponsored buyers; a
      // plan whose org was cleared (onDelete: SetNull) sells to no sponsor.
      const sameOrg =
        !!p.organizationId &&
        !!validatedData.organizationId &&
        p.organizationId === validatedData.organizationId;
      if (!MARKETPLACE_VISIBILITY.includes(p.visibility) && !sameOrg) {
        throw new Refusal({
          code: "PLAN_NOT_AVAILABLE_TO_ORG",
          httpStatus: 409,
          userMessage: `${label} is only available to members of the organisation that offers it.`,
          context: {
            visibility: p.visibility,
            planOrganizationId: p.organizationId,
            buyerOrganizationId: validatedData.organizationId ?? null,
          },
        });
      }
    };

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

        assertPlanPurchasable(plan, "This consultation");
        if (!validatedData.startsAt || !validatedData.endsAt) {
          throw new BookingRuleError(
            "WINDOW_DURATION_MISMATCH",
            "Choose a start and end time for this consultation.",
            400,
          );
        }
        assertWindowMatchesPlanDuration(
          plan,
          validatedData.startsAt,
          validatedData.endsAt,
        );

        // #1463 — the buyer's User id, not their ConsulteeProfile id: the
        // duplicate-hold step compares it to `Payment.userId`.
        await validateSlotAvailability(
          tx,
          validatedData,
          userId,
          plan.consultantProfile.user.id, // FIX: Pass consultant user ID to filter by consultant
          organizationId,
          plan.consultantProfile.id,
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

        assertPlanPurchasable(plan, "This subscription");

        // #1463 — the buyer's User id; see the consultation arm above.
        await validateSlotAvailability(
          tx,
          validatedData,
          userId,
          plan.consultantProfile.user.id, // FIX: Pass consultant user ID to filter by consultant
          organizationId,
          plan.consultantProfile.id,
        );
        subscriptionSchedulingPeriod = await resolveSubscriptionCheckoutPeriod(
          tx,
          {
            schedulingPeriodStartsAt: validatedData.schedulingPeriodStartsAt,
            renewsSubscriptionId: validatedData.renewsSubscriptionId,
            consulteeProfileId: user.consulteeProfile.id,
            plan,
            schedulingTimezone: resolveSchedulingTimezone(
              plan.consultantProfile?.user?.timezone,
            ),
          },
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
                occurrences: true,
                // A lapsed seat hold holds no place (the seat twin of a dead hold).
                participants: {
                  where: seatHoldingParticipant(new Date()),
                  select: { userId: true, status: true },
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

        assertPlanPurchasable(plan, "This webinar");

        const consultantUserId = plan.consultantProfile?.userId;
        const webinarCapacity = getWebinarCapacity({
          webinar,
          plan: webinar.webinarPlan,
          excludeUserIds: consultantUserId ? [consultantUserId] : [],
        });

        if (webinarCapacity.isFull) {
          // #1757 — a coded refusal (EVENT_FULL, 409), not a fault; the tx
          // catch rethrows registered codes unchanged.
          throw Object.assign(new Error("Webinar is full"), {
            httpStatus: 409,
            code: "EVENT_FULL",
          });
        }

        // A settled seat fails fast before any gateway order; a HELD one may still be resumed below.
        const priorWebinarSeat = webinar.appointment
          ? await findPriorSeatPayment(tx, userId, webinar.appointment.id)
          : null;
        if (priorWebinarSeat?.paymentStatus === PaymentStatus.SUCCEEDED) {
          assertSeatRemintable(priorWebinarSeat, "WEBINAR");
        }
        if (holdsSettledSeat(webinar.appointment, userId)) {
          throw alreadyHeldSeatError("WEBINAR");
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
            appointment: {
              include: {
                occurrences: true,
                // A lapsed seat hold holds no place (the seat twin of a dead hold).
                participants: {
                  where: seatHoldingParticipant(new Date()),
                  select: { userId: true, status: true },
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

        assertPlanPurchasable(plan, "This class");

        const classConsultantUserId = plan.consultantProfile?.userId;
        const classCapacity = getClassCapacity({
          classInstance,
          plan: classInstance.classPlan,
          excludeUserIds: classConsultantUserId ? [classConsultantUserId] : [],
        });

        if (classCapacity.isFull) {
          // #1757 — a coded refusal (EVENT_FULL, 409), not a fault; the tx
          // catch rethrows registered codes unchanged.
          throw Object.assign(new Error("Class is full"), {
            httpStatus: 409,
            code: "EVENT_FULL",
          });
        }

        // A settled seat fails fast before any gateway order; a HELD one may still be resumed below.
        const priorClassSeat = classInstance.appointment
          ? await findPriorSeatPayment(tx, userId, classInstance.appointment.id)
          : null;
        if (priorClassSeat?.paymentStatus === PaymentStatus.SUCCEEDED) {
          assertSeatRemintable(priorClassSeat, "CLASS");
        }
        if (holdsSettledSeat(classInstance.appointment, userId)) {
          throw alreadyHeldSeatError("CLASS");
        }

        // #1819 — a late joiner pays for the sessions left; the tx re-derives this.
        const enrolment = assertClassEnrolmentOpen(
          classEnrolmentFrom({
            pricePaise: plan.price,
            N: plan.totalSessions,
            lateJoinUntilSession: plan.lateJoinUntilSession,
            sessions: classInstance.appointment?.occurrences ?? [],
            now: new Date(),
          }),
        );
        amount = enrolment.basePaise;
        classSessionsQuoted = enrolment.remaining;
        priceCurrency = plan.priceCurrency;
        break;
      }

      default:
        throw new Error("Invalid appointment type");
    }

    // Priced as if the buyer's own open order for this item were released, so a reload or second tab
    // prices like the first; releaseSupersededHolds returns its holds before the commit consumes them.
    const target = openOrderTargetOf(
      validatedData,
      userId,
      organizationId,
      subscriptionSchedulingPeriod,
    );
    let ownHolds: ReturnType<typeof ownOpenOrderHolds> | null = null;
    const readOwnHolds = () =>
      target
        ? (ownHolds ??= ownOpenOrderHolds(tx, target))
        : Promise.resolve({ creditsPaise: 0, discountCodeIds: [] });

    // Apply discount if provided - with full backend re-validation
    let discountCodeId = null;
    let appliedDiscount: CheckoutDiscountInput | null = null;
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
          const ownUses = (await readOwnHolds()).discountCodeIds.filter(
            (id) => id === discount.id,
          ).length;
          if (discount.currentUses - ownUses >= discount.maxUses) {
            throw new DiscountExhaustedError(
              discount.currentUses,
              discount.maxUses,
            );
          }
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
          // #1586 J32 — its prose matched the "discount code" AVAILABILITY
          // pattern and told the buyer the plan was gone.
          throw Object.assign(
            new Error("Discount code currency does not match plan currency"),
            { httpStatus: 400, code: "DISCOUNT_CURRENCY_MISMATCH" },
          );
        }

        appliedDiscount = {
          discountType: discount.discountType,
          discountValue: discount.discountValue,
          maxDiscount: discount.maxDiscount,
        };

        // NOTE: currentUses increment is done in the payment transaction
        // to ensure count only increases when payment is successfully created
      } else {
        // #1592 A-P1-05 — an unknown code used to fall through to full price
        // with no word to the buyer. A coded 400 the classifier answers.
        throw Object.assign(
          new Error("That discount code is not valid for this purchase"),
          { httpStatus: 400, code: "DISCOUNT_CODE_INVALID" },
        );
      }
    }

    // Use priceCurrency extracted from plan (set in the switch above)
    const currency = priceCurrency;

    // Validate plan currency (MVP: all plans must be INR)
    validatePlanCurrency(currency);

    // #1319 — list price, then discount, then GST on the discounted base, then
    // referral credits against the tax-inclusive total. That sequence is now a
    // single pure function the parity suite imports instead of transcribing.
    // The credit balance is still read lazily, only once the order clears the
    // redemption floor, so orders that cannot spend a credit keep it out of the
    // transaction's read set.
    const attribution = await resolveCheckoutAttribution(tx, {
      buyerUserId: userId,
      consultantProfileId: plan.consultantProfile?.id ?? null,
      consultantUserId: plan.consultantProfile?.userId ?? null,
      viaToken: referral?.viaToken ?? null,
      orgFunded: referral?.orgFunded ?? false,
      hasDiscountCode: appliedDiscount !== null,
    });
    const derived = await deriveCheckoutAmount({
      basePaise: amount,
      buyerCountry,
      gstRegime,
      serviceType: appointmentTypeToServiceType(validatedData.appointmentType),
      discount: appliedDiscount,
      welcomeDiscount: attribution.welcomeDiscount,
      creditCapBps: attribution.creditCapBps,
      promoFeeBps: attribution.promoFeeBps,
      useReferralCredits: validatedData.useReferralCredits === true,
      resolveAvailableCreditsPaise: async () =>
        (await getUserCredits(userId, tx)).totalAvailable +
        (await readOwnHolds()).creditsPaise,
    });
    // A code on an order whose take cannot fund promo (a fee waiver, a host org) is refused,
    // before commit, so no redemption is spent.
    if (appliedDiscount && derived.platformFundedCapPaise === 0) {
      throw Object.assign(
        new Error(
          `Discount code refused: no platform-funded promo on this order (promoFeeBps=${attribution.promoFeeBps})`,
        ),
        { httpStatus: 409, code: "DISCOUNT_NOT_APPLICABLE" },
      );
    }
    // Original plan price before any discounts/credits, used for consultant
    // earnings — discounts are platform-funded, not consultant-funded.
    const { originalAmount, taxAmount, creditsApplied, isInternational } =
      derived;
    amount = derived.amount;

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
      // #1365 — the buyer's remembered GST state, resolved in the same lookup
      // that resolves the consultee so the invoice mint needs no extra read.
      consulteeBillingStateCode: user.consulteeProfile.billingStateCode,
      creditsApplied,
      buyerCountry,
      isInternational,
      classSessionsQuoted,
      subscriptionSchedulingPeriod,
      attributionSource: attribution.source,
      attributionReferralId: attribution.referralId,
      platformFeeBps: attribution.platformFeeBps,
      welcomeDiscountPaise: derived.welcomeDiscountPaise,
      gstRegime,
    };
  });
}

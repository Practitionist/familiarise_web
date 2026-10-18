/**
 * Checkout Operations
 * Handles the complete checkout flow for all appointment types
 */

import { scheduleAfter } from "@/lib/api/after-safe";
import { reportSentryError } from "@/lib/observability/report";
import {
  linkParticipantsToPayment,
  transitionParticipant,
} from "@/lib/booking/participants";
import { PaymentError } from "@/lib/payments/core/types";
import prisma from "@/lib/prisma";
import type { CheckoutInput } from "@/schemas/checkout";
import { PaymentGateway, PaymentStatus, Prisma } from "@prisma/client";
import {
  CHECKOUT_WAIT_RETRY_CONFIG,
  lockConsulteeBooking,
  unlockConsulteeBooking,
  extendLock,
  extendSlotInterval,
  CHECKOUT_LOCK_TTL_MS,
  ApprovalLock,
} from "@/utils/appointmentlock";
import { DIRECT_CHECKOUT_HOLD_MS } from "@/lib/payments/constants";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { isUniqueViolationOn } from "@/lib/db/unique-violation";
import { getExchangeRates } from "@/lib/currency";
import { applyCreditsToPayment, getUserCredits } from "@/lib/referrals/service";
import { notifyCreditsAppliedBestEffort } from "@/lib/referrals/referral-notify";
import { asWelcomeDiscountConflict } from "@/lib/referrals/attribution";
import { recordReferralCaptureInSavepoint } from "@/lib/referrals/capture";
import {
  createEarningsFromPayment,
  resolvePaymentForEarnings,
} from "@/lib/payments/payouts";
import { walletDebit } from "@/lib/api/organizations/wallet";
import {
  isWalletFrozen,
  WalletFrozenError,
} from "@/lib/payments/wallet-freeze";
import {
  recordBookingUtilization,
  ProgramAssignmentLimitError,
} from "@/lib/api/organizations/program-helpers";
import { checkPaymentLegsSumToAmount } from "@/lib/payments/payment-legs";
import { ENABLE_HOST_ORGS } from "@/lib/feature-flags";
import {
  recordOverageAtCheckout,
  notifyOverageDueAfterCommit,
  type PendingOverageNotification,
} from "@/lib/payments/billing/overage-settlement";
import { mintConsumerInvoiceBestEffort } from "@/lib/payments/billing/consumer-invoice";
import { DiscountExhaustedError } from "@/lib/payments/pricing/discount-exhausted-error";
import { savedCardCustomerId } from "@/lib/payments/core/saved-card-customer";
import {
  notifyOrgProgramExhausted,
  notifyOrgProgramCapNear,
} from "@/lib/novu/org-workflows";
import { sendOrgOperationalEmail } from "@/lib/email/senders/money";
import { getAppUrl } from "@/lib/url";
import {
  ensurePlatformCancellationPolicy,
  resolveCheckoutCancellationPolicyId,
} from "@/lib/payments/operations/cancellation-policy-store";
import {
  type BusinessErrorCode,
  isBusinessErrorCode,
} from "@/lib/errors/classification/payment-error-classification";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { seatPayerOrganizationId } from "@/lib/data/org-sponsored-seats";
import { tombstonePriorIntent } from "@/lib/payments/operations/prior-intent-tombstone";
import {
  releaseSupersededHolds,
  findReusablePendingOrderPayment,
} from "@/lib/payments/checkout/order-reuse";
import { buildPaymentMetadata } from "@/lib/payments/checkout/schema";
import { tombstoneAbortedGatewayOrder } from "@/lib/payments/checkout/gateway-intent";
import {
  getPlanDataForLock,
  releaseCheckoutLock,
  acquireCheckoutLock,
} from "@/lib/payments/checkout/locks";
import {
  assertSeatRemintable,
  asSeatPaymentConflict,
  findPriorSeatPayment,
  SEAT_CHECKOUT_OPEN_MESSAGE,
} from "@/lib/payments/checkout/seats";
import { calculateAmountAndValidate } from "@/lib/payments/checkout/pricing";
import { findSelfHoldAppointmentIds } from "@/lib/payments/checkout/self-hold";
import { assertConsulteeHasNoOverlappingSession } from "@/lib/payments/checkout/occupancy-validate";
import { revalidateInsideLock } from "@/lib/payments/checkout/revalidate";
import { handleClassCheckout } from "@/lib/payments/checkout/handlers/class";
import { handleWebinarCheckout } from "@/lib/payments/checkout/handlers/webinar";
import { handleSubscriptionCheckout } from "@/lib/payments/checkout/handlers/subscription";
import { handleConsultationCheckout } from "@/lib/payments/checkout/handlers/consultation";
import {
  assertWithinInvoiceCreditLimit,
  readInvoiceExposurePaise,
} from "@/lib/payments/checkout/org-funding";
import { resolveOrgFunding } from "@/lib/payments/checkout/org-funding";

// ============================================================================
// Type Definitions
// ============================================================================

// ============================================================================
// Helper Functions
// ============================================================================

const REFERRAL_CREDITS_DROPPED_NOTICE =
  "Referral credits can't be used on organisation-funded bookings, so none were spent.";

/**
 * #1582 B-P1-01b — coded refusals raised INSIDE the checkout transaction that
 * are modelled outcomes (tagged expected at Sentry). The overage-funding codes
 * stay out on purpose: they mean a programme is configured in a shape we
 * cannot collect on and must keep paging.
 */
const IN_TX_MODELLED_REFUSAL_CODES: ReadonlySet<BusinessErrorCode> =
  new Set<BusinessErrorCode>([
    "ORG_NOT_OPERATIONAL",
    "ORG_CANNOT_SPONSOR",
    "ORG_MEMBERSHIP_REQUIRED",
    "ORG_CREDIT_LIMIT_REACHED",
    "CONSULTANT_NOT_ON_PANEL",
    "CONSULTANT_EXCLUSIVE_ENGAGEMENT",
    "CREDIT_SHORTFALL",
    "DISCOUNT_EXHAUSTED",
    "SUBSCRIPTION_ALREADY_ACTIVE",
    "ALREADY_RENEWED",
    "INVALID_RENEWAL_SOURCE",
    "WELCOME_DISCOUNT_IN_USE",
    "PAYMENT_ALREADY_EXISTS",
    "SEAT_REBUY_UNSUPPORTED",
    "ALREADY_REGISTERED",
  ]);

// ============================================================================
// Open-Order Reuse (rec C, checkout dossier Q2)
// ============================================================================

// ============================================================================
// Payment Intent Manager
// ============================================================================

// ============================================================================
// Amount Calculation and Validation
// ============================================================================

// ============================================================================
// Slot Availability Validation
// ============================================================================

// ============================================================================
// Checkout Lock Management
// ============================================================================

// ============================================================================
// Appointment Creation Handlers (Type-Specific)
// ============================================================================

// ============================================================================
// Main Checkout Flows
// ============================================================================

/**
 * Ring one org-programme bell for a ProgramAssignment, after the checkout
 * transaction has settled.
 *
 * #1435 — both bells used to run this lookup on the global client from INSIDE
 * the Serializable transaction. Under PG_POOL_MAX=1 that query queues behind
 * the transaction's own connection and dies at the 3 s pg connect timeout, and
 * the .catch below swallowed it, so the bell was lost silently on Netlify.
 *
 * Fire-and-forget: a booking must not fail because a notification did not go
 * out. `Program.organizationId` lives on its parent Contract, not on Program
 * itself, so the select chain hops Program → Contract → Organization.
 */
async function dispatchProgramBell(
  programAssignmentId: string,
  bell:
    | { kind: "EXHAUSTED" }
    | {
        kind: "CAP_NEAR";
        engagementsUsed: number;
        cap: number;
        usedPct: number;
      },
): Promise<void> {
  const label =
    bell.kind === "EXHAUSTED"
      ? "notifyOrgProgramExhausted"
      : "notifyOrgProgramCapNear";
  await scheduleAfter(async () => {
    try {
      const ctx = await prisma.programAssignment.findUnique({
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
      });
      if (!ctx) return;
      const orgId = ctx.program.contract.organizationId;
      const orgName = ctx.program.contract.organization.name;
      const programName = ctx.program.name;
      const assigneeName =
        ctx.membership.user.name ?? ctx.membership.user.email;
      const dashboardUrl = `/dashboard/organization/${orgId}/programs`;
      const actionUrl = `${getAppUrl()}${dashboardUrl}`;
      const operatorRows = prisma.membership?.findMany
        ? await prisma.membership.findMany({
            where: {
              organizationId: orgId,
              status: "ACTIVE",
              role: { in: ["OWNER", "MAINTAINER"] },
            },
            select: { userId: true },
          })
        : [];
      const recipientUserIds = Array.from(
        new Set([ctx.membership.userId, ...operatorRows.map((r) => r.userId)]),
      );
      const common = {
        orgName,
        programName,
        assigneeName,
        dashboardUrl,
      };
      const settled =
        bell.kind === "EXHAUSTED"
          ? await Promise.allSettled([
              notifyOrgProgramExhausted(orgId, ctx.membership.userId, common),
              sendOrgOperationalEmail({
                recipientUserIds,
                organizationId: orgId,
                orgName,
                kind: "PROGRAM_EXHAUSTED",
                programName,
                assigneeName,
                actionUrl,
              }),
            ])
          : await Promise.allSettled([
              notifyOrgProgramCapNear(orgId, ctx.membership.userId, {
                ...common,
                engagementsUsed: bell.engagementsUsed,
                cap: bell.cap,
                usedPct: bell.usedPct,
              }),
              sendOrgOperationalEmail({
                recipientUserIds,
                organizationId: orgId,
                orgName,
                kind: "PROGRAM_CAP_NEAR",
                programName,
                assigneeName,
                engagementsUsed: bell.engagementsUsed,
                cap: bell.cap,
                usedPct: bell.usedPct,
                actionUrl,
              }),
            ]);
      for (const outcome of settled) {
        if (outcome.status === "rejected") {
          console.error(
            bell.kind === "EXHAUSTED"
              ? "[notifyOrgProgramExhausted] failed:"
              : "[notifyOrgProgramCapNear] failed:",
            outcome.reason,
          );
          reportSentryError(outcome.reason, {
            subsystem: "payments",
            level: "warning",
          });
        }
      }
    } catch (notifyErr) {
      console.error(
        bell.kind === "EXHAUSTED"
          ? "[notifyOrgProgramExhausted] failed:"
          : "[notifyOrgProgramCapNear] failed:",
        notifyErr,
      );
      reportSentryError(notifyErr, {
        subsystem: "payments",
        level: "warning",
      });
    }
  }, label);
}

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
  /** The `fam_via` own-link cookie, read by the route. */
  attribution: { viaToken?: string | null } = {},
) {
  const requestedType = validatedData.appointmentType;
  // Trials are booked through the trial flow; checkout never prices one.
  if (requestedType === "TRIAL") {
    throw new Error(`Unsupported appointment type: ${requestedType}`);
  }
  let lock: ApprovalLock | ApprovalLock[] | null = null;
  let lockType = "";
  // #898 follow-up — tier-2 consultee lock (acquired alongside the checkout lock
  // below; see the ordering note at STEP 2).
  let consulteeLock: ApprovalLock | null = null;
  // TYPE-1: Properly typed payment response instead of any
  let paymentResponse: { id: string; client_secret: string | null } | null =
    null;

  const appointmentType: Exclude<CheckoutInput["appointmentType"], "TRIAL"> =
    requestedType;

  const orgFunding = await resolveOrgFunding(
    validatedData,
    userId,
    appointmentType,
  );
  validatedData = orgFunding.validatedData;
  const {
    organizationId,
    programAssignmentId,
    fundingProgramId,
    callerMembershipId,
    referralCreditsDropped,
  } = orgFunding;
  let { billingAccountId, fundingSource, creditEffectiveLimit } = orgFunding;

  try {
    // STEP 1: Calculate amount and fetch plan data (OUTSIDE LOCK - just pricing)
    const {
      amount,
      originalAmount,
      taxAmount,
      currency,
      discountCodeId,
      consulteeProfileId,
      consulteeBillingStateCode,
      creditsApplied,
      buyerCountry: detectedBuyerCountry,
      isInternational,
      classSessionsQuoted,
      subscriptionSchedulingPeriod,
      attributionSource,
      attributionReferralId,
      platformFeeBps,
      welcomeDiscountPaise,
    } = await calculateAmountAndValidate(
      validatedData,
      userId,
      buyerCountry,
      // #1465-triage — resolved and membership-verified above; the slot gate
      // needs it to scope the self-hold exclusion to a resumable hold.
      organizationId,
      {
        viaToken: attribution.viaToken ?? null,
        orgFunded: fundingSource !== null && fundingSource !== "PERSONAL",
      },
    );

    // INVOICE fundingSource: fast-fail on the credit limit before any lock is
    // taken. #1744 row 4 — the booking itself counts: `exposure >= limit` let
    // one booking of any size through at ₹1 under the limit, so the predicate
    // is `exposure + this booking > limit` here and inside the tx alike.
    if (
      fundingSource === "INVOICE" &&
      creditEffectiveLimit !== null &&
      organizationId
    ) {
      const exposure = await readInvoiceExposurePaise(prisma, organizationId);
      assertWithinInvoiceCreditLimit(exposure, amount, creditEffectiveLimit);
    }

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

    // #1771 row 1 — before the slot lock, so a slow Customer API holds nothing; a
    // failure or timeout yields undefined (no saved-card offer), never a failed checkout.
    const savedCardCustomer =
      amount > 0 && (!fundingSource || fundingSource === "PERSONAL")
        ? await savedCardCustomerId(
            userId,
            validatedData.paymentGateway,
            isMockPayment,
          )
        : undefined;

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
      consulteeLock = await lockConsulteeBooking(
        userId,
        undefined,
        CHECKOUT_WAIT_RETRY_CONFIG,
      );
    }
    lock = await acquireCheckoutLock(validatedData, planData);
    lockType = validatedData.startsAt ? "slot-based" : "event-based";
    if (!isSlotBasedCheckout) {
      consulteeLock = await lockConsulteeBooking(
        userId,
        undefined,
        CHECKOUT_WAIT_RETRY_CONFIG,
      );
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
    const freshOrgFunding = await revalidateInsideLock(
      validatedData,
      userId,
      fundingProgramId,
      organizationId && callerMembershipId
        ? {
            organizationId,
            callerMembershipId,
            programAssignmentId,
            appointmentType,
            billingAccountId,
          }
        : null,
    );
    // Re-bind the rail from the locked read. This is the only place
    // fundingSource becomes authoritative, and it sits above every derivation
    // rather than inside any of them — a rail that moved mid-checkout is read
    // once, here, instead of being re-asked at each use.
    if (freshOrgFunding) {
      if (freshOrgFunding.fundingSource !== fundingSource) {
        throw Object.assign(
          new Error(
            "This organization's funding source changed while this booking was in progress. Please refresh and try again.",
          ),
          { httpStatus: 403, code: "ORG_CANNOT_SPONSOR" },
        );
      }
      fundingSource = freshOrgFunding.fundingSource;
      billingAccountId = freshOrgFunding.billingAccountId;
      creditEffectiveLimit = freshOrgFunding.creditEffectiveLimit;
    }

    console.log(
      JSON.stringify({
        event: "checkout_revalidation_passed",
        appointmentType: validatedData.appointmentType,
        timestamp: new Date().toISOString(),
      }),
    );

    // Enterprise funding derived from BillingAccount.fundingSource (as
    // RE-READ under the lock above) + ProgramAssignment. These booleans gate
    // the "skip the gateway entirely" path — org-funded bookings never go
    // through Stripe/Razorpay at checkout time — and they also decide the
    // PaymentLeg source, the wallet debit and whose cancellation ladder binds,
    // all of which are computed further down inside the booking transaction.
    //
    // The `!!programAssignmentId` conjunct is the fail-closed half, and it is
    // why a mid-flight rail change is safe in the direction it is: a fresh rail
    // of WALLET/INVOICE/LICENSE on a booking resolved under PERSONAL carries no
    // assignment (the pre-lock gate only resolves one for a non-PERSONAL rail),
    // so the booking is not treated as sponsored and the buyer is charged
    // rather than the org being charged for an entitlement nobody verified.
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

    // Rec C — adopt an open fresh PENDING order for this user+plan(+org)
    // BEFORE minting anything at the gateway. Runs under the checkout lock
    // (see findReusablePendingOrderPayment for the race-safety argument), so
    // a remount/new tab converges on the first attempt's order instead of
    // charging in parallel. Mock/zero-amount/org-sponsored flows are never
    // PENDING, so the lookup can only ever match a real gateway hold.
    //
    // #1220-triage — candidates are additionally gated on the slot window
    // (a different appointment time must never resume) and on priced-input
    // parity (amount must equal THIS request's computation). Rejections are
    // superseded to EXPIRED so they can neither be resumed later nor re-minted
    // into a parallel charge by a third tab.
    const { reusable: reusableOrder, supersede: supersededOrders } =
      await findReusablePendingOrderPayment(prisma, {
        userId,
        appointmentType,
        planId: validatedData.planId,
        eventId: validatedData.eventId,
        organizationId,
        paymentGateway: validatedData.paymentGateway,
        expectedAmountPaise: amount,
        ...(appointmentType === "CONSULTATION" &&
        validatedData.startsAt &&
        validatedData.endsAt
          ? {
              slotWindow: {
                startsAt: new Date(validatedData.startsAt),
                endsAt: new Date(validatedData.endsAt),
              },
            }
          : {}),
        ...(appointmentType === "SUBSCRIPTION"
          ? {
              schedulingPeriod:
                subscriptionSchedulingPeriod ??
                (validatedData.schedulingPeriodStartsAt &&
                validatedData.schedulingPeriodEndsAt
                  ? {
                      startsAt: new Date(
                        validatedData.schedulingPeriodStartsAt,
                      ),
                      endsAt: new Date(validatedData.schedulingPeriodEndsAt),
                    }
                  : null),
            }
          : {}),
      });
    if (supersededOrders.length > 0) {
      // #1463 — expiring the payment is only half of it; the hold it minted has
      // to come off the calendar in the same transaction or this buyer's next
      // attempt walls itself out again. See releaseSupersededHolds.
      await releaseSupersededHolds({
        paymentIds: supersededOrders.map((s) => s.id),
        userId,
      });
      console.log(
        JSON.stringify({
          event: "checkout_open_order_superseded",
          appointmentType,
          count: supersededOrders.length,
          reason: supersededOrders[0].reason,
          timestamp: new Date().toISOString(),
        }),
      );
    }
    if (reusableOrder) {
      console.log(
        JSON.stringify({
          event: "checkout_open_order_reused",
          appointmentType,
          orderId: reusableOrder.paymentIntent,
          // #1220-triage — payment row id, not raw userId (no PII pairing in logs).
          paymentRowId: reusableOrder.id,
          timestamp: new Date().toISOString(),
        }),
      );
      // Same shape as replayByIdempotencyKey's PENDING branch so clients
      // handle both resume paths identically.
      return {
        success: true,
        reused: true,
        orderId: reusableOrder.paymentIntent,
        paymentIntent: {
          id: reusableOrder.paymentIntent,
          client_secret: null,
        },
        amount: Number(reusableOrder.amount),
        currency: reusableOrder.currency,
        isMockPayment: reusableOrder.isMockPayment,
        // #1437 — PENDING reuse is always a real gateway hold (mock/zero/
        // org-sponsored payments never land in PENDING, see the comment
        // above findReusablePendingOrderPayment), so the page must open it.
        skipPayment: reusableOrder.isMockPayment,
        holdExpiresAt: reusableOrder.expiresAt?.toISOString() ?? null,
        message: "Resuming your in-progress checkout.",
      };
    }

    // #832 — one checked renewal at the long-latency boundary (gateway call
    // + tentative-booking tx still ahead). A false return means the lock
    // already expired and another buyer may hold it; proceeding is exactly
    // the double-booking hazard the lock exists to prevent. A timer-based
    // heartbeat is deliberately avoided: serverless freeze makes intervals
    // unreliable, and the message must contain "already in progress" so
    // classifyError maps it to LOCK_CONTENTION → 409.
    // #1319 (R8) — one renewal here did not cover the Serializable retry loop
    // below: four 25 s attempts outlive a 60 s CONSULTATION grant, and the
    // lock silently lapsed mid-payment. Renew at the top of EVERY attempt
    // with a grant sized to one attempt plus slack, so elapsed time stops
    // mattering; only per-attempt duration does. Ownership lost → abort the
    // attempt (not a P2034, so the retry helper rethrows immediately).
    const checkoutTxTimeoutMs = 25_000;
    const perAttemptTtl = Math.max(
      CHECKOUT_LOCK_TTL_MS[validatedData.appointmentType] ?? 60_000,
      checkoutTxTimeoutMs + 10_000,
    );
    const renewOrAbort = async (ttl: number): Promise<void> => {
      if (!lock) return;
      const renewed = Array.isArray(lock)
        ? await extendSlotInterval(lock, ttl)
        : await extendLock(lock, ttl);
      if (!renewed) {
        throw new Error(
          "Checkout took too long and its hold expired — another checkout for this slot may be already in progress. Please try again.",
        );
      }
      if (consulteeLock) {
        const consulteeRenewed = await extendLock(consulteeLock, ttl);
        if (consulteeRenewed === false) {
          throw new Error(
            "Checkout took too long and its hold expired — another checkout for this slot may be already in progress. Please try again.",
          );
        }
      }
    };
    await renewOrAbort(perAttemptTtl);

    // #1861 L1 — one deadline for the gateway's capture window and the
    // PENDING row, so a Serializable retry cannot push the row past the order.
    const holdExpiresAt = new Date(Date.now() + DIRECT_CHECKOUT_HOLD_MS);

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
        const { createPaymentIntent } = await import("../index");
        paymentResponse = await createPaymentIntent({
          amount,
          currency,
          metadata: buildPaymentMetadata(validatedData, userId, {
            organizationId,
            fundingSource,
          }),
          paymentGateway: validatedData.paymentGateway,
          isMockPayment,
          customerId: savedCardCustomer,
          holdExpiresAt,
        });
      } catch (paymentError) {
        console.error("Payment intent creation failed:", paymentError);
        reportSentryError(paymentError, { subsystem: "payments" });
        // Typed gateway errors keep their code for the route's classifier.
        if (paymentError instanceof PaymentError) throw paymentError;
        throw new Error(
          "Failed to create payment intent. Please try again later.",
        );
      }
    }

    // Every rail above sets an order or throws; the booking tx reads this narrowed value.
    if (!paymentResponse) {
      throw new PaymentError(
        "Failed to create payment intent. Please try again later.",
        "PAYMENT_INTENT_MISSING",
        validatedData.paymentGateway,
      );
    }
    const mintedOrder = paymentResponse;

    // STEP 5: Create tentative appointment + payment record (INSIDE LOCK)
    // This prevents race conditions by making validation see tentative bookings
    try {
      // #1093 tail — the ONLY Serializable site that wasn't retried: a P2034
      // under hot-webinar contention surfaced as a generic failure instead of
      // being retried into the sibling's committed state.
      //
      // #1435 — so the body no longer touches the OUTER prisma client at all.
      // Every org-programme bell is CAPTURED inside the transaction and rung
      // once it has settled. The two success-path bells travel out on the
      // transaction's return value, which by construction is the committing
      // attempt's, so a P2034 retry cannot ring them twice; the cap-exhausted
      // bell cannot (it throws), so it rides out on this holder instead.
      const exhaustedBell: { programAssignmentId: string | null } = {
        programAssignmentId: null,
      };

      // #1513 review — provision the platform policy row HERE, on the global
      // client, not from inside the transaction below. The provisioner recovers
      // from a P2002 by re-reading the winner's row, and inside a Serializable
      // transaction a P2002 aborts the transaction, so that re-read would fail
      // and take the sale with it. On the global client every statement is its
      // own autocommit unit, so the loser of the race really does get to re-read.
      // It must also stay OUTSIDE any `$transaction` callback: PG_POOL_MAX=1
      // means a global-client query issued while a transaction holds the single
      // connection deadlocks (#1435, see lib/prisma.ts).
      await ensurePlatformCancellationPolicy(prisma);

      const result = await withSerializableRetry(async () => {
        await renewOrAbort(perAttemptTtl);
        return prisma.$transaction(
          async (tx) => {
            // #1435 — this attempt's bells, returned below and rung post-commit.
            let capNearBell: {
              programAssignmentId: string;
              engagementsUsed: number;
              cap: number;
              usedPct: number;
            } | null = null;
            let overageBell: PendingOverageNotification | null = null;

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
              const exposure = await readInvoiceExposurePaise(
                tx,
                organizationId,
              );
              // Same gate as the pre-lock check, re-run inside the tx so a
              // concurrent sibling's just-committed accrual is visible — SSI then
              // aborts the loser of a racing pair instead of both straddling the cap.
              assertWithinInvoiceCreditLimit(
                exposure,
                amount,
                creditEffectiveLimit,
              );
            }

            let createdAppointment;
            // Engagement count for enterprise cap (issue #710). One
            // engagement = one Appointment row = one calendar occurrence.
            //   - CONSULTATION/WEBINAR: 1 (single Appointment created here)
            //   - CLASS: N (count of appointments the learner enrolled in,
            //     all known at checkout because consultant pre-allocated)
            //   - SUBSCRIPTION: null → SKIP recordBookingUtilization at
            //     checkout. Slots are allocated lazily by the consultant;
            //     debits land in SchedulingService.createAppointments,
            //     1 per allocation batch.
            let engagementsForCap: number | null = null;
            let classEngagementIds: string[] = [];
            let bookedPlan: {
              consultantProfileId?: string | null;
              organizationId?: string | null;
            } | null = null;

            const skipPayment =
              isMockPayment || isZeroAmountPayment || isOrgSponsoredPayment;

            const cancellationPolicyId =
              await resolveCheckoutCancellationPolicyId(tx, {
                organizationId: isOrgSponsoredPayment ? organizationId : null,
              });

            // A PERSONAL-rail booking is paid by the member's own card, so
            // Appointment.organizationId stays null (keeps the booking on the
            // buyer's personal dashboard rather than vanishing from personal
            // scope while Payment.organizationId retains the reporting tag).
            const appointmentOrganizationId =
              fundingSource === "PERSONAL" ? null : organizationId;

            // Create appointment based on type (with isTentative flag)
            switch (validatedData.appointmentType) {
              case "CONSULTATION": {
                if (validatedData.startsAt && validatedData.endsAt) {
                  await assertConsulteeHasNoOverlappingSession(tx, {
                    userId,
                    startsAt: validatedData.startsAt!,
                    endsAt: validatedData.endsAt!,
                    selfHoldAppointmentIds: await findSelfHoldAppointmentIds(
                      tx,
                      {
                        buyerUserId: userId,
                        appointmentType: validatedData.appointmentType,
                        planId: validatedData.planId,
                        paymentGateway: validatedData.paymentGateway,
                        organizationId,
                        slotStart: new Date(validatedData.startsAt),
                        slotEnd: new Date(validatedData.endsAt),
                        now: new Date(),
                      },
                    ),
                  });
                }
                const consultationResult = await handleConsultationCheckout(
                  tx,
                  validatedData,
                  consulteeProfileId,
                  userId,
                  skipPayment,
                  appointmentOrganizationId,
                  cancellationPolicyId,
                  organizationId,
                );
                createdAppointment = consultationResult.appointment;
                bookedPlan = consultationResult.plan;
                engagementsForCap = 1;
                break;
              }

              case "SUBSCRIPTION": {
                const subscriptionResult = await handleSubscriptionCheckout(
                  tx,
                  validatedData,
                  consulteeProfileId,
                  skipPayment,
                  appointmentOrganizationId,
                  cancellationPolicyId,
                  subscriptionSchedulingPeriod,
                );
                createdAppointment = subscriptionResult.appointment;
                bookedPlan = subscriptionResult.plan;
                break;
              }

              case "WEBINAR": {
                const webinarResult = await handleWebinarCheckout(
                  tx,
                  validatedData,
                  userId,
                  skipPayment,
                  seatPayerOrganizationId(
                    organizationId,
                    isOrgSponsoredPayment,
                  ),
                );
                for (const occ of webinarResult.appointment?.occurrences ??
                  []) {
                  if (
                    occ.startsAt &&
                    occ.endsAt &&
                    !occ.deletedAt &&
                    occ.completionStatus !== "CANCELLED"
                  ) {
                    await assertConsulteeHasNoOverlappingSession(tx, {
                      userId,
                      startsAt: occ.startsAt,
                      endsAt: occ.endsAt,
                      selfHoldAppointmentIds: webinarResult.appointment
                        ? [webinarResult.appointment.id]
                        : [],
                    });
                  }
                }
                createdAppointment = webinarResult.appointment;
                bookedPlan = webinarResult.plan;
                engagementsForCap = 1;
                break;
              }

              case "CLASS": {
                const classResult = await handleClassCheckout(
                  tx,
                  validatedData,
                  userId,
                  skipPayment,
                  classSessionsQuoted,
                  seatPayerOrganizationId(
                    organizationId,
                    isOrgSponsoredPayment,
                  ),
                );
                for (const occ of classResult.appointment?.occurrences ?? []) {
                  if (
                    occ.startsAt &&
                    occ.endsAt &&
                    !occ.deletedAt &&
                    occ.completionStatus !== "CANCELLED"
                  ) {
                    await assertConsulteeHasNoOverlappingSession(tx, {
                      userId,
                      startsAt: occ.startsAt,
                      endsAt: occ.endsAt,
                      selfHoldAppointmentIds: classResult.appointment
                        ? [classResult.appointment.id]
                        : [],
                    });
                  }
                }
                createdAppointment = classResult.appointment || null;
                bookedPlan = classResult.plan;
                engagementsForCap = classResult.engagementsConsumed;
                classEngagementIds = classResult.engagementIds;
                break;
              }

              default:
                throw new Error(
                  `Unsupported appointment type: ${validatedData.appointmentType}`,
                );
            }

            let hostOrganizationId: string | null = null;
            if (ENABLE_HOST_ORGS) {
              const planOwnerOrgId = bookedPlan?.organizationId ?? null;
              if (
                bookedPlan?.consultantProfileId &&
                typeof tx.membership?.findFirst === "function"
              ) {
                const ownerMembership = planOwnerOrgId
                  ? await tx.membership.findFirst({
                      where: {
                        consultantProfileId: bookedPlan.consultantProfileId,
                        role: "EXPERT",
                        status: "ACTIVE",
                        organizationId: planOwnerOrgId,
                        organization: { canHost: true, status: "ACTIVE" },
                      },
                      select: { organizationId: true },
                    })
                  : null;
                const hostMembership =
                  ownerMembership ??
                  (await tx.membership.findFirst({
                    where: {
                      consultantProfileId: bookedPlan.consultantProfileId,
                      role: "EXPERT",
                      status: "ACTIVE",
                      organization: { canHost: true, status: "ACTIVE" },
                    },
                    orderBy: { createdAt: "asc" },
                    select: { organizationId: true },
                  }));
                hostOrganizationId = hostMembership?.organizationId ?? null;
              } else {
                hostOrganizationId = planOwnerOrgId;
              }
            }

            const paymentData = {
              amount,
              originalAmount,
              // The licence invoice books the GST; a licensed booking books none.
              taxAmount: isOrgLicensedPayment ? 0 : taxAmount,
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
              paymentIntent: mintedOrder.id,
              clientIdempotencyKey:
                validatedData.clientIdempotencyKey ??
                globalThis.crypto.randomUUID(),
              paymentGateway: validatedData.paymentGateway,
              paymentStatus: skipPayment
                ? PaymentStatus.SUCCEEDED
                : PaymentStatus.PENDING,
              isMockPayment:
                isMockPayment || isZeroAmountPayment || isOrgSponsoredPayment,
              discountCodeId,
              expiresAt: skipPayment ? null : holdExpiresAt,
              buyerCountry: detectedBuyerCountry,
              isInternational,
              displayCurrencyAtCheckout,
              exchangeRateAtCheckout,
              consumerStateCode:
                validatedData.consumerStateCode ??
                consulteeBillingStateCode ??
                null,
              organizationId,
              hostOrganizationId,
              billingAccountId,
              attributionSource,
              attributionReferralId,
              platformFeeBps,
              welcomeDiscountPaise:
                welcomeDiscountPaise > 0 ? welcomeDiscountPaise : null,
            };

            // Group events share one appointment, so a re-buy re-mints the buyer's dead row in place.
            const isEventSeat =
              validatedData.appointmentType === "WEBINAR" ||
              validatedData.appointmentType === "CLASS";
            const priorSeatPayment =
              isEventSeat && createdAppointment
                ? await findPriorSeatPayment(tx, userId, createdAppointment.id)
                : null;
            let payment: { id: string; amount: number; expiresAt: Date | null };
            if (priorSeatPayment) {
              assertSeatRemintable(
                priorSeatPayment,
                validatedData.appointmentType === "CLASS" ? "CLASS" : "WEBINAR",
              );
              // The old order's identity, kept apart from the row the CAS is about to rewrite.
              const retiringIntent = { ...priorSeatPayment };
              const reminted = await tx.payment.updateMany({
                where: {
                  id: priorSeatPayment.id,
                  paymentStatus: {
                    in: [PaymentStatus.EXPIRED, PaymentStatus.FAILED],
                  },
                },
                data: {
                  ...paymentData,
                  gatewayPaymentId: null,
                  capturedAt: null,
                  deletedAt: null,
                  description: null,
                  receiptUrl: null,
                  referralReleasedAt: null,
                },
              });
              if (reminted.count !== 1) {
                throw new BookingRuleError(
                  "PAYMENT_ALREADY_EXISTS",
                  SEAT_CHECKOUT_OPEN_MESSAGE,
                );
              }
              await tombstonePriorIntent(
                tx,
                retiringIntent,
                "seat re-bought after the earlier payment lapsed or failed",
              );
              payment = {
                id: priorSeatPayment.id,
                amount,
                expiresAt: paymentData.expiresAt,
              };
            } else {
              payment = await tx.payment.create({
                data: {
                  ...paymentData,
                  userId: userId,
                  appointmentId: createdAppointment?.id || null,
                },
                select: { id: true, amount: true, expiresAt: true },
              });
            }

            if (
              validatedData.consumerStateCode &&
              validatedData.consumerStateCode !== consulteeBillingStateCode
            ) {
              await tx.consulteeProfile.updateMany({
                where: { userId },
                data: { billingStateCode: validatedData.consumerStateCode },
              });
            }

            if (createdAppointment) {
              const participantWhere =
                validatedData.appointmentType === "CLASS" &&
                validatedData.eventId
                  ? { appointment: { classId: validatedData.eventId }, userId }
                  : validatedData.appointmentType === "WEBINAR"
                    ? { appointmentId: createdAppointment.id, userId }
                    : { appointmentId: createdAppointment.id };
              if (
                validatedData.appointmentType === "CLASS" &&
                validatedData.eventId
              ) {
                await tx.appointmentParticipant.updateMany({
                  where: { ...participantWhere, paymentId: null },
                  data: { paymentId: payment.id },
                });
              } else {
                await linkParticipantsToPayment(
                  tx,
                  createdAppointment.id,
                  payment.id,
                  validatedData.appointmentType === "WEBINAR"
                    ? userId
                    : undefined,
                );
              }
              if (skipPayment) {
                await transitionParticipant(tx, participantWhere, "CONFIRMED");
              }
            }

            if (isOrgWalletPayment && billingAccountId) {
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

            if (programAssignmentId && isOrgSponsoredPayment) {
              await tx.paymentLeg.create({
                data: {
                  paymentId: payment.id,
                  source: isOrgWalletPayment
                    ? "WALLET"
                    : isOrgLicensedPayment
                      ? "LICENSE"
                      : "INVOICE_ACCRUAL",
                  amountPaise: isOrgLicensedPayment ? 0 : amount,
                  sourceRef: programAssignmentId,
                },
              });
            }

            if (programAssignmentId && engagementsForCap !== null) {
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
                  // PR-1e (G3) — the helper's set-diff idempotency guard only
                  // arms itself when the caller NAMES the appointments.
                  // Omitting them left every checkout debit unguarded, so a
                  // replay against the same Payment (retried webhook, resumed
                  // order) incremented the meter a second time.
                  // CONSULTATION/WEBINAR are one engagement on the appointment
                  // just created; CLASS meters one per class session, which is
                  // exactly the occurrence set handleClassCheckout counted.
                  appointmentIds:
                    validatedData.appointmentType === "CLASS"
                      ? classEngagementIds
                      : createdAppointment
                        ? [createdAppointment.id]
                        : [],
                });
              } catch (err) {
                if (err instanceof ProgramAssignmentLimitError) {
                  // The assignee + org operators are told the programme is
                  // spent. This is the one bell that belongs on the ROLLBACK
                  // path — the refusal IS the news — so it is rung from the
                  // retry wrapper's catch rather than after a commit that
                  // never happens.
                  exhaustedBell.programAssignmentId = programAssignmentId;

                  // #1458 — a stable code, because the message-preservation
                  // list below never matched this sentence and the buyer got
                  // "Failed to record payment information" for a cap they can
                  // ask an admin to raise.
                  throw Object.assign(
                    new Error(
                      "Your program has hit its session cap for this cycle. Ask your organization admin to upgrade the program or wait for the next cycle.",
                    ),
                    { httpStatus: 402, code: "PROGRAM_SESSION_CAP_REACHED" },
                  );
                }
                throw err;
              }

              // #768 #22 — 80% cap-near early warning. Fire ONCE per cycle on
              // the <80% → >=80% transition (not on every booking past 80%).
              // Integer-only threshold cross: before/cap < 0.8 (before*5 <
              // cap*4) AND after/cap >= 0.8 (after*5 >= cap*4). Skipped when
              // cap is null (unlimited) or 0. Captured for post-commit
              // delivery + same roster as the 100% event.
              {
                // #775 — LICENSED_SEAT meters in engagements, CREDIT_POOL in
                // paise (consumedPaise vs creditBudgetPaise). The 80% transition
                // math is unit-agnostic; the Novu payload reports credits for
                // pools (÷100) and engagements for seats.
                const isCredit =
                  utilizationResult.programType === "CREDIT_POOL";
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
                  capAfter !== null &&
                  capAfter !== undefined &&
                  capAfter > 0 &&
                  before * 5 < capAfter * 4 &&
                  after * 5 >= capAfter * 4
                ) {
                  // #1169 PR 2 — the bell must ring once per booking, not once
                  // per Serializable attempt. The slot is a local of this
                  // attempt and only the committing attempt's is returned,
                  // which is what enforces that now.
                  capNearBell = {
                    programAssignmentId,
                    engagementsUsed: isCredit ? Math.round(after / 100) : after,
                    cap: isCredit ? Math.round(capAfter / 100) : capAfter,
                    usedPct: Math.round((after / capAfter) * 100),
                  };
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
              if (utilizationResult.wasOverage && isOrgSponsoredPayment) {
                // #778 elegance — extracted to recordOverageAtCheckout (resolves
                // the behaviour via computeOverage, enforces the circuit breaker,
                // persists the OverageEvent + CHARGE_MEMBER side-Payment /
                // CHARGE_ORG accrual leg). Throws PROGRAM_CAP_EXHAUSTED (402) on
                // the breaker veto. PERSONAL-funded bookings already charge the
                // member's gateway directly, so only org-sponsored payments run
                // checkout overage settlement.
                overageBell = await recordOverageAtCheckout({
                  tx,
                  programAssignmentId,
                  utilization: {
                    programType: utilizationResult.programType,
                    engagementsConsumedDelta:
                      utilizationResult.engagementsConsumedDelta,
                    engagementsUsedAfter:
                      utilizationResult.engagementsUsedAfter,
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
            // mirroring the field-level comment on `Payment.amount`, so this
            // one leg alone carries the funding identity: the REFERRAL_CREDIT
            // leg `applyCreditsToPayment` writes further down in this same TX
            // is excluded from the sum rather than added to it (#1347).
            if (!isOrgSponsoredPayment && amount > 0) {
              await tx.paymentLeg.create({
                data: {
                  paymentId: payment.id,
                  source: "CARD",
                  amountPaise: amount,
                  sourceRef: mintedOrder.id,
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
                throw new DiscountExhaustedError(
                  discountForIncrement.currentUses,
                  discountForIncrement.maxUses,
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
            let creditsRemainingAfter: number | null = null;
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
                // #1586 J32 — a modelled race, answered 409 + retryAfter.
                throw Object.assign(
                  new Error(
                    `CREDIT_SHORTFALL: expected ${creditsApplied} paise credits but only ${actualCredits} available. ` +
                      `Payment ${payment.id} amount is stale. Aborting for retry.`,
                  ),
                  { httpStatus: 409, code: "CREDIT_SHORTFALL", retryAfter: 2 },
                );
              }
              actualCreditsApplied = creditsApplied; // In paise
              // The balance the credits-applied bell states, read inside the
              // transaction so a later checkout cannot change it first.
              creditsRemainingAfter = (await getUserCredits(userId, tx))
                .totalAvailable;
            }

            // Invariant sweep: every Payment should have legs that sum to
            // `Payment.amount`, excluding REFERRAL_CREDIT, which is already
            // netted out of it (#1347) —
            // `docs/enterprise/10-money-and-ledger/09-payment-legs.md`. We
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
              const currentPayment =
                typeof tx.payment?.findUnique === "function"
                  ? await tx.payment.findUnique({
                      where: { id: payment.id },
                      select: { amount: true },
                    })
                  : null;
              const legMismatch = checkPaymentLegsSumToAmount({
                paymentAmountPaise: currentPayment?.amount ?? payment.amount,
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

            // The synchronous rails confirm here, so their earnings and the
            // booking:<paymentId> journal commit with the payment or not at all.
            if (skipPayment) {
              const resolvedEarnings = await resolvePaymentForEarnings(
                { id: payment.id },
                validatedData.appointmentType,
                tx,
              );
              if (resolvedEarnings) {
                await createEarningsFromPayment({
                  payment: resolvedEarnings.paymentForEarnings,
                  appointmentType: resolvedEarnings.earningsAppointmentType,
                  tx,
                });
              }
              await recordReferralCaptureInSavepoint(tx, {
                paymentId: payment.id,
                consultantProfileId: () =>
                  Promise.resolve(resolvedEarnings?.consultantProfileId),
              });
            }

            return {
              appointmentId: createdAppointment?.id,
              holdExpiresAt: payment.expiresAt,
              creditsApplied: actualCreditsApplied,
              creditsRemainingAfter,
              capNearBell,
              overageBell,
            };
          },
          {
            timeout: checkoutTxTimeoutMs,
            // H6 FIX: Use Serializable isolation for booking transactions to prevent
            // phantom reads on capacity-limited events (webinars, classes). The
            // distributed lock serializes per-event, but Serializable adds DB-level
            // safety for edge cases like lock expiry under high load.
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        );
      }).catch(async (err) => {
        // #1435 — post-rollback delivery for the one bell whose news IS the
        // refusal. Nothing else below is reached when the transaction fails.
        if (exhaustedBell.programAssignmentId) {
          await dispatchProgramBell(exhaustedBell.programAssignmentId, {
            kind: "EXHAUSTED",
          });
        }
        throw err;
      });

      // #1435 — post-COMMIT delivery for the bells that describe a booking that
      // actually happened. See dispatchProgramBell for why neither lookup can
      // run inside the transaction.
      if (result.capNearBell) {
        await dispatchProgramBell(result.capNearBell.programAssignmentId, {
          kind: "CAP_NEAR",
          engagementsUsed: result.capNearBell.engagementsUsed,
          cap: result.capNearBell.cap,
          usedPct: result.capNearBell.usedPct,
        });
      }
      if (result.overageBell) {
        await notifyOverageDueAfterCommit(result.overageBell);
      }

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

      // Mock/zero-amount/org-sponsored payments never see a capture webhook,
      // so their post-commit follow-ups run here.
      if (isMockPayment || isZeroAmountPayment || isOrgSponsoredPayment) {
        // applyCreditsToPayment committed above, so this post-commit bell reads settled state.
        if (result.creditsApplied > 0) {
          await scheduleAfter(
            () =>
              notifyCreditsAppliedBestEffort({
                userId,
                creditsUsedPaise: result.creditsApplied,
                remainingPaise: result.creditsRemainingAfter,
                appointmentType: validatedData.appointmentType,
              }).catch((bellErr) =>
                console.error("[credits-applied-bell] failed:", bellErr),
              ),
            "checkout.credits-applied-bell",
          );
        }

        // #1365 — these payments never see a capture webhook, so the tax
        // invoice has to be minted here too. Org-sponsored payments no-op
        // inside the minter by design; they are invoiced on the org series.
        await mintConsumerInvoiceBestEffort({
          paymentIntent: mintedOrder.id,
        });

        const appointmentIdForChannels = result.appointmentId;
        if (appointmentIdForChannels) {
          await scheduleAfter(async () => {
            try {
              const { ensureChannelsForAppointment } =
                await import("@/lib/payments/webhooks/ensure-channels");
              await ensureChannelsForAppointment(appointmentIdForChannels);
            } catch (channelErr) {
              console.error("[checkout.ensure-channels] failed:", channelErr);
            }
          }, "checkout.ensure-channels");
        }
      }

      let message =
        "Payment intent created. Complete payment to book appointment.";
      if (isZeroAmountPayment) {
        message =
          "Payment completed via referral credits. Appointment booked successfully.";
      } else if (isMockPayment) {
        message = "Mock payment completed and appointment created successfully";
      } else if (isOrgSponsoredPayment) {
        message =
          "Payment completed via organization funding. Appointment booked successfully.";
        if (referralCreditsDropped) {
          message += ` ${REFERRAL_CREDITS_DROPPED_NOTICE}`;
        }
      }

      return {
        success: true,
        paymentIntent: paymentResponse,
        message,
        referralCreditsDropped,
        amount,
        currency,
        isMockPayment: isMockPayment || isZeroAmountPayment,
        isZeroAmountPayment,
        // #1437 — WALLET/INVOICE/LICENSE org funding also confirms
        // synchronously with a synthetic org_* id and no gateway order;
        // isMockPayment/isZeroAmountPayment don't cover it, so the client
        // was opening Razorpay on an id the gateway had never heard of.
        // Matches checkout-replay.ts's SUCCEEDED-branch field name.
        skipPayment:
          isMockPayment || isZeroAmountPayment || isOrgSponsoredPayment,
        // #1861 L1 — Checkout's `timeout` is sized to this.
        holdExpiresAt: result.holdExpiresAt?.toISOString() ?? null,
      };
    } catch (caught) {
      const dbError = asSeatPaymentConflict(asWelcomeDiscountConflict(caught));
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
        "already have a session booked", // consultee double-book (FAMILIARISE_WEB-P)
        "overlapping dates",
        "insufficient credits",
        "session cap", // ProgramAssignmentLimitError-derived message, above
        // #1132 — slot contention is a modelled outcome, not a fault. These
        // were added to `preservedMessages` below so the user gets a real
        // message, but tagging is a separate list by design (see comment
        // above), so without them here every lost slot raced to Sentry as
        // `expected: false` and normal contention looked like a payment
        // incident.
        "already booked",
        "no longer available",
      ];
      // Typed errors and stable codes first — a substring is a last resort,
      // not the mechanism. recordOverageAtCheckout stamps
      // code: "PROGRAM_CAP_EXHAUSTED" on its 402, which this used to miss
      // entirely and report as a fault.
      const dbErrorCode = (dbError as { code?: unknown } | null)?.code;
      // #1583 C-P1-04 — the loser of two same-key checkouts; the route
      // replays the winner, so this is a modelled race and must not be rewrapped.
      const isIdempotencyKeyCollision = isUniqueViolationOn(
        dbError,
        "clientIdempotencyKey",
      );
      const isModelledOutcome =
        isIdempotencyKeyCollision ||
        dbError instanceof WalletFrozenError ||
        dbError instanceof ProgramAssignmentLimitError ||
        dbErrorCode === "PROGRAM_CAP_EXHAUSTED" ||
        // #1458 — the per-assignment session cap is the same class of modelled
        // refusal as the per-cycle overage ceiling above. The overage funding
        // codes are deliberately NOT here: they mean a programme was configured
        // in a shape we cannot collect on, which has to keep paging.
        dbErrorCode === "PROGRAM_SESSION_CAP_REACHED" ||
        // #1477 — an org that has spent its wallet down is refusing the
        // booking, not faulting on it. The rethrow below already lets it
        // through on its registered code; tagging is a separate list by
        // design, so without this line the routine refusal kept paging.
        dbErrorCode === "WALLET_INSUFFICIENT_FUNDS" ||
        // #1582 B-P1-01b — the in-tx org/panel/credit refusals and the
        // CREDIT_SHORTFALL race are answers, not faults.
        (isBusinessErrorCode(dbErrorCode) &&
          IN_TX_MODELLED_REFUSAL_CODES.has(dbErrorCode)) ||
        (dbError instanceof Error &&
          modelledOutcomePatterns.some((msg) =>
            // Word-bounded: bare `includes` let "full" match "successful" and
            // "ended" match "unintended", tagging real faults as routine.
            new RegExp(`\\b${msg}\\b`, "i").test(dbError.message),
          ));
      reportSentryError(dbError, {
        subsystem: "payments",
        expected: isModelledOutcome,
      });

      // CRITICAL: Cancel payment intent since DB operation failed
      // (Skip cleanup for zero-amount payments — they have no real gateway intent)
      if (paymentResponse && !isZeroAmountPayment) {
        try {
          const { cancelPaymentIntent } = await import("../index");
          await cancelPaymentIntent(paymentResponse.id);
        } catch (cancelErr) {
          console.error(
            `Failed to cancel payment intent ${paymentResponse.id}:`,
            cancelErr,
          );
          reportSentryError(cancelErr, {
            subsystem: "payments",
            level: "warning",
          });
        }
      }

      // #1695 — Razorpay cannot void a minted order, so a buyer who completes
      // it after this abort (a CREDIT_SHORTFALL retry, say) captures money
      // with no Payment row to land on, and the webhook re-drives "Payment
      // record not found" forever. An EXPIRED tombstone gives that capture a
      // row: the capture handler claims it and auto-refunds. Best-effort, and
      // never on mock, org-funded or zero-amount intents, which the gateway
      // never sees.
      if (
        paymentResponse &&
        !isZeroAmountPayment &&
        !isOrgSponsoredPayment &&
        !isMockPayment &&
        validatedData.paymentGateway === PaymentGateway.RAZORPAY
      ) {
        await tombstoneAbortedGatewayOrder({
          paymentIntent: paymentResponse.id,
          userId,
          amount,
          originalAmount,
          taxAmount,
          currency,
          reason: dbError instanceof Error ? dbError.message : String(dbError),
        });
      }

      // #837 — WalletFrozenError carries httpStatus=409 + an actionable reason;
      // don't let it collapse into the generic "Failed to record payment
      // information" below. Rethrow so the route surfaces the 409.
      if (dbError instanceof WalletFrozenError) {
        throw dbError;
      }

      // #1583 C-P1-04 — the route's P2002 replay branch needs the Prisma error
      // itself; wrapped, the loser answered 500 instead of the winner's response.
      if (isIdempotencyKeyCollision) {
        throw dbError;
      }

      // #1458 — an error carrying a registered business code already resolves
      // to its own status and toast in the classifier, so rewriting it to the
      // generic message below is pure loss: PROGRAM_CAP_EXHAUSTED was thrown as
      // a 402 with actionable copy and reached the buyer as a 500
      // "Something Went Wrong". Codes are checked before messages because a
      // code survives a reworded sentence and a substring does not.
      if (dbError instanceof Error && isBusinessErrorCode(dbErrorCode)) {
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
          "already have a session booked", // consultee double-book (FAMILIARISE_WEB-P)
          "overlapping dates",
          "insufficient credits",
          // #1132 — validateSlotAvailability throws these from INSIDE the
          // transaction, so without them here a genuine slot conflict was
          // rewritten to "Failed to record payment information" → UNKNOWN →
          // "Something Went Wrong", and the user had no idea to pick another
          // slot. ADR 16's clean-error claim only held for the pre-transaction
          // check.
          "already booked",
          "no longer available",
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
    // expected race between two concurrent checkouts; consultee double-book
    // from revalidateInsideLock is the same class of rejection (FAMILIARISE_WEB-P).
    // Anything else here is unclassified and reported as a fault by default.
    const isLockContention =
      error instanceof Error &&
      (error.message.includes("currently checking out") ||
        error.message.includes("currently being booked"));
    // Tag-only: the explicit lock-expiry throw above ("...already in
    // progress...") is the same modelled race, but is NOT folded into
    // isLockContention — that variable also picks the rethrow message below,
    // and this message already classifies correctly downstream (LOCK_CONTENTION
    // via payment-error-classification.ts), so changing it would misroute it
    // to AVAILABILITY instead.
    const isModeledLockRace =
      isLockContention ||
      (error instanceof Error && error.message.includes("already in progress"));
    const isConsulteeDoubleBook =
      error instanceof Error &&
      error.message.toLowerCase().includes("already have a session booked");
    // #1477 — the inner catch rethrows anything carrying a registered business
    // code, so every one of those refusals arrives here too and was re-reported
    // as a fault, undoing the `expected: true` it had just been given. Asking
    // the classifier the same question it will answer for the response keeps
    // the two verdicts from disagreeing.
    const isBusinessRefusal = isBusinessErrorCode(
      (error as { code?: unknown } | null)?.code,
    );
    // #1583 C-P1-04 — the same-key collision the inner catch let through.
    const isKeyCollision = isUniqueViolationOn(error, "clientIdempotencyKey");
    reportSentryError(error, {
      subsystem: "payments",
      expected:
        isModeledLockRace ||
        isConsulteeDoubleBook ||
        isBusinessRefusal ||
        isKeyCollision,
    });
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

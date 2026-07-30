/**
 * Approval Payment Operations
 *
 * Handles payment link generation for requests that are approved
 * without upfront payment (request-for-approval flow).
 *
 * Workflow:
 * 1. User submits consultation/subscription request (no payment)
 * 2. Consultant approves the request
 * 3. System generates payment link using this module
 * 4. User pays via the link
 * 5. Webhook confirms payment and finalizes appointment
 */

import prisma from "@/lib/prisma";
import { validatePlanCurrency } from "@/lib/payments/validation/currency-guards";
import { Currency, PaymentGateway, PaymentStatus } from "@prisma/client";
import { createPaymentIntent } from "../index";
import { acquireLock, releaseLock } from "@/lib/redis";

// ============================================================================
// Type Definitions
// ============================================================================

export interface CreateApprovalPaymentParams {
  userId: string;
  appointmentType: "CONSULTATION" | "SUBSCRIPTION" | "TRIAL";
  consultationId?: string;
  subscriptionId?: string;
  planId: string;
  /** Required when appointmentType is TRIAL. */
  trialId?: string;
  /**
   * Link the intent to an appointment that ALREADY exists. Trials create the
   * appointment when the consultant accepts (to hold the slot), so the webhook
   * should confirm it rather than build a new one. Consultations and
   * subscriptions leave this unset — their appointment is made on capture.
   */
  appointmentId?: string;
  paymentGateway: PaymentGateway;
  startsAt?: string;
  endsAt?: string;
  schedulingPeriodStartsAt?: string;
  schedulingPeriodEndsAt?: string;
  notes?: string;
}

export interface ApprovalPaymentResult {
  paymentIntentId: string;
  checkoutUrl: string;
  amount: number;
  currency: Currency;
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Generate payment link for approved consultation/subscription
 * Used in request-for-approval flow after consultant approval
 *
 * @param params - Payment parameters including user, appointment type, and plan details
 * @returns Payment intent ID and checkout URL for user to complete payment
 */
/**
 * H3 FIX: Uses a distributed lock keyed on the resource being paid for
 * (consultationId or subscriptionId) to prevent duplicate payment link
 * generation from concurrent API calls.
 */
const APPROVAL_PAYMENT_LOCK_TTL = 30_000; // 30 seconds

export async function createApprovalPaymentIntent(
  params: CreateApprovalPaymentParams,
): Promise<ApprovalPaymentResult> {
  // Validate params
  if (params.appointmentType === "CONSULTATION" && !params.consultationId) {
    throw new Error(
      "consultationId required for CONSULTATION appointment type",
    );
  }
  if (params.appointmentType === "SUBSCRIPTION" && !params.subscriptionId) {
    throw new Error(
      "subscriptionId required for SUBSCRIPTION appointment type",
    );
  }
  if (params.appointmentType === "TRIAL" && !params.trialId) {
    throw new Error("trialId required for TRIAL appointment type");
  }

  // H3 FIX: Acquire distributed lock keyed on the resource
  const resourceId =
    params.consultationId || params.subscriptionId || params.trialId;
  const lockKey = `lock:approval_payment:${resourceId}`;
  const lockToken = await acquireLock(lockKey, APPROVAL_PAYMENT_LOCK_TTL);

  if (!lockToken) {
    throw new Error(
      "Payment link generation is already in progress for this request. Please wait.",
    );
  }

  try {
    // FIX Issue #7: Check for existing payment to prevent duplicates
    const hasExistingPayment = await checkExistingPayment({
      consultationId: params.consultationId,
      subscriptionId: params.subscriptionId,
      trialId: params.trialId,
    });

    if (hasExistingPayment) {
      throw new Error(
        "A payment link has already been generated for this request",
      );
    }

    // BUG-D: Validate user has consultee profile (required for webhook to succeed)
    const user = await prisma.user.findUnique({
      where: { id: params.userId },
      include: { consulteeProfile: true },
    });

    if (!user) {
      throw new Error("User not found");
    }

    if (!user.consulteeProfile) {
      throw new Error(
        "User does not have a consultee profile. Please complete profile setup first.",
      );
    }

    // Get plan and calculate amount
    const { amount, currency, plan } = await calculateAmount(params);

    // Build metadata for webhook processing
    const metadata = buildApprovalMetadata(params);

    // Create payment intent with gateway
    const paymentResponse = await createPaymentIntent({
      amount,
      currency,
      metadata,
      paymentGateway: params.paymentGateway,
      isMockPayment: false,
    });

    // Store payment record in database
    await prisma.payment.create({
      data: {
        amount,
        originalAmount: amount, // No discounts/credits in approval flow
        currency,
        description: `Payment for ${params.appointmentType.toLowerCase()} - ${plan.title}`,
        paymentMethod: "card",
        paymentIntent: paymentResponse.id,
        paymentGateway: params.paymentGateway,
        paymentStatus: PaymentStatus.PENDING,
        userId: params.userId,
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48 hours expiration
        isMockPayment: false,
        // Null for consultations/subscriptions, whose appointment is created
        // on capture; trials pass the appointment they already hold.
        appointmentId: params.appointmentId ?? null,
      },
    });

    return {
      paymentIntentId: paymentResponse.id,
      checkoutUrl: paymentResponse.client_secret,
      amount,
      currency,
    };
  } finally {
    await releaseLock(lockKey, lockToken);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate payment amount from plan
 */
async function calculateAmount(params: CreateApprovalPaymentParams): Promise<{
  amount: number;
  currency: Currency;
  plan: { title: string };
}> {
  if (params.appointmentType === "TRIAL") {
    // A trial is priced by its parent subscription plan's trialPriceInPaise,
    // NOT the plan price — the trial is a taster of that plan, not the plan.
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: params.planId },
      select: {
        title: true,
        trialPriceInPaise: true,
        trialEnabled: true,
        priceCurrency: true,
      },
    });

    if (!plan) {
      throw new Error("Subscription plan not found");
    }
    if (!plan.trialEnabled) {
      throw new Error("This plan does not offer trials");
    }
    if (plan.trialPriceInPaise <= 0) {
      // Free trials never reach a payment intent — the accept path schedules
      // them directly. Reaching here means the caller mis-routed.
      throw new Error("Cannot create a payment intent for a free trial");
    }

    const currency = plan.priceCurrency;
    validatePlanCurrency(currency); // see the note on the CONSULTATION branch

    return {
      amount: Number(plan.trialPriceInPaise),
      currency,
      plan: { title: `${plan.title} — trial` },
    };
  }

  if (params.appointmentType === "CONSULTATION") {
    const plan = await prisma.consultationPlan.findUnique({
      where: { id: params.planId },
      select: {
        title: true,
        price: true,
        priceCurrency: true,
      },
    });

    if (!plan) {
      throw new Error("Consultation plan not found");
    }

    // #781 §A — priceCurrency is the non-null Currency enum; no gateway fallback.
    const currency = plan.priceCurrency;
    // The direct-checkout path has always called this; this path never did, and
    // it is the one that charges through Stripe in the plan's own currency. A
    // GBP-priced plan booked via request→approve therefore took a real GBP
    // charge, wrote Payment.currency="GBP" with an amount in pence, and every
    // stage below then treated that number as INR paise: the earnings row is
    // hardcoded "INR", the journal posts it into an INR account, and the payout
    // is sized off it. Nothing downstream compares an amount against its own
    // currency, so it balances cleanly and reconciles clean while being wrong
    // by the GBP:INR rate — with the shortfall landing on the consultant.
    validatePlanCurrency(currency);

    return {
      amount: plan.price,
      currency,
      plan: { title: plan.title },
    };
  } else {
    // SUBSCRIPTION
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: params.planId },
      select: {
        title: true,
        price: true,
        priceCurrency: true,
      },
    });

    if (!plan) {
      throw new Error("Subscription plan not found");
    }

    // #781 §A — priceCurrency is the non-null Currency enum; no gateway fallback.
    const currency = plan.priceCurrency;
    validatePlanCurrency(currency); // see the note on the CONSULTATION branch

    return {
      amount: plan.price,
      currency,
      plan: { title: plan.title },
    };
  }
}

/**
 * Build metadata for webhook processing
 * This metadata will be passed to handlePaymentSuccess() when payment completes
 */
function buildApprovalMetadata(params: CreateApprovalPaymentParams): {
  appointmentId: string;
  appointmentType: string;
  [key: string]: string;
} {
  const metadata: Record<string, string> = {
    // Trials pass a real id (their appointment exists before the intent);
    // everything else links after capture.
    appointmentId: params.appointmentId ?? "pending",
    appointmentType: params.appointmentType,
    userId: params.userId,
    planId: params.planId,
    notes: params.notes || "",
    isApprovalFlow: "true", // Flag to indicate this is from approval flow
  };

  // Add consultation-specific fields
  if (params.consultationId) {
    metadata.consultationId = params.consultationId;
  }

  // Add subscription-specific fields
  if (params.subscriptionId) {
    metadata.subscriptionId = params.subscriptionId;
  }

  // Add trial-specific fields — the webhook resolves the TrialSession from this.
  if (params.trialId) {
    metadata.trialId = params.trialId;
  }

  // Add slot times if provided
  if (params.startsAt && params.endsAt) {
    metadata.startsAt = params.startsAt;
    metadata.endsAt = params.endsAt;
  }

  // Add scheduling period if provided
  if (params.schedulingPeriodStartsAt && params.schedulingPeriodEndsAt) {
    metadata.schedulingPeriodStartsAt = params.schedulingPeriodStartsAt;
    metadata.schedulingPeriodEndsAt = params.schedulingPeriodEndsAt;
  }

  return metadata as {
    appointmentId: string;
    appointmentType: string;
    [key: string]: string;
  };
}

/**
 * Check if payment already exists for consultation/subscription
 * Prevents duplicate payment generation
 */
export async function checkExistingPayment(params: {
  consultationId?: string;
  subscriptionId?: string;
  trialId?: string;
}): Promise<boolean> {
  if (params.trialId) {
    // A trial owns its Payment directly (TrialSession.paymentId), so unlike the
    // consultation/subscription arms there is no appointment to walk through —
    // the appointment doesn't exist until the trial is paid and scheduled.
    const trial = await prisma.trialSession.findUnique({
      where: { id: params.trialId },
      select: { payment: { select: { paymentStatus: true } } },
    });

    const status = trial?.payment?.paymentStatus;
    return (
      status === PaymentStatus.SUCCEEDED || status === PaymentStatus.PENDING
    );
  }

  if (params.consultationId) {
    const consultation = await prisma.consultation.findUnique({
      where: { id: params.consultationId },
      include: {
        appointment: {
          include: {
            payment: true,
          },
        },
      },
    });

    // Check if payment exists and is not expired
    const payment = consultation?.appointment?.payment?.find(
      (p) =>
        p.paymentStatus === PaymentStatus.SUCCEEDED ||
        p.paymentStatus === PaymentStatus.PENDING,
    );

    return !!payment;
  }

  if (params.subscriptionId) {
    const subscription = await prisma.subscription.findUnique({
      where: { id: params.subscriptionId },
      include: {
        appointments: {
          include: {
            payment: true,
          },
        },
      },
    });

    // Check any appointment for payment
    const hasPayment = subscription?.appointments.some((apt) =>
      apt.payment?.some(
        (p) =>
          p.paymentStatus === PaymentStatus.SUCCEEDED ||
          p.paymentStatus === PaymentStatus.PENDING,
      ),
    );

    return !!hasPayment;
  }

  return false;
}

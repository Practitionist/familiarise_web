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
   * Link the intent to the appointment that ALREADY exists. Every approval
   * arm creates it before minting — trials hold their slot when the
   * consultant accepts, consultations/subscriptions create it at request
   * time (#1181) — so the webhook confirms THAT appointment instead of
   * building a twin (Consultation.appointment is one-to-one; a capture-time
   * creation either collides on the unique or strands the request-time row),
   * and the duplicate-payment guard can see approval payments at all.
   */
  appointmentId?: string;
  /**
   * #1166 ORG-9 — org sponsorship used to be silently DROPPED by the approval
   * flow (no organizationId anywhere in the chain, so an org member's approved
   * request billed their personal card with no attribution). Callers pass the
   * appointment's organizationId; it rides the Payment row and the gateway
   * metadata. Wallet-debit/skip-gateway parity with checkout is tracked in
   * #1166.
   */
  organizationId?: string;
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
    // FIX Issue #7 / #1181 — duplicate-payment guard, now live for every
    // approval arm: the walk below reads the payments hanging off the
    // request's own appointment(s), which only match once the mint threads
    // appointmentId through (see CreateApprovalPaymentParams).
    const existingPayment = await findExistingLivePayment({
      consultationId: params.consultationId,
      subscriptionId: params.subscriptionId,
      trialId: params.trialId,
    });

    if (existingPayment) {
      if (existingPayment.paymentStatus === PaymentStatus.SUCCEEDED) {
        throw new Error("This request has already been paid");
      }

      // #1181 — a PENDING payment from a previous mint attempt is reused,
      // not duplicated. Before the appointment back-link existed this state
      // was invisible (the retry minted a parallel gateway order); now it
      // resolves the #1172 deadlock shape where the link was minted but its
      // persist never landed and re-approval must recover it. The pay-link
      // reconstructs from the stored intent because Razorpay's client_secret
      // IS the order id (#1165 pins approval mints to RAZORPAY).
      return {
        paymentIntentId: existingPayment.paymentIntent,
        checkoutUrl: existingPayment.paymentIntent,
        amount: existingPayment.amount,
        currency: existingPayment.currency,
      };
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
        organizationId: params.organizationId ?? null,
        userId: params.userId,
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48 hours expiration
        isMockPayment: false,
        // #1181 — the request-time appointment anchors capture to the NEW
        // flow (confirm the existing row, never create a twin). Null only
        // when the caller genuinely had no appointment to offer.
        appointmentId: params.appointmentId ?? null,
        // Every Payment must carry at least one PaymentLeg
        // (docs/enterprise/10-money-and-ledger/09-payment-legs.md); checkout
        // writes it at creation so the invariant holds before capture, and
        // this flow was the one gateway path that never did. Always CARD: the
        // approval flow charges the buyer even when an org is tagged (the
        // wallet-debit/skip-gateway parity is #1166). Nested so a Payment can
        // never exist legless.
        legs: {
          create: {
            source: "CARD",
            amountPaise: amount,
            sourceRef: paymentResponse.id,
          },
        },
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
    // Same shape as direct checkout (buildPaymentMetadata): the real anchor
    // lives on the Payment row, which is what the capture handler branches
    // on; the sentinel here only feeds the legacy-create path when there is
    // genuinely no appointment yet.
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

  // #1166 ORG-9 — org attribution survives into the gateway round-trip so the
  // capture side can verify it against the Payment row.
  if (params.organizationId) {
    metadata.organizationId = params.organizationId;
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
 * Find the live payment already attached to this request's appointment(s).
 * Returns null when nothing has been minted (or only EXPIRED/FAILED rows
 * remain, which a fresh mint may supersede). This is the duplicate-payment
 * guard's lookup — it can only ever match once callers thread appointmentId,
 * because it walks payments hanging off the appointment (#1181).
 */
export async function findExistingLivePayment(params: {
  consultationId?: string;
  subscriptionId?: string;
  trialId?: string;
}): Promise<{
  paymentStatus: PaymentStatus;
  paymentIntent: string;
  amount: number;
  currency: Currency;
} | null> {
  if (params.trialId) {
    // A trial owns its Payment directly (TrialSession.paymentId), so unlike the
    // consultation/subscription arms there is no appointment to walk through —
    // the appointment doesn't exist until the trial is paid and scheduled.
    const trial = await prisma.trialSession.findUnique({
      where: { id: params.trialId },
      select: {
        payment: {
          select: {
            paymentStatus: true,
            paymentIntent: true,
            amount: true,
            currency: true,
          },
        },
      },
    });

    return trial?.payment ?? null;
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

    if (!payment) return null;
    return {
      paymentStatus: payment.paymentStatus,
      paymentIntent: payment.paymentIntent,
      amount: payment.amount,
      currency: payment.currency,
    };
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
    for (const apt of subscription?.appointments ?? []) {
      const payment = apt.payment?.find(
        (p) =>
          p.paymentStatus === PaymentStatus.SUCCEEDED ||
          p.paymentStatus === PaymentStatus.PENDING,
      );
      if (payment) {
        return {
          paymentStatus: payment.paymentStatus,
          paymentIntent: payment.paymentIntent,
          amount: payment.amount,
          currency: payment.currency,
        };
      }
    }

    return null;
  }

  return null;
}

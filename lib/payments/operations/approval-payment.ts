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
import { AppointmentsType, PaymentGateway, PaymentStatus } from "@prisma/client";
import { createPaymentIntent } from "../index";

// ============================================================================
// Type Definitions
// ============================================================================

export interface CreateApprovalPaymentParams {
  userId: string;
  appointmentType: "CONSULTATION" | "SUBSCRIPTION";
  consultationId?: string;
  subscriptionId?: string;
  planId: string;
  paymentGateway: PaymentGateway;
  slotStartTimeInUTC?: string;
  slotEndTimeInUTC?: string;
  schedulingPeriodStartsAt?: string;
  schedulingPeriodEndsAt?: string;
  notes?: string;
}

export interface ApprovalPaymentResult {
  paymentIntentId: string;
  checkoutUrl: string;
  amount: number;
  currency: string;
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
export async function createApprovalPaymentIntent(
  params: CreateApprovalPaymentParams,
): Promise<ApprovalPaymentResult> {
  // Validate params
  if (params.appointmentType === "CONSULTATION" && !params.consultationId) {
    throw new Error("consultationId required for CONSULTATION appointment type");
  }
  if (params.appointmentType === "SUBSCRIPTION" && !params.subscriptionId) {
    throw new Error("subscriptionId required for SUBSCRIPTION appointment type");
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
      currency,
      description: `Payment for ${params.appointmentType.toLowerCase()} - ${plan.title}`,
      paymentMethod: "card",
      paymentIntent: paymentResponse.id,
      paymentGateway: params.paymentGateway,
      paymentStatus: PaymentStatus.PENDING,
      userId: params.userId,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48 hours expiration
      isMockPayment: false,
    },
  });

  return {
    paymentIntentId: paymentResponse.id,
    checkoutUrl: paymentResponse.client_secret, // This is the checkout URL/session URL
    amount,
    currency,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate payment amount from plan
 */
async function calculateAmount(params: CreateApprovalPaymentParams): Promise<{
  amount: number;
  currency: string;
  plan: { title: string };
}> {
  if (params.appointmentType === "CONSULTATION") {
    const plan = await prisma.consultationPlan.findUnique({
      where: { id: params.planId },
    });

    if (!plan) {
      throw new Error("Consultation plan not found");
    }

    // Currency based on gateway (Razorpay = INR, Stripe = USD)
    const currency = params.paymentGateway === PaymentGateway.RAZORPAY ? "INR" : "USD";

    return {
      amount: plan.price,
      currency,
      plan: { title: plan.title },
    };
  } else {
    // SUBSCRIPTION
    const plan = await prisma.subscriptionPlan.findUnique({
      where: { id: params.planId },
    });

    if (!plan) {
      throw new Error("Subscription plan not found");
    }

    const currency = params.paymentGateway === PaymentGateway.RAZORPAY ? "INR" : "USD";

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
function buildApprovalMetadata(
  params: CreateApprovalPaymentParams,
): { appointmentId: string; appointmentType: string; [key: string]: string } {
  const metadata: Record<string, string> = {
    appointmentId: "pending", // Will be linked after payment success
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

  // Add slot times if provided
  if (params.slotStartTimeInUTC && params.slotEndTimeInUTC) {
    metadata.slotStartTimeInUTC = params.slotStartTimeInUTC;
    metadata.slotEndTimeInUTC = params.slotEndTimeInUTC;
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
}): Promise<boolean> {
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
      (p) => p.paymentStatus === PaymentStatus.SUCCEEDED || p.paymentStatus === PaymentStatus.PENDING,
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
        (p) => p.paymentStatus === PaymentStatus.SUCCEEDED || p.paymentStatus === PaymentStatus.PENDING,
      ),
    );

    return !!hasPayment;
  }

  return false;
}

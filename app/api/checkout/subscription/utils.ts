import { PrismaClient, Prisma } from "@prisma/client";
import {
  SubscriptionCheckoutInput,
  SubscriptionPlanWithDetails,
} from "./schema";

export async function validateAndGetPlan(
  tx: Prisma.TransactionClient,
  subscriptionPlanId: string,
): Promise<SubscriptionPlanWithDetails> {
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: subscriptionPlanId },
    include: {
      consultantProfile: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      },
    },
  });

  if (!plan) {
    throw new Error("Subscription plan not found");
  }

  return plan;
}

export async function calculateFinalAmount(
  tx: Prisma.TransactionClient,
  baseAmount: number,
  discountCode?: string,
): Promise<{ amount: number; discountCodeId: string | null }> {
  let amount = baseAmount;
  let discountCodeId = null;

  if (discountCode) {
    const discount = await tx.discountCode.findUnique({
      where: { code: discountCode },
    });
    if (discount) {
      discountCodeId = discount.id;
      amount =
        discount.discountType === "PERCENTAGE"
          ? amount * (1 - discount.discountValue / 100)
          : amount - discount.discountValue;
    }
  }

  return { amount, discountCodeId };
}

export async function createSubscriptionAppointment(
  tx: Prisma.TransactionClient,
  {
    subscriptionPlanId,
    userId,
  }: {
    subscriptionPlanId: string;
    userId: string;
  },
) {
  // Create subscription and initial appointment
  const subscription = await tx.subscription.create({
    data: {
      subscriptionPlanId,
      requestStatus: "PENDING",
      requestedById: userId,
      startDate: new Date(),
      endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      appointments: {
        create: {
          appointmentType: "SUBSCRIPTION",
        },
      },
    },
    include: {
      appointments: true,
    },
  });

  if (!subscription.appointments?.[0]) {
    throw new Error("Failed to create appointment");
  }

  return {
    id: subscription.id,
    appointment: {
      id: subscription.appointments[0].id,
    },
  };
}

export async function createPaymentRecord(
  tx: Prisma.TransactionClient,
  {
    amount,
    currency,
    paymentGateway,
    userId,
    appointmentId,
    discountCodeId,
    initialPaymentIntent = "",
  }: {
    amount: number;
    currency: string;
    paymentGateway: "STRIPE" | "RAZORPAY" | "LEMON_SQUEEZY" | "XFLOW";
    userId: string;
    appointmentId: string;
    discountCodeId: string | null;
    initialPaymentIntent?: string;
  },
) {
  return tx.payment.create({
    data: {
      amount,
      currency,
      paymentMethod: "CARD",
      paymentIntent: initialPaymentIntent,
      paymentGateway,
      paymentStatus: "PENDING",
      userId,
      appointmentId,
      discountCodeId,
    },
  });
}

export async function updatePaymentIntent(
  tx: Prisma.TransactionClient,
  paymentId: string,
  paymentIntent: string,
) {
  return tx.payment.update({
    where: { id: paymentId },
    data: { paymentIntent },
  });
}

export async function validateSubscriptionEligibility(
  tx: Prisma.TransactionClient,
  userId: string,
  subscriptionPlanId: string,
): Promise<void> {
  // Check if user already has an active subscription
  const activeSubscription = await tx.subscription.findFirst({
    where: {
      requestedById: userId,
      subscriptionPlanId,
      requestStatus: {
        in: ["PENDING", "APPROVED"],
      },
    },
  });

  if (activeSubscription) {
    throw new Error(
      activeSubscription.requestStatus === "PENDING"
        ? "You already have a pending subscription"
        : "You already have an active subscription",
    );
  }
}

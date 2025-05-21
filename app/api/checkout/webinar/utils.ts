import { Prisma } from "@prisma/client";
import { WebinarPlanWithDetails } from "./schema";

export async function validateAndGetPlan(
  tx: Prisma.TransactionClient,
  webinarPlanId: string,
): Promise<WebinarPlanWithDetails> {
  const plan = await tx.webinarPlan.findUnique({
    where: { id: webinarPlanId },
    include: {
      topics: true,
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
    throw new Error("Webinar plan not found");
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

export async function createWebinarAppointment(
  tx: Prisma.TransactionClient,
  {
    webinarPlanId,
    userId,
  }: {
    webinarPlanId: string;
    userId: string;
  },
) {
  // Create webinar with initial appointment
  const webinar = await tx.webinar.create({
    data: {
      status: "SCHEDULED",
      webinarPlanId,
      appointment: {
        create: {
          appointmentType: "WEBINAR",
        },
      },
      // Add user to waitlist
      waitlist: {
        create: {
          user: {
            connect: { id: userId },
          },
        },
      },
    },
    include: {
      appointment: true,
    },
  });

  if (!webinar.appointment) {
    throw new Error("Failed to create appointment");
  }

  return {
    id: webinar.id,
    appointment: {
      id: webinar.appointment.id,
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

export async function validateWebinarEligibility(
  tx: Prisma.TransactionClient,
  userId: string,
  webinarPlanId: string,
): Promise<void> {
  // Get webinar plan to check max participants
  const webinarPlan = await tx.webinarPlan.findUnique({
    where: { id: webinarPlanId },
    include: {
      webinars: {
        include: {
          waitlist: true,
        },
      },
    },
  });

  if (!webinarPlan) {
    throw new Error("Webinar plan not found");
  }

  // Check if user is already registered
  const existingRegistration = await tx.waitlist.findFirst({
    where: {
      userId,
      webinar: {
        webinarPlanId,
      },
    },
  });

  if (existingRegistration) {
    throw new Error("You are already registered for this webinar");
  }

  // Check if webinar is full
  const activeWebinar = webinarPlan.webinars.find(
    (w) => w.status === "SCHEDULED" || w.status === "IN_PROGRESS",
  );

  if (
    activeWebinar &&
    activeWebinar.waitlist.length >= webinarPlan.maxParticipants
  ) {
    throw new Error("This webinar is already full");
  }
}

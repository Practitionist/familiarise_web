import { PrismaClient, Prisma } from "@prisma/client";
import { ClassCheckoutInput, ClassPlanWithDetails } from "./schema";

export async function validateAndGetPlan(
  tx: Prisma.TransactionClient,
  classPlanId: string
): Promise<ClassPlanWithDetails> {
  const plan = await tx.classPlan.findUnique({
    where: { id: classPlanId },
    include: {
      topics: true,
      classContents: {
        orderBy: {
          order: "asc",
        },
      },
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
    throw new Error("Class plan not found");
  }

  return plan;
}

export async function calculateFinalAmount(
  tx: Prisma.TransactionClient,
  baseAmount: number,
  discountCode?: string
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

export async function createClassAppointment(
  tx: Prisma.TransactionClient,
  {
    classPlanId,
    userId,
  }: {
    classPlanId: string;
    userId: string;
  }
) {
  // Get class plan to calculate end date
  const classPlan = await tx.classPlan.findUnique({
    where: { id: classPlanId },
  });

  if (!classPlan) {
    throw new Error("Class plan not found");
  }

  const startDate = new Date();
  const endDate = new Date(
    startDate.getTime() + classPlan.durationInMonths * 30 * 24 * 60 * 60 * 1000
  );

  // Create class with initial appointment
  const classEntity = await tx.class.create({
    data: {
      startDate,
      endDate,
      status: "SCHEDULED",
      classPlanId,
      appointments: {
        create: {
          appointmentType: "CLASS",
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
      appointments: true,
    },
  });

  if (!classEntity.appointments?.[0]) {
    throw new Error("Failed to create appointment");
  }

  return {
    id: classEntity.id,
    appointment: {
      id: classEntity.appointments[0].id,
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
  }
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
  paymentIntent: string
) {
  return tx.payment.update({
    where: { id: paymentId },
    data: { paymentIntent },
  });
}

export async function validateClassEligibility(
  tx: Prisma.TransactionClient,
  userId: string,
  classPlanId: string
): Promise<void> {
  // Get class plan to check max participants
  const classPlan = await tx.classPlan.findUnique({
    where: { id: classPlanId },
    include: {
      classes: {
        include: {
          waitlist: true,
        },
      },
    },
  });

  if (!classPlan) {
    throw new Error("Class plan not found");
  }

  // Check if user is already registered
  const existingRegistration = await tx.waitlist.findFirst({
    where: {
      userId,
      class: {
        classPlanId,
      },
    },
  });

  if (existingRegistration) {
    throw new Error("You are already registered for this class");
  }

  // Check if class is full
  const activeClass = classPlan.classes.find(
    (c) => c.status === "SCHEDULED" || c.status === "IN_PROGRESS"
  );

  if (activeClass && activeClass.waitlist.length >= classPlan.maxParticipants) {
    throw new Error("This class is already full");
  }
}

export function getClassFeatures(plan: ClassPlanWithDetails): string[] {
  const features = [
    `${plan.durationInMonths} month duration`,
    `${plan.callsPerWeek} calls per week`,
    `${plan.videoMeetings} video meetings`,
    `${plan.emailSupport} email support`,
  ];

  if (plan.certificateProvided) {
    features.push("Certificate provided upon completion");
  }

  if (plan.topics.length > 0) {
    features.push(`Topics: ${plan.topics.map((t) => t.name).join(", ")}`);
  }

  if (plan.classContents.length > 0) {
    features.push(`${plan.classContents.length} learning modules`);
  }

  return features;
}

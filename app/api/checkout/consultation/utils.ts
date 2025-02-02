import { PrismaClient, Prisma } from "@prisma/client";
import {
  ConsultationCheckoutInput,
  ConsultationPlanWithDetails,
} from "./schema";

export async function validateAndGetPlan(
  tx: Prisma.TransactionClient,
  consultationPlanId: string,
): Promise<ConsultationPlanWithDetails> {
  const plan = await tx.consultationPlan.findUnique({
    where: { id: consultationPlanId },
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
    throw new Error("Consultation plan not found");
  }

  return plan;
}

export async function validateSlotAvailability(
  tx: Prisma.TransactionClient,
  data: ConsultationCheckoutInput,
): Promise<void> {
  // Check if slot exists
  const slotData = data.slotOfAvailabilityWeeklyId
    ? await tx.slotOfAvailabilityWeekly.findUnique({
        where: { id: data.slotOfAvailabilityWeeklyId },
      })
    : await tx.slotOfAvailabilityCustom.findUnique({
        where: { id: data.slotOfAvailabilityCustomId },
      });

  if (!slotData) {
    throw new Error("Slot not found");
  }

  // Check if slot is already booked
  const existingBooking = await tx.slotOfAppointment.findFirst({
    where: {
      slotStartTimeInUTC: new Date(data.slotStartTimeInUTC),
      slotEndTimeInUTC: new Date(data.slotEndTimeInUTC),
      isTentative: false,
    },
  });

  if (existingBooking) {
    throw new Error("Slot already booked");
  }
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

interface ConsultationWithAppointment {
  id: string;
  appointment: {
    id: string;
  };
}

export async function createConsultationAppointment(
  tx: Prisma.TransactionClient,
  {
    consultationPlanId,
    userId,
    slotStartTimeInUTC,
    slotEndTimeInUTC,
  }: {
    consultationPlanId: string;
    userId: string;
    slotStartTimeInUTC: string;
    slotEndTimeInUTC: string;
  },
): Promise<ConsultationWithAppointment> {
  const consultation = await tx.consultation.create({
    data: {
      consultationPlanId,
      requestStatus: "PENDING",
      requestedById: userId,
      appointment: {
        create: {
          appointmentType: "CONSULTATION",
          slotsOfAppointment: {
            create: {
              slotStartTimeInUTC: new Date(slotStartTimeInUTC),
              slotEndTimeInUTC: new Date(slotEndTimeInUTC),
              isTentative: true,
              user: {
                connect: { id: userId },
              },
            },
          },
        },
      },
    },
    include: {
      appointment: true,
    },
  });

  if (!consultation.appointment) {
    throw new Error("Failed to create appointment");
  }

  return {
    id: consultation.id,
    appointment: {
      id: consultation.appointment.id,
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

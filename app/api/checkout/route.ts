import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "../auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { z } from "zod";
import { 
  AppointmentsType, 
  PaymentGateway, 
  PaymentStatus, 
  RequestStatus,
  WebinarStatus,
  ClassStatus 
} from "@prisma/client";
import { createPaymentIntent } from "@/lib/payment";

// Unified checkout schema
const unifiedCheckoutSchema = z.object({
  appointmentType: z.enum(["CONSULTATION", "SUBSCRIPTION", "WEBINAR", "CLASS"]),
  planId: z.string(),
  eventId: z.string().optional(), // For specific webinar/class instances
  slotStartTimeInUTC: z.string().datetime().optional(),
  slotEndTimeInUTC: z.string().datetime().optional(),
  slotOfAvailabilityWeeklyId: z.string().optional(),
  slotOfAvailabilityCustomId: z.string().optional(),
  discountCode: z.string().optional(),
  paymentGateway: z.enum(["STRIPE", "RAZORPAY", "LEMON_SQUEEZY", "XFLOW"]),
  notes: z.string().optional(),
}).refine((data) => {
  // For consultation and subscription, require slot timing
  if (["CONSULTATION", "SUBSCRIPTION"].includes(data.appointmentType)) {
    return data.slotStartTimeInUTC && data.slotEndTimeInUTC;
  }
  return true;
}, {
  message: "Consultation and subscription require slot timing"
}).refine((data) => {
  // For webinar and class, require eventId
  if (["WEBINAR", "CLASS"].includes(data.appointmentType)) {
    return data.eventId;
  }
  return true;
}, {
  message: "Webinar and class require eventId"
});

type CheckoutInput = z.infer<typeof unifiedCheckoutSchema>;

export async function POST(req: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Validate request body
    const body = await req.json();
    const validatedData = unifiedCheckoutSchema.parse(body);

    // Check if payment should be skipped (for development/testing)
    const skipPayment = process.env.SKIP_PAYMENT === "true";

    // Start transaction with proper rollback handling
    return await prisma.$transaction(async (tx) => {
      let appointment;
      let plan;
      let amount = 0;

      // Get user profile based on appointment type
      const user = await tx.user.findUnique({
        where: { id: session.user.id },
        include: {
          consulteeProfile: true,
        },
      });

      if (!user?.consulteeProfile) {
        throw new Error("User profile not found");
      }

      // Handle different appointment types
      switch (validatedData.appointmentType) {
        case "CONSULTATION":
          ({ appointment, plan, amount } = await handleConsultationCheckout(
            tx, validatedData, user.consulteeProfile.id, skipPayment
          ));
          break;

        case "SUBSCRIPTION":
          ({ appointment, plan, amount } = await handleSubscriptionCheckout(
            tx, validatedData, user.consulteeProfile.id, skipPayment
          ));
          break;

        case "WEBINAR":
          ({ appointment, plan, amount } = await handleWebinarCheckout(
            tx, validatedData, user.id, skipPayment
          ));
          break;

        case "CLASS":
          ({ appointment, plan, amount } = await handleClassCheckout(
            tx, validatedData, user.id, skipPayment
          ));
          break;

        default:
          throw new Error("Invalid appointment type");
      }

      // Apply discount if provided
      let discountCodeId = null;
      if (validatedData.discountCode) {
        const discount = await tx.discountCode.findUnique({
          where: { code: validatedData.discountCode },
        });
        
        if (discount) {
          discountCodeId = discount.id;
          amount = discount.discountType === "PERCENTAGE"
            ? amount * (1 - discount.discountValue / 100)
            : Math.max(0, amount - discount.discountValue);
        }
      }

      // Handle payment processing
      if (skipPayment) {
        // Create successful payment record for skipped payment
        await tx.payment.create({
          data: {
            amount,
            currency: validatedData.paymentGateway === "RAZORPAY" ? "INR" : "USD",
            paymentMethod: "SKIPPED",
            paymentIntent: `skip_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            paymentGateway: validatedData.paymentGateway,
            paymentStatus: PaymentStatus.SUCCEEDED,
            userId: session.user.id,
            appointmentId: appointment.id,
            discountCodeId,
          },
        });

        // Immediately confirm the appointment
        await confirmAppointment(tx, appointment.id, validatedData.appointmentType);

        return NextResponse.json({
          success: true,
          message: "Appointment booked successfully (payment skipped)",
          appointmentId: appointment.id,
          skipPayment: true,
        });
      } else {
        // Create payment intent/order based on gateway
        let paymentResponse;
        
        paymentResponse = await createPaymentIntent({
          amount,
          currency: validatedData.paymentGateway === "RAZORPAY" ? "INR" : "USD",
          metadata: {
            appointmentId: appointment.id,
            userId: session.user.id,
            appointmentType: validatedData.appointmentType,
          },
          paymentGateway: validatedData.paymentGateway,
        });

        // Create payment record
        await tx.payment.create({
          data: {
            amount,
            currency: validatedData.paymentGateway === "RAZORPAY" ? "INR" : "USD",
            paymentMethod: "CARD",
            paymentIntent: paymentResponse.id,
            paymentGateway: validatedData.paymentGateway,
            paymentStatus: PaymentStatus.PENDING,
            userId: session.user.id,
            appointmentId: appointment.id,
            discountCodeId,
          },
        });

        return NextResponse.json({
          success: true,
          paymentIntent: paymentResponse,
          appointmentId: appointment.id,
          amount,
          currency: validatedData.paymentGateway === "RAZORPAY" ? "INR" : "USD",
        });
      }
    });
  } catch (error) {
    console.error("Checkout error:", error);
    
    // Provide specific error messages for different types of failures
    let errorMessage = "Checkout failed";
    let errorType = "UNKNOWN_ERROR";
    
    if (error instanceof Error) {
      // Payment gateway authentication errors
      if (error.message.includes("Authentication failed") || error.message.includes("Invalid API key")) {
        errorMessage = "Payment gateway configuration error. Please contact support.";
        errorType = "PAYMENT_CONFIG_ERROR";
      }
      // Prisma/Database errors
      else if (error.message.includes("Prisma") || error.message.includes("database")) {
        errorMessage = "Database error. Please try again or contact support.";
        errorType = "DATABASE_ERROR";
      }
      // Validation errors
      else if (error.message.includes("not found")) {
        errorMessage = error.message;
        errorType = "NOT_FOUND_ERROR";
      }
      // Slot availability errors
      else if (error.message.includes("slot") || error.message.includes("availability")) {
        errorMessage = error.message;
        errorType = "AVAILABILITY_ERROR";
      }
      // Payment intent creation errors
      else if (error.message.includes("Failed to create payment intent")) {
        errorMessage = "Payment processing unavailable. Please try again later or contact support.";
        errorType = "PAYMENT_PROCESSING_ERROR";
      }
      else {
        errorMessage = error.message;
      }
    }
    
    return NextResponse.json({
      error: errorMessage,
      errorType,
      timestamp: new Date().toISOString(),
    }, { status: 400 });
  }
}

// Helper functions for different appointment types
async function handleConsultationCheckout(
  tx: any, 
  data: CheckoutInput, 
  consulteeProfileId: string,
  skipPayment: boolean
) {
  const plan = await tx.consultationPlan.findUnique({
    where: { id: data.planId },
    include: {
      consultantProfile: {
        include: {
          user: true,
        },
      },
    },
  });

  if (!plan) {
    throw new Error("Consultation plan not found");
  }

  // Check slot availability
  await validateSlotAvailability(tx, data);

  // Create consultation
  const consultation = await tx.consultation.create({
    data: {
      consultationPlanId: plan.id,
      requestStatus: skipPayment ? RequestStatus.APPROVED : RequestStatus.PENDING,
      requestedById: consulteeProfileId,
      requestNotes: data.notes,
      directlyBooked: true,
    },
  });

  // Create appointment
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.CONSULTATION,
      consultationId: consultation.id,
      slotsOfAppointment: {
        create: {
          slotStartTimeInUTC: new Date(data.slotStartTimeInUTC!),
          slotEndTimeInUTC: new Date(data.slotEndTimeInUTC!),
          isTentative: !skipPayment,
        },
      },
    },
  });

  return { appointment, plan, amount: plan.price };
}

async function handleSubscriptionCheckout(
  tx: any, 
  data: CheckoutInput, 
  consulteeProfileId: string,
  skipPayment: boolean
) {
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: data.planId },
    include: {
      consultantProfile: {
        include: {
          user: true,
        },
      },
    },
  });

  if (!plan) {
    throw new Error("Subscription plan not found");
  }

  // Check slot availability
  await validateSlotAvailability(tx, data);

  // Calculate subscription end date
  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + plan.durationInMonths);

  // Create subscription
  const subscription = await tx.subscription.create({
    data: {
      subscriptionPlanId: plan.id,
      requestStatus: skipPayment ? RequestStatus.APPROVED : RequestStatus.PENDING,
      requestedById: consulteeProfileId,
      requestNotes: data.notes,
      startDate,
      endDate,
    },
  });

  // Create appointment
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.SUBSCRIPTION,
      subscriptionId: subscription.id,
      slotsOfAppointment: {
        create: {
          slotStartTimeInUTC: new Date(data.slotStartTimeInUTC!),
          slotEndTimeInUTC: new Date(data.slotEndTimeInUTC!),
          isTentative: !skipPayment,
        },
      },
    },
  });

  return { appointment, plan, amount: plan.price };
}

async function handleWebinarCheckout(
  tx: any, 
  data: CheckoutInput, 
  userId: string,
  skipPayment: boolean
) {
  const webinar = await tx.webinar.findUnique({
    where: { id: data.eventId },
    include: {
      webinarPlan: true,
      waitlist: true,
      appointment: {
        include: {
          slotsOfAppointment: true,
        },
      },
    },
  });

  if (!webinar) {
    throw new Error("Webinar not found");
  }

  const plan = webinar.webinarPlan;
  const currentParticipants = webinar.appointment?.slotsOfAppointment?.length || 0;

  // Check if max participants reached
  if (currentParticipants >= plan.maxParticipants) {
    if (skipPayment) {
      // Add to waitlist
      await tx.waitlist.create({
        data: {
          userId,
          webinarId: webinar.id,
        },
      });
      
      throw new Error("Webinar is full. Added to waitlist.");
    } else {
      throw new Error("Webinar is full");
    }
  }

  // Create appointment (reuse existing one or create new)
  let appointment = webinar.appointment;
  if (!appointment) {
    appointment = await tx.appointment.create({
      data: {
        appointmentType: AppointmentsType.WEBINAR,
        webinarId: webinar.id,
      },
    });
  }

  // Add user to webinar
  await tx.slotOfAppointment.create({
    data: {
      appointmentId: appointment.id,
      slotStartTimeInUTC: webinar.appointment?.slotsOfAppointment[0]?.slotStartTimeInUTC || new Date(),
      slotEndTimeInUTC: webinar.appointment?.slotsOfAppointment[0]?.slotEndTimeInUTC || new Date(),
      isTentative: !skipPayment,
      user: {
        connect: { id: userId },
      },
    },
  });

  return { appointment, plan, amount: plan.price };
}

async function handleClassCheckout(
  tx: any, 
  data: CheckoutInput, 
  userId: string,
  skipPayment: boolean
) {
  const classInstance = await tx.class.findUnique({
    where: { id: data.eventId },
    include: {
      classPlan: true,
      waitlist: true,
      appointments: {
        include: {
          slotsOfAppointment: true,
        },
      },
    },
  });

  if (!classInstance) {
    throw new Error("Class not found");
  }

  const plan = classInstance.classPlan;
  const currentParticipants = classInstance.appointments.reduce(
    (total: number, apt: any) => total + apt.slotsOfAppointment.length, 
    0
  );

  // Check if max participants reached
  if (currentParticipants >= plan.maxParticipants) {
    if (skipPayment) {
      // Add to waitlist
      await tx.waitlist.create({
        data: {
          userId,
          classId: classInstance.id,
        },
      });
      
      throw new Error("Class is full. Added to waitlist.");
    } else {
      throw new Error("Class is full");
    }
  }

  // Create appointment for class
  const appointment = await tx.appointment.create({
    data: {
      appointmentType: AppointmentsType.CLASS,
      classId: classInstance.id,
      slotsOfAppointment: {
        create: {
          slotStartTimeInUTC: classInstance.startDate || new Date(),
          slotEndTimeInUTC: classInstance.endDate || new Date(),
          isTentative: !skipPayment,
          user: {
            connect: { id: userId },
          },
        },
      },
    },
  });

  return { appointment, plan, amount: plan.price };
}

async function validateSlotAvailability(tx: any, data: CheckoutInput) {
  if (!data.slotStartTimeInUTC || !data.slotEndTimeInUTC) return;

  // Check for overlapping appointments
  const existingBooking = await tx.slotOfAppointment.findFirst({
    where: {
      AND: [
        {
          OR: [
            {
              AND: [
                { slotStartTimeInUTC: { lte: new Date(data.slotStartTimeInUTC) } },
                { slotEndTimeInUTC: { gt: new Date(data.slotStartTimeInUTC) } },
              ],
            },
            {
              AND: [
                { slotStartTimeInUTC: { lt: new Date(data.slotEndTimeInUTC) } },
                { slotEndTimeInUTC: { gte: new Date(data.slotEndTimeInUTC) } },
              ],
            },
          ],
        },
        { isTentative: false },
      ],
    },
  });

  if (existingBooking) {
    throw new Error("Time slot is already booked");
  }
}

async function confirmAppointment(tx: any, appointmentId: string, appointmentType: string) {
  // Make slot non-tentative
  await tx.slotOfAppointment.updateMany({
    where: { appointmentId },
    data: { isTentative: false },
  });

  // Update specific appointment type status
  const appointment = await tx.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: true,
      subscription: true,
      webinar: true,
      class: true,
    },
  });

  if (appointment?.consultation) {
    await tx.consultation.update({
      where: { id: appointment.consultation.id },
      data: { requestStatus: RequestStatus.APPROVED },
    });
  }

  if (appointment?.subscription) {
    await tx.subscription.update({
      where: { id: appointment.subscription.id },
      data: { requestStatus: RequestStatus.APPROVED },
    });
  }

  if (appointment?.webinar) {
    await tx.webinar.update({
      where: { id: appointment.webinar.id },
      data: { status: WebinarStatus.SCHEDULED },
    });
  }

  if (appointment?.class) {
    await tx.class.update({
      where: { id: appointment.class.id },
      data: { status: ClassStatus.SCHEDULED },
    });
  }
} 
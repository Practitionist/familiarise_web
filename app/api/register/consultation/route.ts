import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import authOptions from "../../auth/[...nextauth]/options";

// Error handling function
function handleError(error: unknown) {
  const message = error instanceof Error ? error.message : "Checkout failed";
  console.error("Checkout error:", message);
  return NextResponse.json({ error: message }, { status: 500 });
}

// Validate request body
const checkoutSchema = z
  .object({
    consultationPlanId: z.string(),
    slotOfAvailabilityWeeklyId: z.string().optional(),
    slotOfAvailabilityCustomId: z.string().optional(),
    slotStartTimeInUTC: z.string().datetime(),
    slotEndTimeInUTC: z.string().datetime(),
    discountCode: z.string().optional(),
    paymentGateway: z.enum(["STRIPE", "RAZORPAY", "LEMON_SQUEEZY", "XFLOW"]),
  })
  .refine(
    (data) =>
      (data.slotOfAvailabilityWeeklyId && !data.slotOfAvailabilityCustomId) ||
      (!data.slotOfAvailabilityWeeklyId && data.slotOfAvailabilityCustomId),
    {
      message:
        "Exactly one of slotOfAvailabilityWeeklyId or slotOfAvailabilityCustomId must be provided",
    },
  )
  .refine(
    (data) =>
      new Date(data.slotStartTimeInUTC) < new Date(data.slotEndTimeInUTC),
    {
      message: "Start time must be before end time",
    },
  );

export async function POST(req: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Validate request body
    const body = await req.json();
    const validatedData = checkoutSchema.parse(body);

    // Start transaction
    return await prisma.$transaction(async (tx) => {
      // 1. Get consultation plan details
      const plan = await tx.consultationPlan.findUnique({
        where: { id: validatedData.consultationPlanId },
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

      // 2. Get consultee profile
      const consultee = await tx.consulteeProfile.findUnique({
        where: { userId: session.user.id },
      });

      if (!consultee) {
        throw new Error("Consultee profile not found");
      }

      // 3. Create tentative slot reservation
      const slotData = validatedData.slotOfAvailabilityWeeklyId
        ? await tx.slotOfAvailabilityWeekly.findUnique({
            where: { id: validatedData.slotOfAvailabilityWeeklyId },
          })
        : await tx.slotOfAvailabilityCustom.findUnique({
            where: { id: validatedData.slotOfAvailabilityCustomId },
          });

      if (!slotData) {
        throw new Error("Slot not found");
      }

      // Check if slot is already booked
      const existingBooking = await tx.slotOfAppointment.findFirst({
        where: {
          slotStartTimeInUTC: new Date(validatedData.slotStartTimeInUTC),
          slotEndTimeInUTC: new Date(validatedData.slotEndTimeInUTC),
          isTentative: false,
        },
      });

      if (existingBooking) {
        throw new Error("Slot already booked");
      }

      // 4. Create consultation with appropriate status
      const consultation = await tx.consultation.create({
        data: {
          consultationPlanId: plan.id,
          requestStatus: process.env.NODE_ENV === "development" ? "APPROVED" : "PENDING",
          requestedById: consultee.id,
          appointment: {
            create: {
              appointmentType: "CONSULTATION",
              slotsOfAppointment: {
                create: {
                  slotStartTimeInUTC: new Date(validatedData.slotStartTimeInUTC),
                  slotEndTimeInUTC: new Date(validatedData.slotEndTimeInUTC),
                  isTentative: process.env.NODE_ENV !== "development",
                  user: {
                    connect: { id: session.user.id },
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

      // 5. Calculate final amount (including discounts if any)
      let amount = plan.price;
      let discountCodeId = null;

      if (validatedData.discountCode) {
        const discount = await tx.discountCode.findUnique({
          where: { code: validatedData.discountCode },
        });
        if (discount) {
          discountCodeId = discount.id;
          amount =
            discount.discountType === "PERCENTAGE"
              ? amount * (1 - discount.discountValue / 100)
              : amount - discount.discountValue;
        }
      }

      // 6. Create payment record
      const payment = await tx.payment.create({
        data: {
          amount,
          currency: validatedData.paymentGateway === "RAZORPAY" ? "INR" : "USD",
          paymentMethod: "CARD",
          paymentIntent: "", // Will be set by checkout route
          paymentGateway: validatedData.paymentGateway,
          paymentStatus: process.env.NODE_ENV === "development" ? "SUCCEEDED" : "PENDING",
          userId: session.user.id,
          appointmentId: consultation.appointment.id,
          discountCodeId,
        },
      });

      // 7. Return appropriate response based on environment
      if (process.env.NODE_ENV === "development") {
        return NextResponse.json({
          success: true,
          message: "Consultation booked successfully",
          consultationId: consultation.id,
          appointmentId: consultation.appointment.id,
        });
      }

      // Production response
      return NextResponse.json({
        paymentId: payment.id,
        amount,
        metadata: {
          consultationId: consultation.id,
          appointmentId: consultation.appointment.id,
          userId: session.user.id,
          planTitle: plan.title,
          consultantName: plan.consultantProfile?.user?.name,
        },
        redirectUrl: `/checkout/${validatedData.paymentGateway.toLowerCase()}`,
      });
    });
  } catch (error) {
    return handleError(error);
  }
}

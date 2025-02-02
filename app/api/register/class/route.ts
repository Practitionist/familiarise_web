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
const checkoutSchema = z.object({
  classId: z.string(),
  discountCode: z.string().optional(),
  paymentGateway: z.enum(["STRIPE", "RAZORPAY", "LEMON_SQUEEZY", "XFLOW"]),
});

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
      // 1. Get class details
      const classEntity = await tx.class.findUnique({
        where: { id: validatedData.classId },
        include: {
          classPlan: {
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
              classContents: {
                orderBy: {
                  order: "asc",
                },
              },
            },
          },
          appointments: {
            include: {
              slotsOfAppointment: true,
            },
          },
          waitlist: true,
        },
      });

      if (!classEntity) {
        throw new Error("Class not found");
      }

      const plan = classEntity.classPlan;
      if (!plan) {
        throw new Error("Class plan not found");
      }

      // 2. Get consultee profile
      const consultee = await tx.consulteeProfile.findUnique({
        where: { userId: session.user.id },
      });

      if (!consultee) {
        throw new Error("Consultee profile not found");
      }

      // Check existing registration
      const existingRegistration = await tx.waitlist.findFirst({
        where: {
          userId: session.user.id,
          classId: classEntity.id,
        },
      });

      if (existingRegistration) {
        throw new Error("You are already registered for this class");
      }

      // Check participant limit
      if (classEntity.waitlist.length >= plan.maxParticipants) {
        throw new Error("This class is already full");
      }

      // Add user to waitlist
      await tx.waitlist.create({
        data: {
          userId: session.user.id,
          classId: classEntity.id,
        },
      });

      // Update class status in development
      if (process.env.NODE_ENV === "development") {
        await tx.class.update({
          where: { id: classEntity.id },
          data: { status: "IN_PROGRESS" },
        });
      }

      // Get or create appointment with slots
      let appointment = classEntity.appointments[0];
      if (!plan.consultantProfileId) {
        throw new Error("Consultant profile not found for this class");
      }

      // Get the first available slot from the consultant's schedule
      const slot = await tx.slotOfAvailabilityCustom.findFirst({
        where: {
          consultantProfileId: plan.consultantProfileId,
        },
        orderBy: {
          slotStartTimeInUTC: "asc",
        },
      });

      if (!slot) {
        throw new Error("No available slots found for this class");
      }

      if (appointment) {
        // Add user to existing appointment's slots
        await tx.slotOfAppointment.create({
          data: {
            slotStartTimeInUTC: slot.slotStartTimeInUTC,
            slotEndTimeInUTC: slot.slotEndTimeInUTC,
            isTentative: process.env.NODE_ENV !== "development",
            appointment: {
              connect: { id: appointment.id },
            },
            user: {
              connect: { id: session.user.id },
            },
          },
        });
      } else {
        // Create new appointment with slots
        appointment = await tx.appointment.create({
          data: {
            appointmentType: "CLASS",
            classId: classEntity.id,
            slotsOfAppointment: {
              create: {
                slotStartTimeInUTC: slot.slotStartTimeInUTC,
                slotEndTimeInUTC: slot.slotEndTimeInUTC,
                isTentative: process.env.NODE_ENV !== "development",
                user: {
                  connect: { id: session.user.id },
                },
              },
            },
          },
          include: {
            slotsOfAppointment: true,
          },
        });
      }

      if (!appointment) {
        throw new Error("Failed to create appointment");
      }

      // Calculate final amount (including discounts if any)
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

      // Create payment record
      const payment = await tx.payment.create({
        data: {
          amount,
          currency: validatedData.paymentGateway === "RAZORPAY" ? "INR" : "USD",
          paymentMethod: "CARD",
          paymentIntent: `dev_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          paymentGateway: validatedData.paymentGateway,
          paymentStatus:
            process.env.NODE_ENV === "development" ? "SUCCEEDED" : "PENDING",
          userId: session.user.id,
          appointmentId: appointment.id,
          discountCodeId,
        },
      });

      // Return appropriate response based on environment
      if (process.env.NODE_ENV === "development") {
        return NextResponse.json({
          success: true,
          message: "Class registration successful",
          classId: classEntity.id,
          appointmentId: appointment.id,
          startDate: classEntity.startDate?.toISOString(),
          endDate: classEntity.endDate?.toISOString(),
          participantNumber: classEntity.waitlist.length,
          maxParticipants: plan.maxParticipants,
          modules: plan.classContents.length,
          certificateProvided: plan.certificateProvided,
        });
      }

      // Production response
      return NextResponse.json({
        paymentId: payment.id,
        amount,
        metadata: {
          classId: classEntity.id,
          appointmentId: appointment.id,
          userId: session.user.id,
          planTitle: plan.title,
          consultantName: plan.consultantProfile?.user?.name,
          startDate: classEntity.startDate?.toISOString(),
          endDate: classEntity.endDate?.toISOString(),
          participantNumber: classEntity.waitlist.length,
          maxParticipants: plan.maxParticipants,
          modules: plan.classContents.length,
          certificateProvided: plan.certificateProvided,
        },
        redirectUrl: `/checkout/${validatedData.paymentGateway.toLowerCase()}`,
      });
    });
  } catch (error) {
    return handleError(error);
  }
}

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
  webinarId: z.string(),
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
      // 1. Get webinar details
      const webinar = await tx.webinar.findUnique({
        where: { id: validatedData.webinarId },
        include: {
          webinarPlan: {
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
          },
          appointment: {
            include: {
              slotsOfAppointment: true,
            },
          },
          waitlist: true,
        },
      });

      if (!webinar) {
        throw new Error("Webinar not found");
      }

      const plan = webinar.webinarPlan;
      if (!plan) {
        throw new Error("Webinar plan not found");
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
          webinarId: webinar.id,
        },
      });

      if (existingRegistration) {
        throw new Error("You are already registered for this webinar");
      }

      // Check participant limit
      if (webinar.waitlist.length >= plan.maxParticipants) {
        throw new Error("This webinar is already full");
      }

      // Add user to waitlist with appropriate status
      await tx.waitlist.create({
        data: {
          userId: session.user.id,
          webinarId: webinar.id,
        },
      });

      // Update webinar status in development
      if (process.env.NODE_ENV === "development") {
        await tx.webinar.update({
          where: { id: webinar.id },
          data: { status: "IN_PROGRESS" },
        });
      }

      // Create or get appointment
      let appointment = webinar.appointment;
      if (!appointment) {
        if (!plan.consultantProfileId) {
          throw new Error("Consultant profile not found for this webinar");
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
          throw new Error("No available slots found for this webinar");
        }

        appointment = await tx.appointment.create({
          data: {
            appointmentType: "WEBINAR",
            webinarId: webinar.id,
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
          message: "Webinar registration successful",
          webinarId: webinar.id,
          appointmentId: appointment.id,
          participantNumber: webinar.waitlist.length,
          maxParticipants: plan.maxParticipants,
        });
      }

      // Production response
      return NextResponse.json({
        paymentId: payment.id,
        amount,
        metadata: {
          webinarId: webinar.id,
          appointmentId: appointment.id,
          userId: session.user.id,
          planTitle: plan.title,
          consultantName: plan.consultantProfile?.user?.name,
          participantNumber: webinar.waitlist.length,
          maxParticipants: plan.maxParticipants,
        },
        redirectUrl: `/checkout/${validatedData.paymentGateway.toLowerCase()}`,
      });
    });
  } catch (error) {
    return handleError(error);
  }
}

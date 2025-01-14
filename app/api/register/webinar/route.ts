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
  webinarPlanId: z.string(),
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
      // 1. Get webinar plan details
      const plan = await tx.webinarPlan.findUnique({
        where: { id: validatedData.webinarPlanId },
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
          webinars: {
            where: {
              status: {
                in: ["SCHEDULED", "IN_PROGRESS"],
              },
            },
            include: {
              waitlist: true,
            },
          },
        },
      });

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

      // 3. Check if there's an active webinar and validate registration
      const activeWebinar = plan.webinars[0];
      if (!activeWebinar) {
        throw new Error("No active webinar found for this plan");
      }

      const existingRegistration = await tx.waitlist.findFirst({
        where: {
          userId: session.user.id,
          webinarId: activeWebinar.id,
        },
      });

      if (existingRegistration) {
        throw new Error("You are already registered for this webinar");
      }

      // 4. Check participant limit
      if (activeWebinar.waitlist.length >= plan.maxParticipants) {
        throw new Error("This webinar is already full");
      }

      // 5. Create webinar registration
      const webinar = await tx.webinar.update({
        where: { id: activeWebinar.id },
        data: {
          status: process.env.NODE_ENV === "development" ? "IN_PROGRESS" : "SCHEDULED",
          waitlist: {
            create: {
              userId: session.user.id,
            },
          },
          appointment: {
            create: {
              appointmentType: "WEBINAR",
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

      // 6. Calculate final amount (including discounts if any)
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

      // 7. Create payment record
      const payment = await tx.payment.create({
        data: {
          amount,
          currency: validatedData.paymentGateway === "RAZORPAY" ? "INR" : "USD",
          paymentMethod: "CARD",
          paymentIntent: "", // Will be set by checkout route
          paymentGateway: validatedData.paymentGateway,
          paymentStatus: process.env.NODE_ENV === "development" ? "SUCCEEDED" : "PENDING",
          userId: session.user.id,
          appointmentId: webinar.appointment.id,
          discountCodeId,
        },
      });

      // 8. Return appropriate response based on environment
      if (process.env.NODE_ENV === "development") {
        return NextResponse.json({
          success: true,
          message: "Webinar registration successful",
          webinarId: webinar.id,
          appointmentId: webinar.appointment.id,
          participantNumber: activeWebinar.waitlist.length + 1,
          maxParticipants: plan.maxParticipants,
        });
      }

      // Production response
      return NextResponse.json({
        paymentId: payment.id,
        amount,
        metadata: {
          webinarId: webinar.id,
          appointmentId: webinar.appointment.id,
          userId: session.user.id,
          planTitle: plan.title,
          consultantName: plan.consultantProfile?.user?.name,
          participantNumber: activeWebinar.waitlist.length + 1,
          maxParticipants: plan.maxParticipants,
        },
        redirectUrl: `/checkout/${validatedData.paymentGateway.toLowerCase()}`,
      });
    });
  } catch (error) {
    return handleError(error);
  }
}

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
  classPlanId: z.string(),
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
      // 1. Get class plan details
      const plan = await tx.classPlan.findUnique({
        where: { id: validatedData.classPlanId },
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
          classes: {
            where: {
              status: {
                in: ["SCHEDULED", "IN_PROGRESS"],
              },
            },
            include: {
              waitlist: true,
            },
          },
          classContents: {
            orderBy: {
              order: "asc",
            },
          },
        },
      });

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

      // 3. Check if there's an active class and validate registration
      const activeClass = plan.classes[0];
      if (!activeClass) {
        throw new Error("No active class found for this plan");
      }

      const existingRegistration = await tx.waitlist.findFirst({
        where: {
          userId: session.user.id,
          classId: activeClass.id,
        },
      });

      if (existingRegistration) {
        throw new Error("You are already registered for this class");
      }

      // 4. Check participant limit
      if (activeClass.waitlist.length >= plan.maxParticipants) {
        throw new Error("This class is already full");
      }

      // 5. Create class registration
      const startDate = new Date();
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + plan.durationInMonths);

      const classEntity = await tx.class.update({
        where: { id: activeClass.id },
        data: {
          startDate,
          endDate,
          status: process.env.NODE_ENV === "development" ? "IN_PROGRESS" : "SCHEDULED",
          waitlist: {
            create: {
              userId: session.user.id,
            },
          },
          appointments: {
            create: {
              appointmentType: "CLASS",
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
          appointmentId: classEntity.appointments[0].id,
          discountCodeId,
        },
      });

      // 8. Return appropriate response based on environment
      if (process.env.NODE_ENV === "development") {
        return NextResponse.json({
          success: true,
          message: "Class registration successful",
          classId: classEntity.id,
          appointmentId: classEntity.appointments[0].id,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          participantNumber: activeClass.waitlist.length + 1,
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
          appointmentId: classEntity.appointments[0].id,
          userId: session.user.id,
          planTitle: plan.title,
          consultantName: plan.consultantProfile?.user?.name,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          participantNumber: activeClass.waitlist.length + 1,
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

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
  subscriptionPlanId: z.string(),
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
      // 1. Get subscription plan details
      const plan = await tx.subscriptionPlan.findUnique({
        where: { id: validatedData.subscriptionPlanId },
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

      // 2. Get consultee profile
      const consultee = await tx.consulteeProfile.findUnique({
        where: { userId: session.user.id },
      });

      if (!consultee) {
        throw new Error("Consultee profile not found");
      }

      // 3. Check if user already has an active subscription
      const existingSubscription = await tx.subscription.findFirst({
        where: {
          requestedById: consultee.id,
          subscriptionPlanId: plan.id,
          requestStatus: {
            in: ["PENDING", "APPROVED"],
          },
        },
      });

      if (existingSubscription) {
        throw new Error(
          existingSubscription.requestStatus === "PENDING"
            ? "You already have a pending subscription"
            : "You already have an active subscription"
        );
      }

      // 4. Create subscription with appropriate status
      const startDate = new Date();
      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + plan.durationInMonths);

      const subscription = await tx.subscription.create({
        data: {
          subscriptionPlanId: plan.id,
          requestStatus: process.env.NODE_ENV === "development" ? "APPROVED" : "PENDING",
          requestedById: consultee.id,
          startDate,
          endDate,
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
          appointmentId: subscription.appointments[0].id,
          discountCodeId,
        },
      });

      // 7. Return appropriate response based on environment
      if (process.env.NODE_ENV === "development") {
        return NextResponse.json({
          success: true,
          message: "Subscription created successfully",
          subscriptionId: subscription.id,
          appointmentId: subscription.appointments[0].id,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
        });
      }

      // Production response
      return NextResponse.json({
        paymentId: payment.id,
        amount,
        metadata: {
          subscriptionId: subscription.id,
          appointmentId: subscription.appointments[0].id,
          userId: session.user.id,
          planTitle: plan.title,
          consultantName: plan.consultantProfile?.user?.name,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
        },
        redirectUrl: `/checkout/${validatedData.paymentGateway.toLowerCase()}`,
      });
    });
  } catch (error) {
    return handleError(error);
  }
}

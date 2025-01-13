import { razorpay, stripe } from "@/lib/payment";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import authOptions from "../../auth/[...nextauth]/options";



// Validate request body
const checkoutSchema = z.object({
  consultationPlanId: z.string(),
  slotOfAvailabilityWeeklyId: z.string().optional(),
  slotOfAvailabilityCustomId: z.string().optional(),
  slotStartTimeInUTC: z.string().datetime(),
  slotEndTimeInUTC: z.string().datetime(),
  discountCode: z.string().optional(),
  paymentGateway: z.enum(["STRIPE", "RAZORPAY"]),
})
.refine(
  (data) =>
    (data.slotOfAvailabilityWeeklyId && !data.slotOfAvailabilityCustomId) ||
    (!data.slotOfAvailabilityWeeklyId && data.slotOfAvailabilityCustomId),
  {
    message:
      "Exactly one of slotOfAvailabilityWeeklyId or slotOfAvailabilityCustomId must be provided",
  }
)
.refine(
  (data) => new Date(data.slotStartTimeInUTC) < new Date(data.slotEndTimeInUTC),
  {
    message: "Start time must be before end time",
  }
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
          consultantProfile: true,
        },
      });

      if (!plan) {
        throw new Error("Consultation plan not found");
      }

      // 2. Create tentative slot reservation
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

      // 3. Create consultation with pending status and appointment
      const consultation = await tx.consultation.create({
        data: {
          consultationPlanId: plan.id,
          requestStatus: "PENDING",
          requestedById: session.user.id,
          appointment: {
            create: {
              appointmentType: "CONSULTATION",
              slotsOfAppointment: {
                create: {
                  slotStartTimeInUTC: new Date(validatedData.slotStartTimeInUTC),
                  slotEndTimeInUTC: new Date(validatedData.slotEndTimeInUTC),
                  isTentative: true,
                  user: {
                    connect: { id: session.user.id }
                  }
                }
              }
            }
          }
        },
        include: {
          appointment: true
        }
      });

      // 4. Calculate final amount (including discounts if any)
      let amount = plan.price;
      if (validatedData.discountCode) {
        const discount = await tx.discountCode.findUnique({
          where: { code: validatedData.discountCode },
        });
        if (discount) {
          amount =
            discount.discountType === "PERCENTAGE"
              ? amount * (1 - discount.discountValue / 100)
              : amount - discount.discountValue;
        }
      }

      if (!consultation.appointment) {
        throw new Error("Failed to create appointment");
      }

      // 5. Create payment intent based on gateway
      let paymentIntent;
      if (validatedData.paymentGateway === "STRIPE") {
        paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100), // Convert to cents
          currency: "usd",
          metadata: {
            consultationId: consultation.id,
            appointmentId: consultation.appointment.id,
          },
        });

        // Create payment record
        await tx.payment.create({
          data: {
            amount: amount,
            currency: "USD",
            paymentMethod: "CARD",
            paymentIntent: paymentIntent.id,
            paymentGateway: "STRIPE",
            paymentStatus: "PENDING",
            userId: session.user.id,
            appointmentId: consultation.appointment.id,
            discountCodeId: validatedData.discountCode || null,
          },
        });

        return NextResponse.json({
          clientSecret: paymentIntent.client_secret,
          redirectUrl: `/checkout/stripe?payment_intent=${paymentIntent.id}`,
        });
      } else {
        // Razorpay
        const order = await razorpay.orders.create({
          amount: Math.round(amount * 100),
          currency: "INR",
          notes: {
            consultationId: consultation.id,
            appointmentId: consultation.appointment.id,
          },
        });

        // Create payment record
        await tx.payment.create({
          data: {
            amount: amount,
            currency: "INR",
            paymentMethod: "CARD",
            paymentIntent: order.id,
            paymentGateway: "RAZORPAY",
            paymentStatus: "PENDING",
            userId: session.user.id,
            appointmentId: consultation.appointment.id,
            discountCodeId: validatedData.discountCode || null,
          },
        });

        return NextResponse.json({
          orderId: order.id,
          redirectUrl: `/checkout/razorpay?order_id=${order.id}`,
        });
      }
    });
  } catch (error) {
    console.error("Checkout error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Checkout failed",
      },
      { status: 400 }
    );
  }
}

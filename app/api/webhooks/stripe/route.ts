import prisma from "@/lib/prisma";
import { PaymentStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { PaymentMetadata } from "@/types/checkout";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-04-30.basil",
});

export async function POST(req: Request) {
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "No signature found" }, { status: 400 });
  }

  try {
    const body = await req.text();
    const event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );

    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object as Stripe.PaymentIntent & {
        charges: {
          data: Array<{
            receipt_url: string;
          }>;
        };
      };
      const metadata = paymentIntent.metadata as PaymentMetadata;

      await prisma.$transaction(async (tx) => {
        // Update payment status
        await tx.payment.updateMany({
          where: { paymentIntent: paymentIntent.id },
          data: {
            paymentStatus: PaymentStatus.SUCCEEDED,
            receiptUrl: paymentIntent.charges.data[0]?.receipt_url,
          },
        });

        // Update appointment status
        const payment = await tx.payment.findFirst({
          where: { paymentIntent: paymentIntent.id },
          include: {
            appointment: {
              include: {
                consultation: true,
                subscription: true,
              },
            },
          },
        });

        if (!payment) {
          throw new Error("Payment not found");
        }

        // Update slot status
        await tx.slotOfAppointment.updateMany({
          where: { appointmentId: payment.appointmentId },
          data: { isTentative: false },
        });

        // Update specific appointment type status
        if (payment.appointment.consultation) {
          await tx.consultation.update({
            where: { id: payment.appointment.consultation.id },
            data: { requestStatus: "APPROVED" },
          });
        }

        if (payment.appointment.subscription) {
          await tx.subscription.update({
            where: { id: payment.appointment.subscription.id },
            data: { requestStatus: "APPROVED" },
          });
        }
      });
    }

    if (event.type === "payment_intent.payment_failed") {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;

      await prisma.$transaction(async (tx) => {
        const payment = await tx.payment.findFirst({
          where: { paymentIntent: paymentIntent.id },
        });

        if (payment) {
          // Update payment status
          await tx.payment.update({
            where: { id: payment.id },
            data: { paymentStatus: PaymentStatus.FAILED },
          });

          // Release tentative slots
          await tx.slotOfAppointment.updateMany({
            where: { appointmentId: payment.appointmentId },
            data: { isTentative: false },
          });
        }
      });
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 400 },
    );
  }
}

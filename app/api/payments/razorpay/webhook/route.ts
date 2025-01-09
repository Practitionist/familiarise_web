import prisma from "@/lib/prisma";
import { PaymentStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import crypto from "crypto";
import { PaymentMetadata } from "@/types/checkout";

interface RazorpayPayment {
  order_id: string;
  status: string;
  notes: Record<string, string>;
  receipt_url?: string;
}

interface RazorpayWebhookEvent {
  event: string;
  payload: {
    payment: {
      entity: RazorpayPayment;
    };
    order: {
      entity: {
        id: string;
        notes: Record<string, string>;
      };
    };
  };
}

export async function POST(req: Request) {
  const signature = req.headers.get("x-razorpay-signature");

  if (!signature) {
    return NextResponse.json({ error: "No signature found" }, { status: 400 });
  }

  try {
    const body = await req.text();

    // Verify webhook signature
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET!)
      .update(body)
      .digest("hex");

    if (signature !== expectedSignature) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    const event = JSON.parse(body) as RazorpayWebhookEvent;

    if (event.event === "order.paid") {
      const { order, payment } = event.payload;
      const metadata = order.entity.notes as PaymentMetadata;

      await prisma.$transaction(async (tx) => {
        // Update payment status
        await tx.payment.updateMany({
          where: { paymentIntent: order.entity.id },
          data: {
            paymentStatus: PaymentStatus.SUCCEEDED,
            receiptUrl: payment.entity.receipt_url,
          },
        });

        // Update appointment status
        const paymentRecord = await tx.payment.findFirst({
          where: { paymentIntent: order.entity.id },
          include: {
            appointment: {
              include: {
                consultation: true,
                subscription: true,
              },
            },
          },
        });

        if (!paymentRecord) {
          throw new Error("Payment not found");
        }

        // Update slot status
        await tx.slotOfAppointment.updateMany({
          where: { appointmentId: paymentRecord.appointmentId },
          data: { isTentative: false },
        });

        // Update specific appointment type status
        if (paymentRecord.appointment.consultation) {
          await tx.consultation.update({
            where: { id: paymentRecord.appointment.consultation.id },
            data: { requestStatus: "APPROVED" },
          });
        }

        if (paymentRecord.appointment.subscription) {
          await tx.subscription.update({
            where: { id: paymentRecord.appointment.subscription.id },
            data: { requestStatus: "APPROVED" },
          });
        }
      });
    }

    if (event.event === "order.payment.failed") {
      const { order } = event.payload;

      await prisma.$transaction(async (tx) => {
        const payment = await tx.payment.findFirst({
          where: { paymentIntent: order.entity.id },
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
    console.error("Razorpay webhook error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 400 },
    );
  }
}

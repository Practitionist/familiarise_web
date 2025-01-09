import prisma from "@/lib/prisma";
import { PaymentStatus, RequestStatus } from "@prisma/client";
import { validatePaymentWebhook } from "@/lib/payment";
import { NextResponse } from "next/server";
import { PaymentWebhookEvent } from "@/types/checkout";

export async function POST(req: Request) {
  try {
    const event = (await validatePaymentWebhook(req)) as PaymentWebhookEvent;

    if (
      event.type === "payment_intent.succeeded" ||
      event.type === "order.paid"
    ) {
      const { appointmentId, appointmentType } = event.metadata;

      await prisma.$transaction(async (tx) => {
        // 1. Update payment status
        await tx.payment.updateMany({
          where: { appointmentId },
          data: { paymentStatus: PaymentStatus.SUCCEEDED },
        });

        // 2. Confirm appointment slots
        await tx.slotOfAppointment.updateMany({
          where: { appointmentId },
          data: { isTentative: false },
        });

        // 3. Update appointment status based on type
        switch (appointmentType) {
          case "CONSULTATION":
            await tx.consultation.updateMany({
              where: {
                appointment: { id: appointmentId },
              },
              data: { requestStatus: RequestStatus.APPROVED },
            });
            break;
          case "SUBSCRIPTION":
            await tx.subscription.updateMany({
              where: {
                appointments: { some: { id: appointmentId } },
              },
              data: { requestStatus: RequestStatus.APPROVED },
            });
            break;
          // Webinar and Class don't need status updates as they're pre-created
        }

        // 4. Send confirmation notifications
        // TODO: Implement notification system
      });

      return NextResponse.json({ received: true });
    }

    // Handle payment failures
    if (
      event.type === "payment_intent.payment_failed" ||
      event.type === "order.payment.failed"
    ) {
      const { appointmentId } = event.metadata;

      await prisma.$transaction(async (tx) => {
        // 1. Update payment status
        await tx.payment.updateMany({
          where: { appointmentId },
          data: { paymentStatus: PaymentStatus.FAILED },
        });

        // 2. Release tentative slots
        await tx.slotOfAppointment.updateMany({
          where: { appointmentId },
          data: { isTentative: false },
        });

        // 3. Update appointment status based on type
        const appointment = await tx.appointment.findUnique({
          where: { id: appointmentId },
          include: {
            consultation: true,
            subscription: true,
          },
        });

        if (appointment?.consultation) {
          await tx.consultation.update({
            where: { id: appointment.consultation.id },
            data: { requestStatus: RequestStatus.CANCELLED },
          });
        }

        if (appointment?.subscription) {
          await tx.subscription.updateMany({
            where: {
              appointments: { some: { id: appointmentId } },
            },
            data: { requestStatus: RequestStatus.CANCELLED },
          });
        }

        // 4. Send failure notifications
        // TODO: Implement notification system
      });

      return NextResponse.json({ received: true });
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 400 },
    );
  }
}

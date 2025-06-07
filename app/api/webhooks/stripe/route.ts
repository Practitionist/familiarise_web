import prisma from "@/lib/prisma";
import { PaymentStatus, OrderStatus, ProductType, Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-06-20",
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

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // 1. Update Payment status
        const updatedPayment = await tx.payment.updateMany({
          where: { paymentIntent: paymentIntent.id },
          data: {
            paymentStatus: PaymentStatus.SUCCEEDED,
            receiptUrl: paymentIntent.charges.data[0]?.receipt_url,
          },
        });

        if (updatedPayment.count === 0) {
          console.error(`Stripe Webhook: No payment record found to update for paymentIntent ${paymentIntent.id}`);
          // Potentially throw an error or return if critical, or handle cases where webhook might arrive before payment record is fully committed.
          // For now, we'll proceed cautiously. If payment record must exist, this should be an error.
          throw new Error(`Payment record not found for paymentIntent ${paymentIntent.id}`);
        }

        // Retrieve the payment record to get orderId
        const paymentRecord = await tx.payment.findFirst({
          where: { paymentIntent: paymentIntent.id },
        });

        if (!paymentRecord?.orderId) { // Used optional chaining here for orderId
          console.error(`Stripe Webhook: Payment record not found or orderId missing for paymentIntent ${paymentIntent.id}`);
          throw new Error(`Payment record not found or orderId missing after update for paymentIntent ${paymentIntent.id}`);
        }

        // 2. Update Order status
        const order = await tx.order.update({
          where: { id: paymentRecord.orderId },
          data: { status: OrderStatus.COMPLETED },
          include: { items: true }, // Include items for fulfillment
        });

        if (!order) {
          console.error(`Stripe Webhook: Order not found for orderId ${paymentRecord.orderId}`);
          throw new Error(`Order not found: ${paymentRecord.orderId}`);
        }

        // 3. Process OrderItems for fulfillment
        for (const item of order.items) {
          switch (item.productType) {
            case ProductType.CONSULTATION:
              // TODO: Implement Consultation Booking Logic
              // - Create ConsultationBooking record, link to item.id or order.id
              // - Update SlotOfAppointment status if applicable (e.g., from planSnapshot or a related booking record)
              // - Update Consultation requestStatus if applicable
              console.log(`TODO: Fulfill consultation for order item ${item.id}, plan ${item.planId}`);
              break;
            case ProductType.CLASS:
              // TODO: Implement Class Registration Logic
              // - Create ClassRegistration record, link to item.id or order.id
              console.log(`TODO: Fulfill class registration for order item ${item.id}, plan ${item.planId}`);
              break;
            case ProductType.WEBINAR:
              // TODO: Implement Webinar Registration Logic
              // - Create WebinarRegistration record, link to item.id or order.id
              console.log(`TODO: Fulfill webinar registration for order item ${item.id}, plan ${item.planId}`);
              break;
            case ProductType.SUBSCRIPTION:
              // TODO: Implement Subscription Activation Logic
              // - Create/Update UserSubscription record, link to item.id or order.id
              // - Set start/end dates based on plan details in item.planSnapshot
              console.log(`TODO: Fulfill subscription for order item ${item.id}, plan ${item.planId}`);
              break;
            default:
              console.warn(`Stripe Webhook: Unknown product type ${item.productType} for order item ${item.id}`);
          }
        }
      });
    }

    if (event.type === "payment_intent.payment_failed") {
      const paymentIntent = event.data.object;

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const paymentRecord = await tx.payment.findFirst({
          where: { paymentIntent: paymentIntent.id },
        });

        if (paymentRecord) {
          // 1. Update Payment status
          await tx.payment.update({
            where: { id: paymentRecord.id },
            data: { paymentStatus: PaymentStatus.FAILED },
          });

          // 2. Update Order status (if orderId exists on payment)
          if (paymentRecord.orderId) {
            await tx.order.update({
              where: { id: paymentRecord.orderId },
              data: { status: OrderStatus.FAILED },
              // Optionally include items if further processing is needed for failed payments
              // include: { items: true }
            });
            // TODO: Handle any necessary rollbacks or notifications for failed payment related to order items
            // e.g., if slots were made tentative, they might need to be explicitly released here based on OrderItems.
            console.log(`TODO: Handle post-failure logic for order ${paymentRecord.orderId} and its items.`);
          } else {
            console.warn(`Stripe Webhook (Payment Failed): No orderId found on payment record ${paymentRecord.id} for paymentIntent ${paymentIntent.id}`);
          }
        } else {
          console.warn(`Stripe Webhook (Payment Failed): No payment record found for paymentIntent ${paymentIntent.id}`);
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

import prisma from "@/lib/prisma";
import { PaymentStatus, OrderStatus, ProductType, Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import crypto from "crypto";

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
      const razorpayOrder = event.payload.order.entity;
      const razorpayPayment = event.payload.payment.entity;

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // 1. Update Payment status
        // Assuming your 'paymentIntent' field in Payment model stores Razorpay's order_id
        const updatedPayment = await tx.payment.updateMany({
          where: { paymentIntent: razorpayOrder.id }, 
          data: {
            paymentStatus: PaymentStatus.SUCCEEDED,
            receiptUrl: razorpayPayment.receipt_url, // Corrected to use razorpayPayment
          },
        });

        if (updatedPayment.count === 0) {
          console.error(`Razorpay Webhook: No payment record found to update for Razorpay order_id ${razorpayOrder.id}`);
          throw new Error(`Payment record not found for Razorpay order_id ${razorpayOrder.id}`);
        }

        // Retrieve the payment record to get your internal orderId
        const paymentRecord = await tx.payment.findFirst({
          where: { paymentIntent: razorpayOrder.id }, 
        });

        if (!paymentRecord?.orderId) {
          console.error(`Razorpay Webhook: Payment record not found or internal orderId missing for Razorpay order_id ${razorpayOrder.id}`);
          throw new Error(`Payment record not found or internal orderId missing after update for Razorpay order_id ${razorpayOrder.id}`);
        }

        // 2. Update internal Order status
        const order = await tx.order.update({
          where: { id: paymentRecord.orderId },
          data: { status: OrderStatus.COMPLETED },
          include: { items: true }, // Include items for fulfillment
        });

        if (!order) {
          console.error(`Razorpay Webhook: Internal order not found for orderId ${paymentRecord.orderId}`);
          throw new Error(`Internal order not found: ${paymentRecord.orderId}`);
        }

        // 3. Process OrderItems for fulfillment
        for (const item of order.items) {
          switch (item.productType) {
            case ProductType.CONSULTATION:
              // TODO: Implement Consultation Booking Logic
              console.log(`TODO: Fulfill consultation for order item ${item.id}, plan ${item.planId}`);
              break;
            case ProductType.CLASS:
              // TODO: Implement Class Registration Logic
              console.log(`TODO: Fulfill class registration for order item ${item.id}, plan ${item.planId}`);
              break;
            case ProductType.WEBINAR:
              // TODO: Implement Webinar Registration Logic
              console.log(`TODO: Fulfill webinar registration for order item ${item.id}, plan ${item.planId}`);
              break;
            case ProductType.SUBSCRIPTION:
              // TODO: Implement Subscription Activation Logic
              console.log(`TODO: Fulfill subscription for order item ${item.id}, plan ${item.planId}`);
              break;
            default:
              console.warn(`Razorpay Webhook: Unknown product type ${item.productType} for order item ${item.id}`);
          }
        }
      });
    }

    if (event.event === "payment.failed" || event.event === "order.payment.failed") { // Handling both common event names for failure
      const razorpayOrderEntity = event.payload.order?.entity; // Order entity might not be present in 'payment.failed'
      const razorpayPaymentEntity = event.payload.payment?.entity;
      
      // Determine the paymentIntent (Razorpay order_id) from available payload
      const razorpayOrderId = razorpayPaymentEntity?.order_id || razorpayOrderEntity?.id;

      if (!razorpayOrderId) {
        console.error("Razorpay Webhook (Failed): Could not determine Razorpay Order ID from webhook payload.", event.payload);
        throw new Error("Missing Razorpay Order ID in failure webhook.");
      }

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const paymentRecord = await tx.payment.findFirst({
          where: { paymentIntent: razorpayOrderId }, 
        });

        if (paymentRecord) {
          // 1. Update Payment status
          await tx.payment.update({
            where: { id: paymentRecord.id },
            data: { paymentStatus: PaymentStatus.FAILED },
          });

          // 2. Update internal Order status (if orderId exists on payment)
          if (paymentRecord.orderId) {
            await tx.order.update({
              where: { id: paymentRecord.orderId },
              data: { status: OrderStatus.FAILED },
            });
            // TODO: Handle any necessary rollbacks or notifications for failed payment related to order items.
            console.log(`TODO: Handle post-failure logic for order ${paymentRecord.orderId} and its items.`);
          } else {
            console.warn(`Razorpay Webhook (Payment Failed): No internal orderId found on payment record ${paymentRecord.id} for Razorpay order_id ${razorpayOrderId}`);
          }
        } else {
          console.warn(`Razorpay Webhook (Payment Failed): No payment record found for Razorpay order_id ${razorpayOrderId}`);
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

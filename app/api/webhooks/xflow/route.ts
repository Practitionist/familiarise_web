import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { PaymentStatus, OrderStatus, ProductType, Prisma } from "@prisma/client";
import { headers } from "next/headers";
import crypto from "crypto";

// Verify Xflow webhook signature
function verifySignature(body: string, signature: string, secret: string) {
  const hmac = crypto.createHmac("sha256", secret);
  const digest = hmac.update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const headersList = await headers();
    const signature = headersList.get("x-xflow-signature") ?? "";
    const secret = process.env.XFLOW_WEBHOOK_SECRET;

    if (!signature || !secret) {
      return NextResponse.json(
        { error: "Missing signature or secret" },
        { status: 401 },
      );
    }

    // Verify webhook signature
    if (!verifySignature(body, signature, secret)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const event = JSON.parse(body);
    const { type, data } = event;

    // Handle different event types
    switch (type) {
      case "payment.succeeded":
        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const xflowPaymentId = data.id.toString();

          // 1. Update Payment status
          const updatedPayment = await tx.payment.updateMany({
            where: { paymentIntent: xflowPaymentId },
            data: {
              paymentStatus: PaymentStatus.SUCCEEDED,
              receiptUrl: data.receipt_url,
            },
          });

          if (updatedPayment.count === 0) {
            console.error(`XFlow Webhook: No payment record found to update for XFlow payment ID ${xflowPaymentId}`);
            throw new Error(`Payment record not found for XFlow payment ID ${xflowPaymentId}`);
          }

          const paymentRecord = await tx.payment.findFirst({
            where: { paymentIntent: xflowPaymentId },
          });

          if (!paymentRecord?.orderId) {
            console.error(`XFlow Webhook: Payment record not found or internal orderId missing for XFlow payment ID ${xflowPaymentId}`);
            throw new Error(`Payment record not found or internal orderId missing after update for XFlow payment ID ${xflowPaymentId}`);
          }

          // 2. Update internal Order status
          const order = await tx.order.update({
            where: { id: paymentRecord.orderId },
            data: { status: OrderStatus.COMPLETED },
            include: { items: true }, // Include items for fulfillment
          });

          if (!order) {
            console.error(`XFlow Webhook: Internal order not found for orderId ${paymentRecord.orderId}`);
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
                console.warn(`XFlow Webhook: Unknown product type ${item.productType} for order item ${item.id}`);
            }
          }
        });
        break;

      case "payment.failed":
        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const xflowPaymentId = data.id.toString();

          const paymentRecord = await tx.payment.findFirst({
            where: { paymentIntent: xflowPaymentId },
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
              console.warn(`XFlow Webhook (Payment Failed): No internal orderId found on payment record ${paymentRecord.id} for XFlow payment ID ${xflowPaymentId}`);
            }
          } else {
            console.warn(`XFlow Webhook (Payment Failed): No payment record found for XFlow payment ID ${xflowPaymentId}`);
          }
        });
        break;

      case "refund.created":
        // Handle refund
        break;

      case "subscription.created":
        // Handle new subscription
        break;

      case "subscription.cancelled":
        // Handle subscription cancellation
        break;

      case "subscription.updated":
        // Handle subscription update
        break;

      default:
        console.log(`Unhandled event type: ${type}`);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }
}

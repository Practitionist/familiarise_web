// File: /home/kaustav/Desktop/familiarise_web/app/api/checkout/subscriptions/route.ts
import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../lib/prisma';
import { getServerSession } from 'next-auth';
import authOptions from '../../auth/[...nextauth]/options';
import { ProductType, PaymentGateway, OrderStatus, PaymentStatus, Prisma, SubscriptionPlan } from '@prisma/client';

interface PreparedOrderItemData {
  productType: ProductType;
  planId: string;
  planTitle: string;
  planSnapshot: Prisma.InputJsonValue;
  quantity: number; // Usually 1 for subscriptions, but kept for consistency
  unitPrice: number;
  finalPrice: number;
}

interface SubscriptionCheckoutItem {
  planId: string; // ID of the SubscriptionPlan
  quantity: number; // Typically 1 for subscriptions
}

interface SubscriptionCheckoutRequestBody {
  items: SubscriptionCheckoutItem[];
  paymentGateway: PaymentGateway;
  discountCode?: string;
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !(session.user as { id?: string })?.id) {
      return NextResponse.json({ error: 'User not authenticated' }, { status: 401 });
    }
    const userId = (session.user as { id: string }).id;

    const body: SubscriptionCheckoutRequestBody = await req.json();
    const { items, paymentGateway, discountCode: _discountCodeString } = body;

    if (!items || items.length === 0) {
      return NextResponse.json({ error: 'No items provided for checkout.' }, { status: 400 });
    }
    if (items.length > 1) {
      // Typically, only one subscription plan is purchased at a time.
      // This can be adjusted if multiple different subscriptions in one cart are allowed.
      console.warn('Multiple subscription items in a single checkout request. Processing first item only for simplicity or adjust logic.');
      // For now, let's assume only one subscription item is processed, or adjust if multiple are valid.
    }

    for (const item of items) {
      if (!item.planId || item.quantity <= 0) {
        return NextResponse.json({ error: 'Invalid item data for subscription.' }, { status: 400 });
      }
      if (item.quantity > 1) {
        // Usually, quantity for a subscription plan is 1. This might represent multiple periods if structured that way.
        // For simplicity, we'll assume quantity 1 means one subscription period.
        console.warn(`Subscription item ${item.planId} has quantity ${item.quantity}. Interpreting as 1 subscription period.`);
      }
    }

    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new Error('User not found');
      }

      let totalAmount = 0;
      const orderItemsData: PreparedOrderItemData[] = [];
      const validatedDiscountCodeId: string | null = null;

      // TODO: Implement discount code validation and application logic
      const calculatedDiscountAmount = 0;

      // Process only the first item for subscriptions, or adjust if multiple subscriptions are allowed in one order
      const itemToProcess = items[0]; 

      const subscriptionPlan: SubscriptionPlan | null = await tx.subscriptionPlan.findUnique({ where: { id: itemToProcess.planId } });
      if (!subscriptionPlan || typeof subscriptionPlan.price !== 'number') {
        throw new Error(`SubscriptionPlan with ID ${itemToProcess.planId} not found or price is invalid.`);
      }
      const unitPrice = subscriptionPlan.price;
      const planTitle = subscriptionPlan.title;
      const planSnapshot = { ...subscriptionPlan } as Prisma.InputJsonValue;

      // Quantity for subscriptions is typically 1, representing one subscription period/plan.
      const quantity = 1; // Override item.quantity or ensure it's handled correctly for subscriptions
      totalAmount += unitPrice * quantity;

      orderItemsData.push({
        productType: ProductType.SUBSCRIPTION,
        planId: itemToProcess.planId,
        planTitle,
        planSnapshot,
        quantity: quantity, // Use the determined quantity for subscription
        unitPrice,
        finalPrice: unitPrice * quantity,
      });
      
      const finalAmount = totalAmount - calculatedDiscountAmount;

      const order = await tx.order.create({
        data: {
          userId,
          totalAmount,
          discountAmount: calculatedDiscountAmount,
          finalAmount,
          currency: 'INR', // Or from subscriptionPlan.currency if available
          status: finalAmount === 0 ? OrderStatus.COMPLETED : OrderStatus.AWAITING_PAYMENT,
          paymentGatewayUsed: finalAmount > 0 ? paymentGateway : null,
          discountCodeId: validatedDiscountCodeId,
        },
      });

      for (const preparedItem of orderItemsData) {
        await tx.orderItem.create({
          data: {
            orderId: order.id,
            productType: preparedItem.productType,
            planId: preparedItem.planId,
            planTitle: preparedItem.planTitle,
            planSnapshot: preparedItem.planSnapshot,
            quantity: preparedItem.quantity,
            unitPrice: preparedItem.unitPrice,
            finalPrice: preparedItem.finalPrice,
          },
        });
        // TODO: Implement Subscription-specific logic here
        // e.g., create/update UserSubscription record, set start/end dates based on plan duration.
      }

      let paymentIntentClientSecret: string | null = null;
      let paymentIntentId: string | null = null;

      if (finalAmount > 0) {
        // TODO: Implement actual payment gateway integration for subscriptions (recurring payments?)
        if (paymentGateway === PaymentGateway.STRIPE) {
          console.warn('Stripe payment gateway not fully implemented for subscriptions.');
          paymentIntentId = `pi_stripe_placeholder_sub_${order.id}`;
          paymentIntentClientSecret = `stripe_cs_placeholder_sub_${order.id}`;
        } else if (paymentGateway === PaymentGateway.RAZORPAY) {
          console.warn('Razorpay payment gateway not fully implemented for subscriptions.');
          paymentIntentId = `pi_razorpay_placeholder_sub_${order.id}`;
        } else {
          throw new Error(`Unsupported payment gateway: ${paymentGateway}`);
        }

        await tx.payment.create({
          data: {
            orderId: order.id,
            userId,
            amount: finalAmount,
            currency: order.currency,
            paymentGateway,
            paymentIntent: paymentIntentId!,
            paymentStatus: PaymentStatus.PENDING,
            // For subscriptions, this might be an initial setup payment.
            // Recurring payments would be handled by webhooks and gateway-specific subscription objects.
          },
        });

        await tx.order.update({
          where: { id: order.id },
          data: { primaryPaymentIntentId: paymentIntentId },
        });
      }
      
      if (finalAmount === 0) {
        // TODO: Activate UserSubscription for free subscriptions
      }

      return { orderId: order.id, clientSecret: paymentIntentClientSecret, needsPayment: finalAmount > 0 };
    });

    return NextResponse.json(result);

  } catch (error: unknown) {
    console.error('Subscription Checkout API error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        return NextResponse.json({ error: 'Database error during subscription checkout.', details: error.message }, { status: 500 });
    } else if (error instanceof Error) {
        return NextResponse.json({ error: 'Subscription checkout failed due to an error.', details: error.message }, { status: 500 });
    }
    if (errorMessage.includes('User not found')) {
      return NextResponse.json({ error: 'User validation failed.' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Subscription checkout failed', details: errorMessage }, { status: 500 });
  }
}

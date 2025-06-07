// File: /home/kaustav/Desktop/familiarise_web/app/api/checkout/consultations/route.ts
import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../lib/prisma';
import { getServerSession } from 'next-auth';
import authOptions from '../../auth/[...nextauth]/options'; // Path relative to app/api/checkout/consultations/
import { ProductType, PaymentGateway, OrderStatus, PaymentStatus, Prisma, ConsultationPlan } from '@prisma/client';

// Interface for the structure of items being prepared for OrderItem creation
interface PreparedOrderItemData {
  productType: ProductType;
  planId: string;
  planTitle: string;
  planSnapshot: Prisma.InputJsonValue;
  quantity: number;
  unitPrice: number;
  finalPrice: number;
}

// Interface for the expected request body for a consultation checkout
interface ConsultationCheckoutItem {
  planId: string; // ID of the ConsultationPlan
  quantity: number;
  specificInstanceId?: string; // e.g., a pre-booked slot ID, if applicable
}

interface ConsultationCheckoutRequestBody {
  items: ConsultationCheckoutItem[]; // Expecting only consultation items
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

    const body: ConsultationCheckoutRequestBody = await req.json();
    const { items, paymentGateway, discountCode: _discountCodeString } = body;

    if (!items || items.length === 0) {
      return NextResponse.json({ error: 'No items provided for checkout.' }, { status: 400 });
    }

    // Validate that all items are for consultations
    for (const item of items) {
      if (!item.planId || item.quantity <= 0) {
        return NextResponse.json({ error: 'Invalid item data for consultation.' }, { status: 400 });
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
      // For now, discount is 0
      const calculatedDiscountAmount = 0;

      for (const item of items) {
        const consultationPlan: ConsultationPlan | null = await tx.consultationPlan.findUnique({ where: { id: item.planId } });
        if (!consultationPlan || typeof consultationPlan.price !== 'number') {
          throw new Error(`ConsultationPlan with ID ${item.planId} not found or price is invalid.`);
        }
        const unitPrice = consultationPlan.price;
        const planTitle = consultationPlan.title; // Assuming title exists on ConsultationPlan
        const planSnapshot = { ...consultationPlan } as Prisma.InputJsonValue;

        totalAmount += unitPrice * item.quantity;
        orderItemsData.push({
          productType: ProductType.CONSULTATION,
          planId: item.planId,
          planTitle,
          planSnapshot,
          quantity: item.quantity,
          unitPrice,
          finalPrice: unitPrice * item.quantity, // Apply item-specific discount here if any
        });
      }

      const finalAmount = totalAmount - calculatedDiscountAmount;

      const order = await tx.order.create({
        data: {
          userId,
          totalAmount,
          discountAmount: calculatedDiscountAmount,
          finalAmount,
          currency: 'INR', // Or derive from user/settings
          status: finalAmount === 0 ? OrderStatus.COMPLETED : OrderStatus.AWAITING_PAYMENT,
          paymentGatewayUsed: finalAmount > 0 ? paymentGateway : null,
          discountCodeId: validatedDiscountCodeId,
        },
      });

      // Create OrderItems
      for (const preparedItem of orderItemsData) {
        await tx.orderItem.create({ // Changed from createMany to create in loop
          data: {
            orderId: order.id,
            // Spread the preparedItem, assuming its structure matches OrderItemCreateManyOrderInput
            productType: preparedItem.productType,
            planId: preparedItem.planId,
            planTitle: preparedItem.planTitle,
            planSnapshot: preparedItem.planSnapshot,
            quantity: preparedItem.quantity,
            unitPrice: preparedItem.unitPrice,
            finalPrice: preparedItem.finalPrice,
          },
        });
        // TODO: Implement Consultation-specific booking logic here
        // e.g., create Consultation record, link to order, handle specificInstanceId
        // const currentItem = items.find(i => i.planId === preparedItem.planId); // to get specificInstanceId if needed
        // if (currentItem?.specificInstanceId) { ... }
      }

      let paymentIntentClientSecret: string | null = null;
      let paymentIntentId: string | null = null;

      if (finalAmount > 0) {
        // TODO: Implement actual payment gateway integration
        if (paymentGateway === PaymentGateway.STRIPE) {
            console.warn('Stripe payment gateway not fully implemented for consultations.');
          paymentIntentId = `pi_stripe_placeholder_${order.id}`; // Placeholder
          paymentIntentClientSecret = `stripe_cs_placeholder_${order.id}`; // Placeholder
        } else if (paymentGateway === PaymentGateway.RAZORPAY) {
          console.warn('Razorpay payment gateway not fully implemented for consultations.');
          paymentIntentId = `pi_razorpay_placeholder_${order.id}`; // Placeholder
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
            paymentIntent: paymentIntentId!, // Ensure this is non-null if finalAmount > 0
            paymentStatus: PaymentStatus.PENDING,
          },
        });

        await tx.order.update({
          where: { id: order.id },
          data: { primaryPaymentIntentId: paymentIntentId },
        });
      }
      
      if (finalAmount === 0) {
        // Order status is already COMPLETED if free.
        // TODO: Update Consultation booking status to CONFIRMED as well for free items
        // This would involve finding/creating the Consultation record linked to this order
        // and setting its status.
      }

      return { orderId: order.id, clientSecret: paymentIntentClientSecret, needsPayment: finalAmount > 0 };
    });

    return NextResponse.json(result);

  } catch (error: unknown) {
    console.error('Consultation Checkout API error:', error);
    // Log the error for debugging
    // Consider more specific error handling based on error types (e.g., PrismaClientKnownRequestError)
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        // Handle known Prisma errors
        return NextResponse.json({ error: 'Database error during checkout.', details: error.message }, { status: 500 });
    } else if (error instanceof Error) {
        return NextResponse.json({ error: 'Checkout failed due to an error.', details: error.message }, { status: 500 });
    }
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
    if (errorMessage.includes('User not found')) { // Example of custom error check
      return NextResponse.json({ error: 'User validation failed.' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Consultation checkout failed', details: errorMessage }, { status: 500 });
  }
}

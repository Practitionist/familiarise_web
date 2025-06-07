// File: /home/kaustav/Desktop/familiarise_web/app/api/checkout/classes/route.ts
import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../../lib/prisma';
import { getServerSession } from 'next-auth';
import authOptions from '../../auth/[...nextauth]/options';
import { ProductType, PaymentGateway, OrderStatus, PaymentStatus, Prisma, ClassPlan } from '@prisma/client';

interface PreparedOrderItemData {
  productType: ProductType;
  planId: string;
  planTitle: string;
  planSnapshot: Prisma.InputJsonValue;
  quantity: number;
  unitPrice: number;
  finalPrice: number;
}

interface ClassCheckoutItem {
  planId: string; // ID of the ClassPlan
  quantity: number;
  // specificInstanceId could be relevant if classes have multiple cohorts/instances not tied to appointments
  specificInstanceId?: string; 
}

interface ClassCheckoutRequestBody {
  items: ClassCheckoutItem[];
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

    const body: ClassCheckoutRequestBody = await req.json();
    const { items, paymentGateway, discountCode: _discountCodeString } = body;

    if (!items || items.length === 0) {
      return NextResponse.json({ error: 'No items provided for checkout.' }, { status: 400 });
    }

    for (const item of items) {
      if (!item.planId || item.quantity <= 0) {
        return NextResponse.json({ error: 'Invalid item data for class.' }, { status: 400 });
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

      for (const item of items) {
        const classPlan: ClassPlan | null = await tx.classPlan.findUnique({ where: { id: item.planId } });
        if (!classPlan || typeof classPlan.price !== 'number') {
          throw new Error(`ClassPlan with ID ${item.planId} not found or price is invalid.`);
        }
        const unitPrice = classPlan.price;
        const planTitle = classPlan.title;
        const planSnapshot = { ...classPlan } as Prisma.InputJsonValue;

        totalAmount += unitPrice * item.quantity;
        orderItemsData.push({
          productType: ProductType.CLASS,
          planId: item.planId,
          planTitle,
          planSnapshot,
          quantity: item.quantity,
          unitPrice,
          finalPrice: unitPrice * item.quantity,
        });
      }

      const finalAmount = totalAmount - calculatedDiscountAmount;

      const order = await tx.order.create({
        data: {
          userId,
          totalAmount,
          discountAmount: calculatedDiscountAmount,
          finalAmount,
          currency: 'INR',
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
        // TODO: Implement Class-specific registration logic here
        // e.g., create ClassRegistration record, link to order item/order.
      }

      let paymentIntentClientSecret: string | null = null;
      let paymentIntentId: string | null = null;

      if (finalAmount > 0) {
        // TODO: Implement actual payment gateway integration
        if (paymentGateway === PaymentGateway.STRIPE) {
          console.warn('Stripe payment gateway not fully implemented for classes.');
          paymentIntentId = `pi_stripe_placeholder_class_${order.id}`;
          paymentIntentClientSecret = `stripe_cs_placeholder_class_${order.id}`;
        } else if (paymentGateway === PaymentGateway.RAZORPAY) {
          console.warn('Razorpay payment gateway not fully implemented for classes.');
          paymentIntentId = `pi_razorpay_placeholder_class_${order.id}`;
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
          },
        });

        await tx.order.update({
          where: { id: order.id },
          data: { primaryPaymentIntentId: paymentIntentId },
        });
      }
      
      if (finalAmount === 0) {
        // TODO: Update ClassRegistration status to CONFIRMED for free items
      }

      return { orderId: order.id, clientSecret: paymentIntentClientSecret, needsPayment: finalAmount > 0 };
    });

    return NextResponse.json(result);

  } catch (error: unknown) {
    console.error('Class Checkout API error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred.';
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        return NextResponse.json({ error: 'Database error during class checkout.', details: error.message }, { status: 500 });
    } else if (error instanceof Error) {
        return NextResponse.json({ error: 'Class checkout failed due to an error.', details: error.message }, { status: 500 });
    }
    if (errorMessage.includes('User not found')) {
      return NextResponse.json({ error: 'User validation failed.' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Class checkout failed', details: errorMessage }, { status: 500 });
  }
}

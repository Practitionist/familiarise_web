import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  PaymentStatus,
  RequestStatus,
  WebinarStatus,
  ClassStatus,
} from "@prisma/client";
import Stripe from "stripe";
import { stripeClient, verifyRazorpayWebhook } from "@/lib/payment";

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type");
    const userAgent = req.headers.get("user-agent");

    // Determine payment gateway based on headers
    let paymentGateway: "STRIPE" | "RAZORPAY" | null = null;

    if (userAgent?.includes("Stripe")) {
      paymentGateway = "STRIPE";
    } else if (req.headers.get("x-razorpay-signature")) {
      paymentGateway = "RAZORPAY";
    }

    if (!paymentGateway) {
      return NextResponse.json(
        { error: "Unknown payment gateway" },
        { status: 400 },
      );
    }

    const body = await req.text();

    // Handle different payment gateways
    switch (paymentGateway) {
      case "STRIPE":
        return await handleStripeWebhook(req, body);
      case "RAZORPAY":
        return await handleRazorpayWebhook(req, body);
      default:
        return NextResponse.json(
          { error: "Unsupported payment gateway" },
          { status: 400 },
        );
    }
  } catch (error) {
    console.error("Webhook error:", error);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }
}

async function handleStripeWebhook(req: NextRequest, body: string) {
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "No Stripe signature found" },
      { status: 400 },
    );
  }

  try {
    // Use official Stripe webhook verification
    const event = stripeClient.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );

    console.log(`[Stripe Webhook] Received event: ${event.type}`);

    // Handle events according to official Stripe documentation
    switch (event.type) {
      case "payment_intent.succeeded":
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        console.log(`[Stripe] Payment succeeded: ${paymentIntent.id}`);
        await handlePaymentSuccess(
          paymentIntent.id,
          paymentIntent.receipt_email || undefined,
        );
        break;

      case "payment_intent.payment_failed":
        const failedPaymentIntent = event.data.object as Stripe.PaymentIntent;
        console.log(`[Stripe] Payment failed: ${failedPaymentIntent.id}`);
        await handlePaymentFailure(failedPaymentIntent.id);
        break;

      case "payment_intent.created":
      case "payment_intent.requires_action":
        // Log but don't process these intermediate states
        console.log(
          `[Stripe] Intermediate event ${event.type} for ${event.data.object.id}`,
        );
        break;

      default:
        console.log(`[Stripe] Unhandled event type: ${event.type}`);
        break;
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("[Stripe Webhook] Verification failed:", error);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }
}

async function handleRazorpayWebhook(req: NextRequest, body: string) {
  const signature = req.headers.get("x-razorpay-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "No Razorpay signature found" },
      { status: 400 },
    );
  }

  try {
    const isValid = verifyRazorpayWebhook(
      body,
      signature,
      process.env.RAZORPAY_WEBHOOK_SECRET!,
    );

    if (!isValid) {
      return NextResponse.json(
        { error: "Invalid Razorpay signature" },
        { status: 400 },
      );
    }

    const event = JSON.parse(body);
    console.log(`[Razorpay Webhook] Received event: ${event.event}`);

    // Handle different Razorpay event types according to official documentation
    switch (event.event) {
      case "payment.captured":
        const capturedPayment = event.payload.payment.entity;
        console.log(
          `[Razorpay] Payment captured: ${capturedPayment.id} for order: ${capturedPayment.order_id}`,
        );
        // Use order_id as payment intent for Razorpay (this is what we store in our Payment table)
        await handlePaymentSuccess(
          capturedPayment.order_id,
          capturedPayment.email,
        );
        break;

      case "order.paid":
        const paidOrder = event.payload.order.entity;
        const paidPayment = event.payload.payment?.entity;
        console.log(`[Razorpay] Order paid: ${paidOrder.id}`);
        // Use order_id for order.paid events
        await handlePaymentSuccess(paidOrder.id, paidPayment?.email);
        break;

      case "payment.failed":
        const failedPayment = event.payload.payment.entity;
        console.log(
          `[Razorpay] Payment failed: ${failedPayment.id} for order: ${failedPayment.order_id}`,
        );
        await handlePaymentFailure(failedPayment.order_id);
        break;

      case "payment.authorized":
        // Payment authorized but not captured yet - just log
        console.log(
          `[Razorpay] Payment authorized: ${event.payload.payment.entity.id}`,
        );
        break;

      default:
        console.log(`[Razorpay] Unhandled event type: ${event.event}`);
        break;
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Razorpay webhook error:", error);
    return NextResponse.json(
      { error: "Razorpay webhook failed" },
      { status: 400 },
    );
  }
}

async function handlePaymentSuccess(
  paymentIntentId: string,
  receiptEmail?: string,
) {
  await prisma.$transaction(async (tx) => {
    // Find and update payment
    const payment = await tx.payment.findFirst({
      where: { paymentIntent: paymentIntentId },
      include: {
        appointment: {
          include: {
            consultation: true,
            subscription: true,
            webinar: true,
            class: true,
          },
        },
      },
    });

    if (!payment) {
      throw new Error("Payment not found");
    }

    // Update payment status
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        paymentStatus: PaymentStatus.SUCCEEDED,
        receiptUrl: receiptEmail ? `receipt_${receiptEmail}` : undefined,
      },
    });

    // Make slots non-tentative
    await tx.slotOfAppointment.updateMany({
      where: { appointmentId: payment.appointmentId },
      data: { isTentative: false },
    });

    // Update appointment status based on type
    const appointment = payment.appointment;

    if (appointment.consultation) {
      await tx.consultation.update({
        where: { id: appointment.consultation.id },
        data: { requestStatus: RequestStatus.APPROVED },
      });
    }

    if (appointment.subscription) {
      await tx.subscription.update({
        where: { id: appointment.subscription.id },
        data: { requestStatus: RequestStatus.APPROVED },
      });
    }

    if (appointment.webinar) {
      await tx.webinar.update({
        where: { id: appointment.webinar.id },
        data: { status: WebinarStatus.SCHEDULED },
      });
    }

    if (appointment.class) {
      await tx.class.update({
        where: { id: appointment.class.id },
        data: { status: ClassStatus.SCHEDULED },
      });
    }
  });
}

async function handlePaymentFailure(paymentIntentId: string) {
  await prisma.$transaction(async (tx) => {
    // Find and update payment
    const payment = await tx.payment.findFirst({
      where: { paymentIntent: paymentIntentId },
      include: {
        appointment: {
          include: {
            consultation: true,
            subscription: true,
            webinar: true,
            class: true,
          },
        },
      },
    });

    if (!payment) {
      console.warn(`Payment not found for intent: ${paymentIntentId}`);
      return;
    }

    // Update payment status
    await tx.payment.update({
      where: { id: payment.id },
      data: { paymentStatus: PaymentStatus.FAILED },
    });

    // Use the same rollback logic as immediate failures
    const appointment = payment.appointment;

    // Remove tentative slots for webinar/class (many-to-many relationships)
    if (appointment.webinar || appointment.class) {
      await tx.slotOfAppointment.deleteMany({
        where: {
          appointmentId: payment.appointmentId,
          isTentative: true,
        },
      });
    } else {
      // For consultation/subscription, delete the entire appointment chain
      if (appointment.consultation) {
        await tx.consultation.delete({
          where: { id: appointment.consultation.id },
        });
      }

      if (appointment.subscription) {
        await tx.subscription.delete({
          where: { id: appointment.subscription.id },
        });
      }

      // Delete slots and appointment
      await tx.slotOfAppointment.deleteMany({
        where: { appointmentId: payment.appointmentId },
      });

      await tx.appointment.delete({
        where: { id: payment.appointmentId },
      });
    }

    console.log(
      `Cleaned up failed payment appointment: ${payment.appointmentId}`,
    );
  });
}

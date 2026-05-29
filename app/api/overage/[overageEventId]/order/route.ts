import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { createRazorpayOrder } from "@/lib/payments/core/razorpay";
import { PaymentStatus } from "@prisma/client";

/**
 * #775 — resume-checkout for a CHARGE_MEMBER overage side-charge.
 *
 * POST /api/overage/[overageEventId]/order
 *
 * The over-cap booking already created a PENDING side-`Payment`
 * (`parentPaymentId` = booking) + this `OverageEvent`. This route mints the
 * gateway order for the marginal (kept OUT of the booking's Serializable TX)
 * and stamps its id onto the side-Payment's `paymentIntent`, so the gateway
 * webhook (`notes.type = "overage_member"`) can settle it. Only the member who
 * owes the charge may call it.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ overageEventId: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const userId = session.user.id;
  const { overageEventId } = await params;

  const event = await prisma.overageEvent.findUnique({
    where: { id: overageEventId },
    select: {
      id: true,
      overageBehavior: true,
      chargeStatus: true,
      marginalPaise: true,
      currency: true,
      payment: {
        select: { id: true, userId: true, currency: true, paymentStatus: true },
      },
    },
  });

  if (!event || event.overageBehavior !== "CHARGE_MEMBER" || !event.payment) {
    return NextResponse.json({ error: "Overage charge not found" }, { status: 404 });
  }
  if (event.payment.userId !== userId) {
    // Don't leak existence to a non-owner.
    return NextResponse.json({ error: "Overage charge not found" }, { status: 404 });
  }
  if (event.payment.paymentStatus === PaymentStatus.SUCCEEDED || event.chargeStatus === "CHARGED") {
    return NextResponse.json({ error: "This overage has already been paid" }, { status: 409 });
  }
  if (event.chargeStatus === "REVERSED") {
    return NextResponse.json({ error: "This overage was reversed" }, { status: 409 });
  }
  if (event.marginalPaise <= 0) {
    return NextResponse.json({ error: "Nothing to pay" }, { status: 400 });
  }

  const order = await createRazorpayOrder({
    amount: event.marginalPaise,
    currency: event.payment.currency,
    paymentGateway: "RAZORPAY",
    metadata: {
      // appointmentId/appointmentType are required by the shared order-metadata
      // type but unused on this path — the webhook routes on `type` before any
      // appointment-metadata validation.
      appointmentId: "",
      appointmentType: "",
      type: "overage_member",
      overageEventId: event.id,
      sidePaymentId: event.payment.id,
    },
  });

  // Stamp the real gateway order onto the side-Payment so the webhook can find
  // it; reset to PENDING if a prior attempt FAILED.
  await prisma.payment.update({
    where: { id: event.payment.id },
    data: { paymentIntent: order.id, paymentStatus: PaymentStatus.PENDING },
  });
  await prisma.overageEvent.update({
    where: { id: event.id },
    data: { chargeStatus: "PENDING" },
  });

  return NextResponse.json({
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: process.env.RAZORPAY_KEY_ID ?? null,
  });
}

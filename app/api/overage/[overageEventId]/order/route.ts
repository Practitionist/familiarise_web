import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { createRazorpayOrder } from "@/lib/payments/core/razorpay";
import { PaymentStatus } from "@prisma/client";
import { transitionOverage } from "@/lib/payments/billing/overage-transitions";
import { recarveOverageBase } from "@/lib/payments/billing/overage-base-carve";

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

  // Retry edge BEFORE minting the order: a FAILED charge had its basePaise
  // restored to the org's parent accrual (#812 §P0), so resuming must carve it
  // back out atomically with the FAILED→PENDING flip — otherwise the member's
  // payment double-collects with the org's invoice. If the parent was already
  // rolled onto an invoice while FAILED, the retry is refused (the org has
  // been billed for the base; collecting it from the member too is wrong).
  // No-op when already PENDING (still carved). If the mint below fails after
  // this commits, the event sits PENDING/recarved until the abandoned-sweep
  // re-FAILs it and restores — self-healing.
  const retryBlocked = await prisma.$transaction(async (tx) => {
    const moved = await transitionOverage(tx, { id: event.id }, "PENDING");
    if (moved === 0) return false;
    const recarve = await recarveOverageBase(tx, { overageEventId: event.id });
    if (recarve === "invoiced") {
      throw Object.assign(new Error("OVERAGE_RETRY_AFTER_INVOICE"), {
        httpStatus: 409,
      });
    }
    return false;
  }).catch((err) => {
    if (err instanceof Error && "httpStatus" in err) return true;
    throw err;
  });
  if (retryBlocked) {
    return NextResponse.json(
      {
        error:
          "This charge can no longer be paid — your organization has already been billed for it. Contact support if you believe this is wrong.",
      },
      { status: 409 },
    );
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

  return NextResponse.json({
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: process.env.RAZORPAY_KEY_ID ?? null,
  });
}

/**
 * POST /api/checkout/verify-signature
 *
 * H2 FIX: Server-side verification of Razorpay payment signature.
 * Verifies HMAC-SHA256(order_id|payment_id, RAZORPAY_SECRET) returned by
 * the Razorpay checkout modal, providing defense-in-depth alongside webhooks
 * and enabling instant UI feedback without waiting for the webhook.
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { z } from "zod";

const verifySignatureSchema = z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      verifySignatureSchema.parse(body);

    const keySecret = process.env.RAZORPAY_SECRET;
    if (!keySecret) {
      console.error("RAZORPAY_SECRET not configured for signature verification");
      return NextResponse.json(
        { error: "Payment verification unavailable" },
        { status: 500 },
      );
    }

    // Verify: HMAC-SHA256(order_id + "|" + payment_id, key_secret)
    const expectedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    const sigBuf = Buffer.from(razorpay_signature, "hex");
    const expectedBuf = Buffer.from(expectedSignature, "hex");

    if (
      sigBuf.length !== expectedBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expectedBuf)
    ) {
      return NextResponse.json(
        { verified: false, error: "Invalid payment signature" },
        { status: 400 },
      );
    }

    // Signature valid — find the payment and verify ownership
    const payment = await prisma.payment.findUnique({
      where: { paymentIntent: razorpay_order_id },
    });

    if (!payment) {
      return NextResponse.json(
        { verified: false, error: "Payment not found" },
        { status: 404 },
      );
    }

    if (payment.userId !== session.user.id) {
      return NextResponse.json(
        { verified: false, error: "Unauthorized" },
        { status: 403 },
      );
    }

    // If payment is still PENDING, mark as SUCCEEDED (webhook will be idempotent)
    if (payment.paymentStatus === "PENDING") {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          paymentStatus: "SUCCEEDED",
          paymentMethod: "razorpay",
          description: `Verified via signature (payment: ${razorpay_payment_id})`,
        },
      });
      console.log(
        `✅ Payment ${payment.id} marked SUCCEEDED via signature verification (before webhook)`,
      );
    }

    return NextResponse.json({
      verified: true,
      paymentStatus: "SUCCEEDED",
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { verified: false, error: "Invalid request", details: error.errors },
        { status: 400 },
      );
    }

    console.error("Signature verification error:", error);
    return NextResponse.json(
      { verified: false, error: "Verification failed" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/organizations/[orgId]/billing-account/wallet/top-ups/[topUpId]/verify
 *
 * The client-return door for a wallet top-up. It proves the Razorpay Checkout
 * response (HMAC over `order_id|payment_id`), asks the gateway whether the
 * payment is captured, and only then runs the same `routeCapturedPayment` the
 * `payment.captured` webhook runs. `confirmTopUp` claims PENDING → CONFIRMED by
 * CAS, so whichever of this route and the webhook arrives first credits the
 * wallet and the other is a no-op.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { WalletTopUpStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { getRazorpayClient } from "@/lib/payments/core/razorpay";
import { routeCapturedPayment } from "@/app/api/webhooks/razorpay-dispatch";
import { verifyRazorpaySignature } from "@/app/api/webhooks/razorpay/signature";
import { checkoutLimiter, applyRateLimit } from "@/lib/rate-limit";

const verifyBodySchema = z.object({
  razorpay_order_id: z.string().startsWith("order_"),
  razorpay_payment_id: z.string().startsWith("pay_"),
  razorpay_signature: z
    .string()
    .length(64)
    .regex(/^[0-9a-fA-F]+$/),
});

type VerifyStatus = "pending" | "confirmed" | "failed";

function toVerifyStatus(status: WalletTopUpStatus): VerifyStatus {
  if (status === "CONFIRMED") return "confirmed";
  if (status === "FAILED") return "failed";
  return "pending";
}

/** The order id the top-up POST appended to the row's notes. */
function mintedOrderId(notes: string | null): string | null {
  return /razorpay_order=(order_\w+)/.exec(notes ?? "")?.[1] ?? null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string; topUpId: string }> },
) {
  const { orgId, topUpId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "billing.manage",
    canSponsor: true,
    requireActive: true,
  });
  if (access.error) return access.error;

  // Each call makes an outbound payments.fetch and may drive the pipeline.
  const limited = await applyRateLimit(checkoutLimiter, access.session.user.id);
  if (limited) return limited;

  const parsed = verifyBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signature,
  } = parsed.data;

  const topUp = await prisma.walletTopUp.findFirst({
    where: { providerOrderId: topUpId, billingAccount: { ownerOrgId: orgId } },
    select: { status: true, notes: true },
  });
  if (!topUp) {
    return NextResponse.json({ error: "Top-up not found" }, { status: 404 });
  }
  if (mintedOrderId(topUp.notes) !== orderId) {
    return NextResponse.json(
      { error: "This payment does not belong to this top-up" },
      { status: 400 },
    );
  }
  if (topUp.status !== "PENDING") {
    return NextResponse.json({ status: toVerifyStatus(topUp.status) });
  }

  const secret = process.env.RAZORPAY_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Payment verification unavailable" },
      { status: 503 },
    );
  }
  if (!verifyRazorpaySignature(`${orderId}|${paymentId}`, signature, secret)) {
    return NextResponse.json(
      { error: "Invalid payment signature" },
      { status: 400 },
    );
  }

  // The signature proves the id pair; capture state, amount and notes come
  // from the gateway. Any doubt answers "pending" and leaves the webhook to it.
  let notes: Record<string, string>;
  let capturedAmountPaise: number;
  try {
    const client = getRazorpayClient();
    if (!client) throw new Error("RAZORPAY_NOT_INITIALIZED");
    const gatewayPayment = await client.payments.fetch(paymentId);
    if (
      gatewayPayment.order_id !== orderId ||
      gatewayPayment.status !== "captured"
    ) {
      return NextResponse.json({ status: "pending" satisfies VerifyStatus });
    }
    notes = Object.fromEntries(
      Object.entries(gatewayPayment.notes ?? {}).map(([k, v]) => [
        k,
        String(v),
      ]),
    );
    capturedAmountPaise = Number(gatewayPayment.amount);
  } catch (fetchError) {
    Sentry.captureException(fetchError, {
      tags: { subsystem: "enterprise" },
      contexts: { topUp: { topUpId, orderId } },
    });
    return NextResponse.json({ status: "pending" satisfies VerifyStatus });
  }

  if (
    notes.type !== "credit_purchase" ||
    notes.walletEntryOrderId !== topUpId
  ) {
    return NextResponse.json(
      { error: "This payment does not belong to this top-up" },
      { status: 400 },
    );
  }

  try {
    await routeCapturedPayment({
      orderId,
      notes,
      amountPaise: capturedAmountPaise,
      gatewayPaymentId: paymentId,
    });
  } catch (err) {
    // The webhook redelivery and the orphaned-capture sweep still own it.
    Sentry.captureException(err, {
      tags: { subsystem: "enterprise" },
      contexts: { topUp: { topUpId, orderId } },
    });
    return NextResponse.json({ status: "pending" satisfies VerifyStatus });
  }

  const settled = await prisma.walletTopUp.findFirst({
    where: { providerOrderId: topUpId, billingAccount: { ownerOrgId: orgId } },
    select: { status: true },
  });
  return NextResponse.json({
    status: settled ? toVerifyStatus(settled.status) : "pending",
  });
}

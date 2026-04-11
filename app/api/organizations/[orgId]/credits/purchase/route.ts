/**
 * Initiate a SEAT_PACK credit purchase.
 *
 * POST — ORG_OWNER. Creates a pending OrgCreditPurchase row and (in Phase J)
 * returns a gateway intent the client SDK can complete. The webhook handler
 * — also added in Phase J — flips the purchase to confirmed, increments
 * OrgCreditPool.balance, and writes a ledger row.
 *
 * For now we 200 with `pendingPhaseJ` so the dashboard "Buy credits" button
 * has an endpoint to call without blocking on payment plumbing.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { createRazorpayOrder } from "@/lib/payments/core/razorpay";

const purchaseSchema = z.object({
  // 1 paise = 1 credit unit (per OrgCreditPool docstring).
  // No upper cap — enterprise orgs legitimately purchase large credit packs.
  // The payment gateway enforces its own transaction limits.
  amountPaise: z.number().int().positive(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_OWNER");
    if (access.error) return access.error;

    if (access.org.billingMode !== "SEAT_PACK") {
      return NextResponse.json(
        {
          error: `This operation is only valid for SEAT_PACK orgs (current mode: ${access.org.billingMode}).`,
        },
        { status: 400 },
      );
    }

    const body = await req.json();
    const parsed = purchaseSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { amountPaise } = parsed.data;

    const purchase = await prisma.orgCreditPurchase.create({
      data: {
        organizationProfileId: access.org.id,
        creditsPurchased: amountPaise,
        amountPaid: amountPaise,
        currency: "INR",
      },
    });

    // Create a Razorpay order. The webhook (payment.captured / order.paid)
    // matches by metadata.type=credit_purchase + metadata.purchaseId to
    // call purchaseCredits() and increment the pool.
    const order = await createRazorpayOrder({
      amount: amountPaise,
      currency: "INR",
      metadata: {
        appointmentId: purchase.id,
        appointmentType: "ORG_CREDIT_PURCHASE",
        orgId,
        purchaseId: purchase.id,
        orgProfileId: access.org.id,
        type: "credit_purchase",
      },
      paymentGateway: "RAZORPAY",
    });

    return NextResponse.json(
      {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        purchaseId: purchase.id,
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error(
      "[API /organizations/[orgId]/credits/purchase POST] error:",
      error,
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to initiate credit purchase",
      },
      { status: 500 },
    );
  }
}

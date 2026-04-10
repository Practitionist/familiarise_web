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

const purchaseSchema = z.object({
  amountPaise: z.number().int().positive(),
  // 1 paise = 1 credit unit (per OrgCreditPool docstring)
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

    return NextResponse.json(
      {
        pendingPhaseJ: true,
        purchase,
        message:
          "Gateway checkout for credit packs ships in Phase J (org-credits service).",
      },
      { status: 201 },
    );
  } catch (error) {
    console.error(
      "[API /organizations/[orgId]/credits/purchase POST] error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to initiate credit purchase" },
      { status: 500 },
    );
  }
}

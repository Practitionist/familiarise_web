/**
 * SEAT_PACK credit purchase history.
 *
 * GET — ORG_MANAGER+. Lists past credit pack purchases regardless of payment
 * status. The dashboard uses this for the "Purchase history" tab on the
 * credits page.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_MANAGER");
    if (access.error) return access.error;

    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20"), 100);
    const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0"), 0);

    const [purchases, total] = await Promise.all([
      prisma.orgCreditPurchase.findMany({
        where: { organizationProfileId: access.org.id },
        include: {
          payment: {
            select: { id: true, paymentStatus: true, paymentGateway: true },
          },
        },
        orderBy: { purchasedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.orgCreditPurchase.count({
        where: { organizationProfileId: access.org.id },
      }),
    ]);

    return NextResponse.json({ purchases, total, limit, offset });
  } catch (error) {
    console.error(
      "[API /organizations/[orgId]/credits/purchases GET] error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to fetch purchases" },
      { status: 500 },
    );
  }
}

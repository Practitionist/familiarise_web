/** GET /api/digital-products/purchases/[purchaseId] — the buyer polls this after checkout. */
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ purchaseId: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const { purchaseId } = await params;
  const purchase = await prisma.digitalProductPurchase.findFirst({
    where: { id: purchaseId, buyerId: auth.session.user.id },
    select: {
      id: true,
      productId: true,
      status: true,
      amountPaise: true,
      firstDownloadedAt: true,
      createdAt: true,
    },
  });
  if (!purchase) {
    return NextResponse.json({ error: "Purchase not found" }, { status: 404 });
  }
  return NextResponse.json(
    { data: purchase },
    { headers: { "Cache-Control": "no-store" } },
  );
}

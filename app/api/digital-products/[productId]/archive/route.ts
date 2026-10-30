/** POST /api/digital-products/[productId]/archive — off sale by CAS; existing buyers keep access. */
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { jsonError, requireOwnedProduct } from "@/lib/digital-products/creator";

type RouteParams = { params: Promise<{ productId: string }> };

export async function POST(_request: Request, { params }: RouteParams) {
  const { productId } = await params;
  const owned = await requireOwnedProduct(productId);
  if (!owned.ok) return owned.error;

  const archived = await prisma.digitalProduct.updateMany({
    where: { id: productId, status: { in: ["DRAFT", "PUBLISHED"] } },
    data: { status: "ARCHIVED", archivedAt: new Date() },
  });
  if (archived.count === 0) {
    return jsonError(
      409,
      "ALREADY_ARCHIVED",
      "This product is already archived",
    );
  }
  return NextResponse.json({ data: { id: productId, status: "ARCHIVED" } });
}

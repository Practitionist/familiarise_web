/** POST /api/digital-products/[productId]/assets/reorder — set file order from the given id list. */
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { reorderAssetsSchema } from "@/schemas/digital-products";
import {
  jsonError,
  parseBody,
  requireOwnedProduct,
} from "@/lib/digital-products/creator";

type RouteParams = { params: Promise<{ productId: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const { productId } = await params;
  const owned = await requireOwnedProduct(productId);
  if (!owned.ok) return owned.error;
  const body = await parseBody(request, reorderAssetsSchema);
  if (!body.ok) return body.error;
  const { assetIds } = body.data;

  const known = await prisma.digitalProductAsset.count({
    where: { productId, id: { in: assetIds } },
  });
  if (known !== assetIds.length) {
    return jsonError(
      400,
      "UNKNOWN_ASSET",
      "Every id must be a file of this product",
    );
  }
  await prisma.$transaction(async (tx) => {
    for (const [order, id] of assetIds.entries()) {
      await tx.digitalProductAsset.updateMany({
        where: { id, productId },
        data: { order },
      });
    }
  });
  return NextResponse.json({ data: { assetIds } });
}

/** POST /api/digital-products/[productId]/publish — DRAFT or ARCHIVED to PUBLISHED, by CAS. */
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { jsonError, requireOwnedProduct } from "@/lib/digital-products/creator";

type RouteParams = { params: Promise<{ productId: string }> };

export async function POST(_request: Request, { params }: RouteParams) {
  const { productId } = await params;
  const owned = await requireOwnedProduct(productId);
  if (!owned.ok) return owned.error;
  if (owned.product.takenDownAt) {
    return jsonError(409, "TAKEN_DOWN", "This product was taken down");
  }

  const published = await prisma.digitalProduct.updateMany({
    where: {
      id: productId,
      status: { in: ["DRAFT", "ARCHIVED"] },
      takenDownAt: null,
      assets: { some: { status: "VERIFIED" } },
    },
    data: { status: "PUBLISHED", publishedAt: new Date(), archivedAt: null },
  });
  if (published.count === 0) {
    return owned.product.status === "PUBLISHED"
      ? jsonError(409, "ALREADY_PUBLISHED", "This product is already live")
      : jsonError(
          409,
          "NO_VERIFIED_FILE",
          "Upload at least one file that passes verification first",
        );
  }
  return NextResponse.json({ data: { id: productId, status: "PUBLISHED" } });
}

/**
 * DELETE /api/digital-products/[productId]/assets/[assetId] — remove a file.
 * A verified file is superseded (object kept 30 days); an unverified one is deleted outright.
 */
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { deleteR2Object } from "@/lib/storage/r2-client";
import { jsonError, requireOwnedProduct } from "@/lib/digital-products/creator";
import { digitalProductsBucket } from "@/lib/digital-products/storage";

type RouteParams = { params: Promise<{ productId: string; assetId: string }> };

export async function DELETE(_request: Request, { params }: RouteParams) {
  const { productId, assetId } = await params;
  const owned = await requireOwnedProduct(productId);
  if (!owned.ok) return owned.error;

  const asset = await prisma.digitalProductAsset.findFirst({
    where: { id: assetId, productId },
    select: { id: true, status: true, storageKey: true },
  });
  if (!asset) return jsonError(404, "NOT_FOUND", "File not found");

  if (asset.status === "PENDING" || asset.status === "REJECTED") {
    await deleteR2Object({
      key: asset.storageKey,
      bucket: digitalProductsBucket(),
    });
    await prisma.digitalProductAsset.deleteMany({
      where: { id: asset.id, status: asset.status },
    });
    return NextResponse.json({ data: { id: asset.id, deleted: true } });
  }
  if (asset.status !== "VERIFIED") {
    return NextResponse.json({ data: { id: asset.id, status: asset.status } });
  }

  // A live product keeps at least one file; archive it to empty it.
  const superseded = await prisma.$transaction(async (tx) => {
    const others = await tx.digitalProductAsset.count({
      where: { productId, status: "VERIFIED", id: { not: asset.id } },
    });
    if (owned.product.status === "PUBLISHED" && others === 0) return null;
    return tx.digitalProductAsset.updateMany({
      where: { id: asset.id, status: "VERIFIED" },
      data: { status: "SUPERSEDED", supersededAt: new Date() },
    });
  });
  if (!superseded) {
    return jsonError(
      409,
      "LAST_FILE",
      "A published product needs at least one file; archive it first",
    );
  }
  return NextResponse.json({ data: { id: asset.id, status: "SUPERSEDED" } });
}

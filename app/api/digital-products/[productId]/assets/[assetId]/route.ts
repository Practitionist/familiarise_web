/**
 * DELETE /api/digital-products/[productId]/assets/[assetId] — remove a file.
 * A verified file is superseded (object kept 30 days) and its in-flight
 * replacements are rejected; an unverified one is deleted outright.
 */
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { deleteR2Object } from "@/lib/storage/r2-client";
import { jsonError, requireOwnedProduct } from "@/lib/digital-products/creator";
import { digitalProductsBucket } from "@/lib/digital-products/storage";
import { lockDigitalProductRow } from "@/lib/digital-products/product-lock";

type RouteParams = { params: Promise<{ productId: string; assetId: string }> };

export async function DELETE(_request: Request, { params }: RouteParams) {
  const { productId, assetId } = await params;
  const owned = await requireOwnedProduct(productId);
  if (!owned.ok) return owned.error;

  const asset = await prisma.digitalProductAsset.findFirst({
    where: { id: assetId, productId },
    select: { id: true, status: true, storageKey: true, lineageId: true },
  });
  if (!asset) return jsonError(404, "NOT_FOUND", "File not found");

  if (asset.status === "PENDING" || asset.status === "REJECTED") {
    // Retire a PENDING row before touching R2, so a racing commit cannot verify it afterwards.
    if (asset.status === "PENDING") {
      const retired = await prisma.digitalProductAsset.updateMany({
        where: { id: asset.id, status: "PENDING" },
        data: { status: "REJECTED", rejectReason: "REMOVED" },
      });
      if (retired.count === 0) {
        const now = await prisma.digitalProductAsset.findUnique({
          where: { id: asset.id },
          select: { status: true },
        });
        if (now?.status !== "REJECTED") {
          return NextResponse.json({
            data: { id: asset.id, status: now?.status ?? "REJECTED" },
          });
        }
      }
    }
    const removed = await deleteR2Object({
      key: asset.storageKey,
      bucket: digitalProductsBucket(),
    });
    // The row names the key until the object is gone; the storage sweep retries a failure.
    if (!removed.success) {
      return NextResponse.json({ data: { id: asset.id, status: "REJECTED" } });
    }
    await prisma.digitalProductAsset.deleteMany({
      where: { id: asset.id, status: "REJECTED" },
    });
    return NextResponse.json({ data: { id: asset.id, deleted: true } });
  }
  if (asset.status !== "VERIFIED") {
    return NextResponse.json({ data: { id: asset.id, status: asset.status } });
  }

  // A live product keeps at least one file; archive it to empty it.
  const removed = await prisma.$transaction(async (tx) => {
    await lockDigitalProductRow(tx, productId);
    const current = await tx.digitalProduct.findUnique({
      where: { id: productId },
      select: { status: true },
    });
    const others = await tx.digitalProductAsset.count({
      where: { productId, status: "VERIFIED", id: { not: asset.id } },
    });
    if (current?.status === "PUBLISHED" && others === 0) return null;
    const superseded = await tx.digitalProductAsset.updateMany({
      where: { id: asset.id, status: "VERIFIED" },
      data: { status: "SUPERSEDED", supersededAt: new Date() },
    });
    if (superseded.count === 0) return { retired: [] };
    // Retire in-flight replacements before any R2 delete, so none becomes current later.
    const pending = await tx.digitalProductAsset.findMany({
      where: { lineageId: asset.lineageId, status: "PENDING" },
      select: { id: true, storageKey: true },
    });
    await tx.digitalProductAsset.updateMany({
      where: { id: { in: pending.map((p) => p.id) }, status: "PENDING" },
      data: { status: "REJECTED", rejectReason: "LINEAGE_DELETED" },
    });
    return { retired: pending };
  });
  if (!removed) {
    return jsonError(
      409,
      "LAST_FILE",
      "A published product needs at least one file; archive it first",
    );
  }
  // A failed delete leaves the REJECTED row naming its key for the storage sweep.
  const bucket = digitalProductsBucket();
  const results = await Promise.all(
    removed.retired.map((p) =>
      deleteR2Object({ key: p.storageKey, bucket }).catch(() => ({
        success: false,
      })),
    ),
  );
  const clearedIds = removed.retired
    .filter((_, i) => results[i].success)
    .map((p) => p.id);
  if (clearedIds.length > 0) {
    await prisma.digitalProductAsset.deleteMany({
      where: { id: { in: clearedIds }, status: "REJECTED" },
    });
  }
  return NextResponse.json({ data: { id: asset.id, status: "SUPERSEDED" } });
}

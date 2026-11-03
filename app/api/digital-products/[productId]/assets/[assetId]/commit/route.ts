/**
 * POST /api/digital-products/[productId]/assets/[assetId]/commit — verify an
 * uploaded file: VERIFIED, or REJECTED with its object deleted.
 */
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { applyRateLimit, digitalProductUploadLimiter } from "@/lib/rate-limit";
import { jsonError, requireOwnedProduct } from "@/lib/digital-products/creator";
import { verifyDigitalProductAsset } from "@/lib/digital-products/verify-asset";

type RouteParams = { params: Promise<{ productId: string; assetId: string }> };

export async function POST(_request: Request, { params }: RouteParams) {
  const { productId, assetId } = await params;
  const owned = await requireOwnedProduct(productId);
  if (!owned.ok) return owned.error;
  const limited = await applyRateLimit(
    digitalProductUploadLimiter,
    owned.userId,
  );
  if (limited) return limited;

  const asset = await prisma.digitalProductAsset.findFirst({
    where: { id: assetId, productId },
    select: {
      id: true,
      productId: true,
      lineageId: true,
      version: true,
      storageKey: true,
      mimeType: true,
      sizeBytes: true,
      status: true,
      rejectReason: true,
    },
  });
  // Removing a file discards its in-flight replacements, rows included.
  if (!asset) {
    return jsonError(
      404,
      "UPLOAD_DISCARDED",
      "This upload was discarded, usually because the file it was replacing was removed. Add it again as a new file if you still need it.",
    );
  }
  if (asset.status !== "PENDING") {
    return NextResponse.json({
      data: { id: asset.id, status: asset.status, reason: asset.rejectReason },
    });
  }

  const result = await verifyDigitalProductAsset(asset);
  if (result.status === "MISSING") {
    return jsonError(
      409,
      "UPLOAD_NOT_FOUND",
      "The upload has not finished yet",
    );
  }
  if (result.status === "CHANGED") {
    return jsonError(
      409,
      "UPLOAD_CHANGED",
      "The file changed while it was checked; try again",
    );
  }
  const settled = await prisma.digitalProductAsset.findUnique({
    where: { id: asset.id },
    select: { id: true, status: true, rejectReason: true },
  });
  return NextResponse.json({
    data: {
      id: asset.id,
      status: settled?.status ?? result.status,
      reason: settled?.rejectReason ?? null,
    },
  });
}

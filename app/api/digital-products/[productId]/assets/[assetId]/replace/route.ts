/**
 * POST /api/digital-products/[productId]/assets/[assetId]/replace — presign a
 * new version of a verified file. Its commit supersedes the old version,
 * whose object is kept 30 days; buyers always get the latest.
 */
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { applyRateLimit, digitalProductUploadLimiter } from "@/lib/rate-limit";
import { assetUploadRequestSchema } from "@/schemas/digital-products";
import {
  checkUploadFits,
  createPendingAsset,
  jsonError,
  parseBody,
  requireOwnedProduct,
  UPLOAD_REFUSAL_MESSAGES,
} from "@/lib/digital-products/creator";

type RouteParams = { params: Promise<{ productId: string; assetId: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const { productId, assetId } = await params;
  const owned = await requireOwnedProduct(productId);
  if (!owned.ok) return owned.error;
  const limited = await applyRateLimit(
    digitalProductUploadLimiter,
    owned.userId,
  );
  if (limited) return limited;
  if (owned.product.takenDownAt) {
    return jsonError(409, "TAKEN_DOWN", "This product was taken down");
  }
  const body = await parseBody(request, assetUploadRequestSchema);
  if (!body.ok) return body.error;

  const current = await prisma.digitalProductAsset.findFirst({
    where: { id: assetId, productId, status: "VERIFIED" },
    select: {
      id: true,
      storageKey: true,
      version: true,
      order: true,
      sizeBytes: true,
    },
  });
  if (!current) return jsonError(404, "NOT_FOUND", "Verified file not found");

  const refusal = await checkUploadFits({
    product: owned.product,
    mimeType: body.data.mimeType,
    sizeBytes: body.data.sizeBytes,
    replacing: current,
  });
  if (refusal) return jsonError(409, refusal, UPLOAD_REFUSAL_MESSAGES[refusal]);

  try {
    const upload = await createPendingAsset({
      productId,
      fileName: body.data.fileName,
      mimeType: body.data.mimeType,
      sizeBytes: body.data.sizeBytes,
      order: current.order,
      replaces: current,
    });
    return NextResponse.json({ data: upload }, { status: 201 });
  } catch (error) {
    // The next version's key is unique, so a racing replacement loses here.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return jsonError(
        409,
        "REPLACEMENT_IN_PROGRESS",
        "A replacement is already uploading",
      );
    }
    throw error;
  }
}

/**
 * POST /api/digital-products/[productId]/assets/upload-url — reserve a PENDING
 * file and presign the browser's PUT to R2; the commit route verifies it.
 */
import { NextResponse } from "next/server";
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

type RouteParams = { params: Promise<{ productId: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const { productId } = await params;
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

  const refusal = await checkUploadFits({
    product: owned.product,
    mimeType: body.data.mimeType,
    sizeBytes: body.data.sizeBytes,
  });
  if (refusal) return jsonError(409, refusal, UPLOAD_REFUSAL_MESSAGES[refusal]);

  const last = await prisma.digitalProductAsset.findFirst({
    where: { productId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const upload = await createPendingAsset({
    productId,
    fileName: body.data.fileName,
    mimeType: body.data.mimeType,
    sizeBytes: body.data.sizeBytes,
    order: (last?.order ?? -1) + 1,
  });
  return NextResponse.json({ data: upload }, { status: 201 });
}

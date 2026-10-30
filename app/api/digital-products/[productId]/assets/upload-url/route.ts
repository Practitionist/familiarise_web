/**
 * POST /api/digital-products/[productId]/assets/upload-url — reserve a PENDING
 * file and presign the browser's PUT to R2; the commit route verifies it.
 */
import { NextResponse } from "next/server";
import { applyRateLimit, digitalProductUploadLimiter } from "@/lib/rate-limit";
import { assetUploadRequestSchema } from "@/schemas/digital-products";
import {
  jsonError,
  parseBody,
  requireOwnedProduct,
  reservePendingAsset,
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

  const reserved = await reservePendingAsset({
    product: owned.product,
    fileName: body.data.fileName,
    mimeType: body.data.mimeType,
    sizeBytes: body.data.sizeBytes,
  });
  if (!reserved.ok) {
    return jsonError(
      409,
      reserved.refusal,
      UPLOAD_REFUSAL_MESSAGES[reserved.refusal],
    );
  }
  return NextResponse.json({ data: reserved.upload }, { status: 201 });
}

/**
 * POST /api/digital-products/[productId]/assets/[assetId]/replace — presign a
 * new version of a verified file. Its commit supersedes the older versions,
 * whose objects are kept 30 days; buyers always get the latest.
 */
import { NextResponse } from "next/server";
import { applyRateLimit, digitalProductUploadLimiter } from "@/lib/rate-limit";
import { assetUploadRequestSchema } from "@/schemas/digital-products";
import {
  jsonError,
  parseBody,
  requireOwnedProduct,
  reservePendingAsset,
  uploadRefusalResponse,
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

  const reserved = await reservePendingAsset({
    product: owned.product,
    fileName: body.data.fileName,
    mimeType: body.data.mimeType,
    sizeBytes: body.data.sizeBytes,
    replacesAssetId: assetId,
  });
  if (!reserved.ok) return uploadRefusalResponse(reserved);
  return NextResponse.json({ data: reserved.upload }, { status: 201 });
}

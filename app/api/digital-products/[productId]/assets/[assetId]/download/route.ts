/**
 * GET /api/digital-products/[productId]/assets/[assetId]/download — redirect
 * an entitled buyer (or the owner, or an operator) to a 300 s presigned R2
 * GET. A buyer's first download ends the no-questions refund window.
 */
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { isPrivileged, requireApiAuth } from "@/lib/auth-helpers";
import {
  applyRateLimit,
  digitalProductDownloadLimiter,
} from "@/lib/rate-limit";
import { createR2PresignedGetUrl } from "@/lib/storage/r2-client";
import { DIGITAL_PRODUCT_DOWNLOAD_URL_TTL_SECONDS } from "@/lib/digital-products/constants";
import {
  attachmentDisposition,
  digitalProductsBucket,
} from "@/lib/digital-products/storage";

type RouteParams = { params: Promise<{ productId: string; assetId: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const user = auth.session.user;
  const limited = await applyRateLimit(digitalProductDownloadLimiter, user.id);
  if (limited) return limited;

  const { productId, assetId } = await params;
  const asset = await prisma.digitalProductAsset.findFirst({
    where: { id: assetId, productId, status: "VERIFIED" },
    select: {
      id: true,
      storageKey: true,
      originalName: true,
      product: { select: { consultantProfileId: true, takenDownAt: true } },
    },
  });
  if (!asset) {
    return NextResponse.json(
      { error: "File not found", code: "NOT_FOUND" },
      { status: 404 },
    );
  }
  const operator = isPrivileged(user.role);
  if (asset.product.takenDownAt && !operator) {
    return NextResponse.json(
      { error: "This product was taken down", code: "TAKEN_DOWN" },
      { status: 410 },
    );
  }

  const isOwner =
    Boolean(user.consultantProfileId) &&
    user.consultantProfileId === asset.product.consultantProfileId;
  if (!isOwner && !operator) {
    const recorded = await prisma.$transaction(async (tx) => {
      // Lock the live purchase: a refund committed first leaves no SUCCEEDED row to lock.
      const [entitlement] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "DigitalProductPurchase"
        WHERE "productId" = ${productId} AND "buyerId" = ${user.id}
          AND status = 'SUCCEEDED'
        FOR UPDATE`;
      if (!entitlement) return false;
      // CAS: only the first download stamps the refund-window end.
      await tx.digitalProductPurchase.updateMany({
        where: {
          id: entitlement.id,
          status: "SUCCEEDED",
          firstDownloadedAt: null,
        },
        data: { firstDownloadedAt: new Date() },
      });
      await tx.digitalProductDownload.create({
        data: { purchaseId: entitlement.id, assetId: asset.id },
      });
      return true;
    });
    if (!recorded) {
      return NextResponse.json(
        { error: "You do not own this product", code: "NOT_ENTITLED" },
        { status: 403 },
      );
    }
  }

  const url = createR2PresignedGetUrl({
    key: asset.storageKey,
    bucket: digitalProductsBucket(),
    expiresInSeconds: DIGITAL_PRODUCT_DOWNLOAD_URL_TTL_SECONDS,
    responseContentDisposition: attachmentDisposition(asset.originalName),
  });
  const response = NextResponse.redirect(url, 302);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

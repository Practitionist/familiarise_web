/**
 * GET /api/digital-products/[productId]/assets/[assetId]/download — redirect
 * an entitled buyer (or the owner, or an operator) to a 300 s presigned R2
 * GET. A buyer's first download ends the no-questions refund window. A link
 * to a replaced version serves its file's current one; a browser following a
 * link to a removed file is sent to the product page with a notice.
 */
import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
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
import { lineageDisplayNames } from "@/lib/digital-products/lineage";

type RouteParams = { params: Promise<{ productId: string; assetId: string }> };

const ASSET_SELECT = {
  id: true,
  lineageId: true,
  version: true,
  status: true,
  storageKey: true,
  originalName: true,
  product: { select: { consultantProfileId: true, takenDownAt: true } },
} as const satisfies Prisma.DigitalProductAssetSelect;

/** A browser navigation gets the product page with a notice; an API client keeps the JSON. */
async function fileGone(
  request: Request,
  productId: string,
  removed: boolean,
): Promise<NextResponse> {
  if (request.headers.get("accept")?.includes("text/html")) {
    const product = await prisma.digitalProduct.findUnique({
      where: { id: productId },
      select: { slug: true },
    });
    if (product) {
      const notice = removed ? "file-removed" : "file-missing";
      return NextResponse.redirect(
        new URL(
          `/explore/products/${encodeURIComponent(product.slug)}?notice=${notice}`,
          request.url,
        ),
        303,
      );
    }
  }
  return removed
    ? NextResponse.json(
        { error: "The expert removed this file", code: "FILE_REMOVED" },
        { status: 410 },
      )
    : NextResponse.json(
        { error: "File not found", code: "NOT_FOUND" },
        { status: 404 },
      );
}

export async function GET(request: Request, { params }: RouteParams) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const user = auth.session.user;
  const limited = await applyRateLimit(digitalProductDownloadLimiter, user.id);
  if (limited) return limited;

  const { productId, assetId } = await params;
  const requested = await prisma.digitalProductAsset.findFirst({
    where: { id: assetId, productId },
    select: ASSET_SELECT,
  });
  // A replaced or purged version resolves to its lineage's current one.
  const asset =
    requested?.status === "VERIFIED"
      ? requested
      : requested
        ? await prisma.digitalProductAsset.findFirst({
            where: {
              productId,
              lineageId: requested.lineageId,
              status: "VERIFIED",
            },
            select: ASSET_SELECT,
          })
        : null;
  if (!asset) {
    return fileGone(request, productId, requested?.status === "SUPERSEDED");
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

  // Saved under the name buyers see, which a replacement never changes.
  const names = await lineageDisplayNames(prisma, [asset]);
  const url = createR2PresignedGetUrl({
    key: asset.storageKey,
    bucket: digitalProductsBucket(),
    expiresInSeconds: DIGITAL_PRODUCT_DOWNLOAD_URL_TTL_SECONDS,
    responseContentDisposition: attachmentDisposition(
      names.get(asset.lineageId) ?? asset.originalName,
    ),
  });
  const response = NextResponse.redirect(url, 302);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

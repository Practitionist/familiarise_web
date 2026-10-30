/**
 * GET    /api/digital-products/[productId] — the public listing, or the owner's full view.
 * PATCH  /api/digital-products/[productId] — the owner edits the listing.
 * DELETE /api/digital-products/[productId] — the owner deletes a product nobody has bought.
 */
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireApiSession } from "@/lib/auth-helpers";
import { updateDigitalProductSchema } from "@/schemas/digital-products";
import {
  jsonError,
  parseBody,
  requireOwnedProduct,
} from "@/lib/digital-products/creator";

type RouteParams = { params: Promise<{ productId: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  const { productId } = await params;
  const auth = await requireApiSession();
  const viewerProfileId = auth.error
    ? null
    : (auth.session.user.consultantProfileId ?? null);
  const product = await prisma.digitalProduct.findUnique({
    where: { id: productId },
    select: {
      id: true,
      consultantProfileId: true,
      title: true,
      subtitle: true,
      slug: true,
      description: true,
      category: true,
      pricePaise: true,
      status: true,
      visibility: true,
      coverImagePath: true,
      previewAssetId: true,
      takenDownAt: true,
      takedownReason: true,
      publishedAt: true,
      archivedAt: true,
      assets: {
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
          order: true,
          version: true,
          status: true,
          rejectReason: true,
          verifiedAt: true,
        },
      },
    },
  });
  if (!product) return jsonError(404, "NOT_FOUND", "Product not found");

  const isOwner = viewerProfileId === product.consultantProfileId;
  if (isOwner) return NextResponse.json({ data: product });
  if (
    product.status !== "PUBLISHED" ||
    product.takenDownAt ||
    product.visibility === "ORG_ONLY"
  ) {
    return jsonError(404, "NOT_FOUND", "Product not found");
  }
  const {
    takedownReason: _reason,
    archivedAt: _archived,
    ...listing
  } = product;
  return NextResponse.json({
    data: {
      ...listing,
      assets: listing.assets
        .filter((a) => a.status === "VERIFIED")
        .map(({ id, originalName, mimeType, sizeBytes, order }) => ({
          id,
          originalName,
          mimeType,
          sizeBytes,
          order,
        })),
    },
  });
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { productId } = await params;
  const owned = await requireOwnedProduct(productId);
  if (!owned.ok) return owned.error;
  const { product } = owned;
  if (product.takenDownAt) {
    return jsonError(409, "TAKEN_DOWN", "This product was taken down");
  }
  const body = await parseBody(request, updateDigitalProductSchema);
  if (!body.ok) return body.error;
  const patch = body.data;

  if (
    patch.category &&
    patch.category !== product.category &&
    product.status !== "DRAFT"
  ) {
    return jsonError(
      409,
      "CATEGORY_LOCKED",
      "The category can change only while the product is a draft",
    );
  }
  if (patch.previewAssetId) {
    const preview = await prisma.digitalProductAsset.count({
      where: { id: patch.previewAssetId, productId, status: "VERIFIED" },
    });
    if (preview === 0) {
      return jsonError(
        400,
        "INVALID_PREVIEW",
        "Preview must be a verified file",
      );
    }
  }

  const updated = await prisma.digitalProduct.update({
    where: { id: productId },
    data: patch,
    select: { id: true, status: true, updatedAt: true },
  });
  return NextResponse.json({ data: updated });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  const { productId } = await params;
  const owned = await requireOwnedProduct(productId);
  if (!owned.ok) return owned.error;

  // A sold product is archived, never deleted: buyers keep lifetime access.
  const deleted = await prisma.digitalProduct.deleteMany({
    where: { id: productId, purchases: { none: {} } },
  });
  if (deleted.count === 0) {
    return jsonError(
      409,
      "HAS_PURCHASES",
      "This product has buyers; archive it instead",
    );
  }
  // Its objects lose their rows and the storage sweep deletes them.
  return NextResponse.json({ data: { id: productId, deleted: true } });
}

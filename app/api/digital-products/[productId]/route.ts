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
import { lockDigitalProductRow } from "@/lib/digital-products/product-lock";
import { purgeDigitalProductSurfaces } from "@/lib/data/public-cache";
import {
  categoryFileRule,
  isDigitalProductMime,
  mimeFitsCategory,
} from "@/lib/digital-products/constants";

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
      _count: { select: { purchases: true } },
    },
  });
  if (!product) return jsonError(404, "NOT_FOUND", "Product not found");

  const { _count, ...view } = product;
  const isOwner = viewerProfileId === product.consultantProfileId;
  // Any purchase row, even a failed one, keeps a product from being deleted.
  if (isOwner) {
    return NextResponse.json({
      data: { ...view, purchaseCount: _count.purchases },
    });
  }
  if (
    product.status !== "PUBLISHED" ||
    product.takenDownAt ||
    product.visibility === "ORG_ONLY"
  ) {
    return jsonError(404, "NOT_FOUND", "Product not found");
  }
  const { takedownReason: _reason, archivedAt: _archived, ...listing } = view;
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

  const newCategory =
    patch.category && patch.category !== product.category
      ? patch.category
      : null;
  if (newCategory && product.status !== "DRAFT") {
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

  const select = { id: true, status: true, updatedAt: true } as const;
  if (!newCategory) {
    const updated = await prisma.digitalProduct.update({
      where: { id: productId },
      data: patch,
      select,
    });
    // Every editable field shows on the public page; the slug never changes.
    if (updated.status === "PUBLISHED") purgeDigitalProductSurfaces(product);
    return NextResponse.json({ data: updated });
  }
  // Under the file-set lock, so the file set cannot change between the check and the write.
  const changed = await prisma.$transaction(async (tx) => {
    await lockDigitalProductRow(tx, productId);
    const current = await tx.digitalProduct.findUnique({
      where: { id: productId },
      select: { status: true },
    });
    if (current?.status !== "DRAFT") return "CATEGORY_LOCKED" as const;
    const files = await tx.digitalProductAsset.findMany({
      where: { productId, status: { in: ["PENDING", "VERIFIED"] } },
      select: { id: true, mimeType: true },
    });
    const misfits = files.filter(
      (f) =>
        !isDigitalProductMime(f.mimeType) ||
        !mimeFitsCategory(f.mimeType, newCategory),
    );
    if (misfits.length > 0) {
      return { misfitIds: misfits.map((f) => f.id) };
    }
    return tx.digitalProduct.update({
      where: { id: productId },
      data: patch,
      select,
    });
  });
  if (changed === "CATEGORY_LOCKED") {
    return jsonError(
      409,
      "CATEGORY_LOCKED",
      "The category can change only while the product is a draft",
    );
  }
  if ("misfitIds" in changed) {
    return jsonError(
      409,
      "CATEGORY_MISMATCH",
      `${categoryFileRule(newCategory)} Remove the ${changed.misfitIds.length === 1 ? "file that doesn't" : `${changed.misfitIds.length} files that don't`} fit first.`,
      { assetIds: changed.misfitIds },
    );
  }
  return NextResponse.json({ data: changed });
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

/**
 * GET    /api/digital-products/[productId] — the public listing, or the owner's full view.
 * PATCH  /api/digital-products/[productId] — the owner edits the listing.
 * DELETE /api/digital-products/[productId] — the owner deletes a product with no purchase rows at all.
 */
import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { lineageDisplayNames } from "@/lib/digital-products/lineage";
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

/** Rejected uploads the owner still sees, newest first. */
const OWNER_REJECTED_LIMIT = 10;

const OWNER_ASSET_SELECT = {
  id: true,
  lineageId: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  order: true,
  version: true,
  status: true,
  rejectReason: true,
  verifiedAt: true,
  supersededAt: true,
  createdAt: true,
} as const satisfies Prisma.DigitalProductAssetSelect;

/** Each lineage's live versions, its previous version and the latest rejected uploads. */
async function ownerAssets(productId: string) {
  const [live, previous, rejected] = await Promise.all([
    prisma.digitalProductAsset.findMany({
      where: { productId, status: { in: ["PENDING", "VERIFIED"] } },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      select: OWNER_ASSET_SELECT,
    }),
    prisma.digitalProductAsset.findMany({
      where: { productId, status: "SUPERSEDED", purgedAt: null },
      orderBy: { version: "desc" },
      distinct: ["lineageId"],
      select: OWNER_ASSET_SELECT,
    }),
    prisma.digitalProductAsset.findMany({
      where: { productId, status: "REJECTED" },
      orderBy: { createdAt: "desc" },
      take: OWNER_REJECTED_LIMIT,
      select: OWNER_ASSET_SELECT,
    }),
  ]);
  const assets = [...live, ...previous, ...rejected];
  const nameOf = await lineageDisplayNames(prisma, assets);
  return assets.map((a) => ({ ...a, displayName: nameOf(a) }));
}

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
    },
  });
  if (!product) return jsonError(404, "NOT_FOUND", "Product not found");

  if (viewerProfileId === product.consultantProfileId) {
    const [assets, sales] = await Promise.all([
      ownerAssets(productId),
      prisma.digitalProductPurchase.groupBy({
        by: ["status"],
        where: { productId, status: { in: ["SUCCEEDED", "REFUNDED"] } },
        _count: { _all: true },
      }),
    ]);
    const count = (status: string) =>
      sales.find((s) => s.status === status)?._count._all ?? 0;
    // purchaseCount counts sales and refunds; DELETE also refuses an open checkout. buyerCount holds access now.
    return NextResponse.json({
      data: {
        ...product,
        assets,
        purchaseCount: count("SUCCEEDED") + count("REFUNDED"),
        buyerCount: count("SUCCEEDED"),
      },
    });
  }
  if (
    product.status !== "PUBLISHED" ||
    product.takenDownAt ||
    product.visibility === "ORG_ONLY"
  ) {
    return jsonError(404, "NOT_FOUND", "Product not found");
  }
  const verified = await prisma.digitalProductAsset.findMany({
    where: { productId, status: "VERIFIED" },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      lineageId: true,
      version: true,
      originalName: true,
      mimeType: true,
      sizeBytes: true,
      order: true,
    },
  });
  const nameOf = await lineageDisplayNames(prisma, verified);
  const {
    takedownReason: _reason,
    archivedAt: _archived,
    ...listing
  } = product;
  return NextResponse.json({
    data: {
      ...listing,
      assets: verified.map((a) => ({
        id: a.id,
        originalName: nameOf(a),
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        order: a.order,
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

  // Product lock first, as the settle takes it before the purchase CAS.
  const refusal = await prisma.$transaction(async (tx) => {
    await lockDigitalProductRow(tx, productId);
    // A sold or refunded product is archived, never deleted: its sale rows are money evidence.
    const sold = await tx.digitalProductPurchase.findFirst({
      where: {
        productId,
        OR: [
          { status: { in: ["SUCCEEDED", "REFUNDED"] } },
          { paymentId: { not: null } },
        ],
      },
      select: { id: true },
    });
    if (sold) return "HAS_PURCHASES" as const;
    // Every other row holds a gateway order a late capture can still settle through the reconcile sweep.
    const ordered = await tx.digitalProductPurchase.findFirst({
      where: { productId },
      select: { id: true },
    });
    if (ordered) return "HAS_ORDERS" as const;
    await tx.digitalProduct.delete({ where: { id: productId } });
    return null;
  });
  if (refusal === "HAS_PURCHASES") {
    return jsonError(
      409,
      "HAS_PURCHASES",
      "This product has buyers; archive it instead",
    );
  }
  if (refusal === "HAS_ORDERS") {
    return jsonError(
      409,
      "HAS_ORDERS",
      "Someone started a checkout for this product, so it can't be deleted; archive it instead",
    );
  }
  // Its objects lose their rows and the storage sweep deletes them.
  return NextResponse.json({ data: { id: productId, deleted: true } });
}

import "server-only";

import type { DigitalProductCategory } from "@prisma/client";
import prisma from "@/lib/prisma";

/** One owned product in the buyer's library, with the files they can download now. */
export interface LibraryProduct {
  purchaseId: string;
  productId: string;
  slug: string;
  title: string;
  category: DigitalProductCategory;
  coverImagePath: string | null;
  creatorName: string | null;
  purchasedAt: Date;
  takenDown: boolean;
  /** A verified file arrived (new or a new version) after the purchase. */
  updated: boolean;
  files: {
    id: string;
    originalName: string;
    sizeBytes: number;
    updatedSincePurchase: boolean;
  }[];
}

/** Every product the user holds a SUCCEEDED purchase of, newest purchase first. */
export async function readDigitalProductLibrary(
  userId: string,
): Promise<LibraryProduct[]> {
  const purchases = await prisma.digitalProductPurchase.findMany({
    where: { buyerId: userId, status: "SUCCEEDED" },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      createdAt: true,
      product: {
        select: {
          id: true,
          slug: true,
          title: true,
          category: true,
          coverImagePath: true,
          takenDownAt: true,
          consultantProfile: { select: { user: { select: { name: true } } } },
          assets: {
            where: { status: "VERIFIED" },
            orderBy: [{ order: "asc" }, { createdAt: "asc" }],
            select: {
              id: true,
              originalName: true,
              sizeBytes: true,
              createdAt: true,
            },
          },
        },
      },
    },
  });
  return purchases.map(({ id, createdAt, product }) => {
    const files = product.assets.map((asset) => ({
      id: asset.id,
      originalName: asset.originalName,
      sizeBytes: asset.sizeBytes,
      updatedSincePurchase: asset.createdAt > createdAt,
    }));
    return {
      purchaseId: id,
      productId: product.id,
      slug: product.slug,
      title: product.title,
      category: product.category,
      coverImagePath: product.coverImagePath,
      creatorName: product.consultantProfile.user.name,
      purchasedAt: createdAt,
      takenDown: product.takenDownAt !== null,
      updated: files.some((f) => f.updatedSincePurchase),
      files,
    };
  });
}

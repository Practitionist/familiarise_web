import "server-only";

import type { DigitalProductCategory } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  readBuyerFiles,
  type BuyerFile,
  type RemovedBuyerFile,
} from "@/lib/digital-products/buyer-files";

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
  /** Claimed at ₹0: there is nothing to refund. */
  free: boolean;
  takenDown: boolean;
  /** A file is new or updated since the buyer last downloaded it. */
  updated: boolean;
  files: BuyerFile[];
  /** Files the buyer had that the creator removed. */
  removed: RemovedBuyerFile[];
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
      productId: true,
      createdAt: true,
      amountPaise: true,
      product: {
        select: {
          id: true,
          slug: true,
          title: true,
          category: true,
          coverImagePath: true,
          takenDownAt: true,
          consultantProfile: { select: { user: { select: { name: true } } } },
        },
      },
    },
  });
  const views = await readBuyerFiles(purchases);
  return purchases.map(({ id, createdAt, amountPaise, product }) => {
    const { files, removed } = views.get(id) ?? { files: [], removed: [] };
    return {
      purchaseId: id,
      productId: product.id,
      slug: product.slug,
      title: product.title,
      category: product.category,
      coverImagePath: product.coverImagePath,
      creatorName: product.consultantProfile.user.name,
      purchasedAt: createdAt,
      free: amountPaise === 0,
      takenDown: product.takenDownAt !== null,
      updated: files.some((f) => f.badge !== null),
      files,
      removed,
    };
  });
}

import "server-only";

import { cache } from "react";
import type { DigitalProductCategory, Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { digitalProductDiscoverableWhere } from "@/lib/api/plans/visibility";

/**
 * Public digital product reads for the product page and the expert profile.
 * Listing metadata and file names only: storage keys never leave the server.
 */

export interface PublicProductCard {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  category: DigitalProductCategory;
  pricePaise: number;
  coverImagePath: string | null;
  fileCount: number;
}

export interface PublicProductFile {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface PublicProduct extends PublicProductCard {
  description: string;
  publishedAt: Date | null;
  creator: {
    consultantProfileId: string;
    name: string | null;
    image: string | null;
    headline: string | null;
  };
  files: PublicProductFile[];
}

const VERIFIED = { status: "VERIFIED" } as const;

/** The expert's products on sale, newest first. */
export const getConsultantDigitalProducts = cache(
  async (consultantProfileId: string): Promise<PublicProductCard[]> => {
    const rows = await prisma.digitalProduct.findMany({
      where: { consultantProfileId, ...digitalProductDiscoverableWhere() },
      orderBy: { publishedAt: "desc" },
      take: 24,
      select: {
        id: true,
        slug: true,
        title: true,
        subtitle: true,
        category: true,
        pricePaise: true,
        coverImagePath: true,
        _count: { select: { assets: { where: VERIFIED } } },
      },
    });
    return rows.map(({ _count, ...row }) => ({
      ...row,
      fileCount: _count.assets,
    }));
  },
);

const PRODUCT_PAGE_SELECT = {
  id: true,
  slug: true,
  title: true,
  subtitle: true,
  description: true,
  category: true,
  pricePaise: true,
  coverImagePath: true,
  publishedAt: true,
  consultantProfile: {
    select: {
      id: true,
      headline: true,
      user: { select: { name: true, image: true } },
    },
  },
  assets: {
    where: VERIFIED,
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      originalName: true,
      mimeType: true,
      sizeBytes: true,
    },
  },
} as const satisfies Prisma.DigitalProductSelect;

function findProductPage(where: Prisma.DigitalProductWhereInput) {
  return prisma.digitalProduct.findFirst({
    where,
    select: PRODUCT_PAGE_SELECT,
  });
}

function toPublicProduct(
  row: NonNullable<Awaited<ReturnType<typeof findProductPage>>>,
): PublicProduct {
  const { consultantProfile, assets, ...product } = row;
  return {
    ...product,
    fileCount: assets.length,
    files: assets,
    creator: {
      consultantProfileId: consultantProfile.id,
      name: consultantProfile.user.name,
      image: consultantProfile.user.image,
      headline: consultantProfile.headline,
    },
  };
}

/** One product on sale by slug, with its creator and verified file list. */
export const getPublicDigitalProductBySlug = cache(
  async (slug: string): Promise<PublicProduct | null> => {
    const row = await findProductPage({
      slug,
      ...digitalProductDiscoverableWhere(),
    });
    return row ? toPublicProduct(row) : null;
  },
);

/**
 * A product no longer on sale, for a buyer who holds it: archived products
 * stay downloadable to their buyers. A taken-down product never loads.
 */
export const getEntitledDigitalProductBySlug = cache(
  async (slug: string, buyerId: string): Promise<PublicProduct | null> => {
    const row = await findProductPage({
      slug,
      status: { in: ["PUBLISHED", "ARCHIVED"] },
      takenDownAt: null,
      purchases: { some: { buyerId, status: "SUCCEEDED" } },
    });
    return row ? toPublicProduct(row) : null;
  },
);

/** The product page's product for this viewer: on sale, or one they hold off sale. */
export const getDigitalProductForViewer = cache(
  async (
    slug: string,
    viewerId: string | null,
  ): Promise<PublicProduct | null> =>
    (await getPublicDigitalProductBySlug(slug)) ??
    (viewerId ? await getEntitledDigitalProductBySlug(slug, viewerId) : null),
);

import "server-only";

import { cache } from "react";
import { unstable_cache } from "next/cache";
import type { DigitalProductCategory, Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { digitalProductDiscoverableWhere } from "@/lib/api/plans/visibility";
import { PUBLIC_PRODUCTS_TAG } from "@/lib/digital-products/constants";
import { lineageDisplayNames } from "@/lib/digital-products/lineage";
import {
  PRODUCTS_PER_PAGE,
  type ProductsQuery,
} from "@/lib/explore/products-query";

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

export interface PublicProductListItem extends PublicProductCard {
  creator: { consultantProfileId: string; name: string | null };
}

/** The marketplace listing: products on sale, newest first. Purged by `purgeDigitalProductSurfaces`. */
export interface PublicProductsPage {
  items: PublicProductListItem[];
  total: number;
  page: number;
  perPage: number;
}

function productOrder(
  sort: ProductsQuery["sort"],
): Prisma.DigitalProductOrderByWithRelationInput[] {
  if (sort === "price-asc") return [{ pricePaise: "asc" }, { id: "asc" }];
  if (sort === "price-desc") return [{ pricePaise: "desc" }, { id: "asc" }];
  return [{ publishedAt: "desc" }, { id: "asc" }];
}

async function fetchPublicProductsPage(
  query: ProductsQuery,
  domainId?: string,
): Promise<PublicProductsPage> {
  const where: Prisma.DigitalProductWhereInput = {
    ...digitalProductDiscoverableWhere(),
    consultantProfile: {
      deletedAt: null,
      ...(domainId ? { domainId } : {}),
    },
    ...(query.category ? { category: query.category } : {}),
    ...(query.price === "free" ? { pricePaise: 0 } : {}),
    ...(query.price === "paid" ? { pricePaise: { gt: 0 } } : {}),
    ...(query.q
      ? {
          OR: [
            { title: { contains: query.q, mode: "insensitive" } },
            { subtitle: { contains: query.q, mode: "insensitive" } },
            {
              consultantProfile: {
                user: { name: { contains: query.q, mode: "insensitive" } },
              },
            },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.digitalProduct.findMany({
      where,
      orderBy: productOrder(query.sort),
      take: PRODUCTS_PER_PAGE,
      skip: (query.page - 1) * PRODUCTS_PER_PAGE,
      select: {
        id: true,
        slug: true,
        title: true,
        subtitle: true,
        category: true,
        pricePaise: true,
        coverImagePath: true,
        _count: { select: { assets: { where: VERIFIED } } },
        consultantProfile: {
          select: { id: true, user: { select: { name: true } } },
        },
      },
    }),
    prisma.digitalProduct.count({ where }),
  ]);
  return {
    items: rows.map(({ _count, consultantProfile, ...row }) => ({
      ...row,
      fileCount: _count.assets,
      creator: {
        consultantProfileId: consultantProfile.id,
        name: consultantProfile.user.name,
      },
    })),
    total,
    page: query.page,
    perPage: PRODUCTS_PER_PAGE,
  };
}

const cachedProductsPage = unstable_cache(
  fetchPublicProductsPage,
  ["public-digital-products-page"],
  { revalidate: 300, tags: [PUBLIC_PRODUCTS_TAG] },
);

/**
 * `domainId` narrows to the products of experts in one field (a product's topic
 * is its creator's field for now). Free-text searches are not cached: every
 * distinct term would be its own entry.
 */
export function listPublicDigitalProducts(
  query: ProductsQuery,
  domainId?: string,
): Promise<PublicProductsPage> {
  return query.q
    ? fetchPublicProductsPage(query, domainId)
    : cachedProductsPage(query, domainId);
}

export interface ProductTopic {
  id: string;
  name: string;
  count: number;
}

/** Fields that have at least one product on sale, with how many, most products first. */
export const listProductTopics = unstable_cache(
  async (): Promise<ProductTopic[]> => {
    const rows = await prisma.digitalProduct.findMany({
      where: {
        ...digitalProductDiscoverableWhere(),
        consultantProfile: { deletedAt: null },
      },
      select: {
        consultantProfile: {
          select: { domain: { select: { id: true, name: true } } },
        },
      },
      take: 5_000,
    });
    const byId = new Map<string, ProductTopic>();
    for (const { consultantProfile } of rows) {
      const { domain } = consultantProfile;
      const topic = byId.get(domain.id) ?? { ...domain, count: 0 };
      topic.count += 1;
      byId.set(domain.id, topic);
    }
    return [...byId.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    );
  },
  ["public-digital-product-topics"],
  { revalidate: 300, tags: [PUBLIC_PRODUCTS_TAG] },
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
      lineageId: true,
      version: true,
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

/** File names keep each lineage's first stem, so a replacement changes at most the extension. */
async function toPublicProduct(
  row: NonNullable<Awaited<ReturnType<typeof findProductPage>>>,
): Promise<PublicProduct> {
  const { consultantProfile, assets, ...product } = row;
  const nameOf = await lineageDisplayNames(prisma, assets);
  return {
    ...product,
    fileCount: assets.length,
    files: assets.map((a) => ({
      id: a.id,
      originalName: nameOf(a),
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
    })),
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

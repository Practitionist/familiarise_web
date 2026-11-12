import { DigitalProductCategory } from "@prisma/client";
import { z } from "zod";

export const PRODUCTS_PER_PAGE = 24;
const MAX_PAGE = 500;

export const PRODUCT_SORTS = [
  "newest",
  "popular",
  "price-asc",
  "price-desc",
] as const;

/** A bad or repeated value in the URL falls back to "not set" instead of failing the page. */
const ProductsQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional().catch(undefined),
  category: z.nativeEnum(DigitalProductCategory).optional().catch(undefined),
  price: z.enum(["free", "paid"]).optional().catch(undefined),
  sort: z.enum(PRODUCT_SORTS).catch("newest"),
  page: z.coerce.number().int().min(1).max(MAX_PAGE).catch(1),
});

export type ProductsQuery = z.infer<typeof ProductsQuerySchema>;

export function parseProductsQuery(
  raw: Record<string, string | string[] | undefined>,
): ProductsQuery {
  return ProductsQuerySchema.parse({
    q: raw.q,
    category: raw.category,
    price: raw.price,
    sort: raw.sort,
    page: raw.page,
  });
}

/** The query string for a page of results, omitting every default. */
export function productsQueryString(
  query: ProductsQuery,
  overrides: Partial<ProductsQuery> = {},
): string {
  const next = { ...query, ...overrides };
  const params = new URLSearchParams();
  if (next.q) params.set("q", next.q);
  if (next.category) params.set("category", next.category);
  if (next.price) params.set("price", next.price);
  if (next.sort !== "newest") params.set("sort", next.sort);
  if (next.page > 1) params.set("page", String(next.page));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

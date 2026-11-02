import { z } from "zod";

export const ProductsTabSchema = z.enum(["products", "replays"]);
export type ProductsTab = z.infer<typeof ProductsTabSchema>;

export const PRODUCTS_TABS: readonly { id: ProductsTab; label: string }[] = [
  { id: "products", label: "Digital products" },
  { id: "replays", label: "Replays" },
];

/** An unknown or repeated `?tab=` opens Digital products. */
export function parseProductsTab(value: unknown): ProductsTab {
  const parsed = ProductsTabSchema.safeParse(value);
  return parsed.success ? parsed.data : "products";
}

export type RawSearchParams = Record<string, string | string[] | undefined>;

/** The old `/explore/recordings` index lands on the Replays tab and keeps every other query param. */
export function replaysIndexHref(searchParams: RawSearchParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "tab") continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) query.append(key, item);
    }
  }
  query.set("tab", "replays");
  return `/explore/products?${query.toString()}`;
}

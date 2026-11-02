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

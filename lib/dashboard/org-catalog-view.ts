import { z } from "zod";

/** Catalog's `?status=`: `archived` lists withdrawn plans instead of live ones. */
const CatalogStatusSchema = z.enum(["archived"]);

export function isArchivedCatalogView(
  status: string | string[] | null | undefined,
): boolean {
  return CatalogStatusSchema.safeParse(status).success;
}

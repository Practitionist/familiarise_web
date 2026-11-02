import type { PrismaLike } from "@/lib/prisma";
import {
  DIGITAL_PRODUCT_MIME_TYPES,
  isDigitalProductMime,
} from "@/lib/digital-products/constants";

interface LineageRow {
  lineageId: string;
  version: number;
  originalName: string;
}

interface NamedRow {
  lineageId: string;
  originalName: string;
  mimeType: string;
}

/** `name`'s stem with the extension `mimeType` is stored under; an unknown MIME keeps `name`'s own. */
function withMimeExtension(name: string, mimeType: string): string {
  if (!isDigitalProductMime(mimeType)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${DIGITAL_PRODUCT_MIME_TYPES[mimeType].extension}`;
}

/**
 * Resolves the name buyers see for a row: its lineage's first-version stem,
 * stable across replacements, with the row's own format extension.
 */
export async function lineageDisplayNames(
  db: Pick<PrismaLike, "digitalProductAsset">,
  rows: readonly LineageRow[],
): Promise<(row: NamedRow) => string> {
  const firsts = new Map<string, string>();
  for (const row of rows) {
    if (row.version === 1) firsts.set(row.lineageId, row.originalName);
  }
  const unknown = [
    ...new Set(rows.map((r) => r.lineageId).filter((id) => !firsts.has(id))),
  ];
  if (unknown.length > 0) {
    const found = await db.digitalProductAsset.findMany({
      where: {
        lineageId: { in: unknown },
        status: { in: ["VERIFIED", "SUPERSEDED"] },
      },
      orderBy: { version: "asc" },
      distinct: ["lineageId"],
      select: { lineageId: true, originalName: true },
    });
    for (const first of found) firsts.set(first.lineageId, first.originalName);
  }
  return (row) =>
    withMimeExtension(
      firsts.get(row.lineageId) ?? row.originalName,
      row.mimeType,
    );
}

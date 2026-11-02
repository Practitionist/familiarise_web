import type { PrismaLike } from "@/lib/prisma";

interface LineageRow {
  lineageId: string;
  version: number;
  originalName: string;
}

/** The name buyers see for each lineage: its first version's, stable across replacements. */
export async function lineageDisplayNames(
  db: Pick<PrismaLike, "digitalProductAsset">,
  rows: readonly LineageRow[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const row of rows) {
    if (row.version === 1) names.set(row.lineageId, row.originalName);
  }
  const unknown = [
    ...new Set(rows.map((r) => r.lineageId).filter((id) => !names.has(id))),
  ];
  if (unknown.length > 0) {
    const firsts = await db.digitalProductAsset.findMany({
      where: {
        lineageId: { in: unknown },
        status: { in: ["VERIFIED", "SUPERSEDED"] },
      },
      orderBy: { version: "asc" },
      distinct: ["lineageId"],
      select: { lineageId: true, originalName: true },
    });
    for (const first of firsts) names.set(first.lineageId, first.originalName);
  }
  for (const row of rows) {
    if (!names.has(row.lineageId)) names.set(row.lineageId, row.originalName);
  }
  return names;
}

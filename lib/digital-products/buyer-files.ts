import "server-only";

import prisma from "@/lib/prisma";
import { lineageDisplayNames } from "@/lib/digital-products/lineage";

/** A file the buyer can download now, under the name buyers always see. */
export interface BuyerFile {
  id: string;
  name: string;
  sizeBytes: number;
  /** "new": a file added since purchase, never downloaded; "updated": a newer version since their last download. */
  badge: "new" | "updated" | null;
  /** When the current version replaced an earlier one; null for a first version. */
  updatedAt: Date | null;
}

/** A file the buyer had that the creator removed. */
export interface RemovedBuyerFile {
  lineageId: string;
  name: string;
  removedAt: Date;
}

export interface BuyerFiles {
  files: BuyerFile[];
  removed: RemovedBuyerFile[];
}

export interface BuyerAssetRow {
  id: string;
  lineageId: string;
  version: number;
  status: "VERIFIED" | "SUPERSEDED";
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  order: number;
  createdAt: Date;
  verifiedAt: Date | null;
  supersededAt: Date | null;
}

const liveFrom = (row: BuyerAssetRow) => row.verifiedAt ?? row.createdAt;

/**
 * One purchase's view of its product's files. Every version live at or after
 * the purchase is in `rows`; a badge clears once the buyer downloads the
 * lineage after its current version went live.
 */
export function buyerFileView(input: {
  purchasedAt: Date;
  rows: readonly BuyerAssetRow[];
  lastDownloadByLineage: ReadonlyMap<string, Date>;
  nameOf: (row: BuyerAssetRow) => string;
}): BuyerFiles {
  const { purchasedAt, lastDownloadByLineage, nameOf } = input;
  const rows = input.rows.filter(
    (r) =>
      r.status === "VERIFIED" ||
      (r.supersededAt !== null && r.supersededAt > purchasedAt),
  );
  const byLineage = new Map<string, BuyerAssetRow[]>();
  for (const row of rows) {
    byLineage.set(row.lineageId, [
      ...(byLineage.get(row.lineageId) ?? []),
      row,
    ]);
  }
  const files = rows
    .filter((r) => r.status === "VERIFIED")
    .sort(
      (a, b) =>
        a.order - b.order || a.createdAt.getTime() - b.createdAt.getTime(),
    )
    .map((current): BuyerFile => {
      const live = liveFrom(current);
      const lastDownload = lastDownloadByLineage.get(current.lineageId);
      const fresh = live > (lastDownload ?? purchasedAt);
      const heldAtPurchase = (byLineage.get(current.lineageId) ?? []).some(
        (r) => liveFrom(r) <= purchasedAt,
      );
      return {
        id: current.id,
        name: nameOf(current),
        sizeBytes: current.sizeBytes,
        badge: !fresh
          ? null
          : !heldAtPurchase && !lastDownload
            ? "new"
            : "updated",
        updatedAt: current.version > 1 ? live : null,
      };
    });
  const removed: RemovedBuyerFile[] = [];
  for (const [lineageId, versions] of byLineage) {
    if (versions.some((r) => r.status === "VERIFIED")) continue;
    const last = versions.reduce((a, b) =>
      (b.supersededAt?.getTime() ?? 0) > (a.supersededAt?.getTime() ?? 0)
        ? b
        : a,
    );
    removed.push({
      lineageId,
      name: nameOf(last),
      removedAt: new Date(last.supersededAt?.getTime() ?? 0),
    });
  }
  removed.sort((a, b) => b.removedAt.getTime() - a.removedAt.getTime());
  return { files, removed };
}

/** The file view of each purchase, keyed by purchase id: three reads for any number of purchases. */
export async function readBuyerFiles(
  purchases: readonly { id: string; productId: string; createdAt: Date }[],
): Promise<Map<string, BuyerFiles>> {
  const views = new Map<string, BuyerFiles>();
  if (purchases.length === 0) return views;
  const earliest = new Date(
    Math.min(...purchases.map((p) => p.createdAt.getTime())),
  );
  const [assets, downloads] = await Promise.all([
    prisma.digitalProductAsset.findMany({
      where: {
        productId: { in: [...new Set(purchases.map((p) => p.productId))] },
        OR: [
          { status: "VERIFIED" },
          { status: "SUPERSEDED", supersededAt: { gt: earliest } },
        ],
      },
      select: {
        id: true,
        productId: true,
        lineageId: true,
        version: true,
        status: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        order: true,
        createdAt: true,
        verifiedAt: true,
        supersededAt: true,
      },
    }),
    prisma.digitalProductDownload.groupBy({
      by: ["purchaseId", "assetId"],
      where: { purchaseId: { in: purchases.map((p) => p.id) } },
      _max: { createdAt: true },
    }),
  ]);
  const rows = assets.flatMap((a) =>
    a.status === "VERIFIED" || a.status === "SUPERSEDED"
      ? [{ ...a, status: a.status }]
      : [],
  );
  const nameOf = await lineageDisplayNames(prisma, rows);
  const lineageOf = new Map(rows.map((r) => [r.id, r.lineageId]));
  for (const purchase of purchases) {
    const lastDownloadByLineage = new Map<string, Date>();
    for (const d of downloads) {
      const lineageId = lineageOf.get(d.assetId);
      const at = d._max.createdAt;
      if (d.purchaseId !== purchase.id || !lineageId || !at) continue;
      const seen = lastDownloadByLineage.get(lineageId);
      if (!seen || at > seen) lastDownloadByLineage.set(lineageId, at);
    }
    views.set(
      purchase.id,
      buyerFileView({
        purchasedAt: purchase.createdAt,
        rows: rows.filter((r) => r.productId === purchase.productId),
        lastDownloadByLineage,
        nameOf,
      }),
    );
  }
  return views;
}

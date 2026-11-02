import type { Db, Tx } from "@/lib/prisma";
import { deleteR2Object } from "@/lib/storage/r2-client";
import { reportSentryError } from "@/lib/observability/report";
import { digitalProductsBucket } from "@/lib/digital-products/storage";

/** Files of one erased creator purged per call; a re-run of the erasure drains the rest. */
const ERASURE_PURGE_BATCH = 500;

/**
 * In the scrub transaction: take the erased creator's products off sale and
 * retire their files, and drop the erased buyer's download trail, free claims,
 * failed attempts and report text. Paid purchases stay with their Payment.
 */
export async function scrubDigitalProductsTx(
  tx: Tx,
  userId: string,
  now: Date,
): Promise<void> {
  const ownProducts = { consultantProfile: { userId } };
  await tx.digitalProduct.updateMany({
    where: { ...ownProducts, status: { not: "ARCHIVED" } },
    data: { status: "ARCHIVED", archivedAt: now },
  });
  await tx.digitalProductAsset.updateMany({
    where: { product: ownProducts, status: { in: ["PENDING", "VERIFIED"] } },
    data: { status: "SUPERSEDED", supersededAt: now },
  });
  await tx.digitalProductDownload.deleteMany({
    where: { purchase: { buyerId: userId } },
  });
  await tx.digitalProductPurchase.deleteMany({
    where: {
      buyerId: userId,
      paymentId: null,
      OR: [{ amountPaise: 0 }, { status: "FAILED" }],
    },
  });
  await tx.digitalProductReport.updateMany({
    where: { reporterId: userId },
    data: { reason: "[erased]" },
  });
}

/**
 * After commit: delete the erased creator's product objects from R2 and stamp
 * purgedAt. Idempotent; answers the failures for the erasure's vendor report.
 */
export async function purgeErasedCreatorFiles(
  prisma: Db,
  userId: string,
  now: Date,
): Promise<string[]> {
  const assets = await prisma.digitalProductAsset.findMany({
    where: { product: { consultantProfile: { userId } }, purgedAt: null },
    take: ERASURE_PURGE_BATCH,
    select: { id: true, storageKey: true },
  });
  if (assets.length === 0) return [];
  const purged: string[] = [];
  let firstError: unknown;
  try {
    const bucket = digitalProductsBucket();
    for (const asset of assets) {
      const res = await deleteR2Object({ key: asset.storageKey, bucket });
      if (res.success) purged.push(asset.id);
      else firstError ??= new Error(res.error ?? "R2 delete failed");
    }
  } catch (error) {
    firstError ??= error;
  }
  if (purged.length > 0) {
    await prisma.digitalProductAsset.updateMany({
      where: { id: { in: purged }, purgedAt: null },
      data: { purgedAt: now },
    });
  }
  const remaining = assets.length - purged.length;
  if (remaining === 0 && assets.length < ERASURE_PURGE_BATCH) return [];
  if (firstError) {
    reportSentryError(firstError, {
      subsystem: "compliance",
      op: "scrubUser.purgeDigitalProductFiles",
      extra: { failed: remaining },
    });
  }
  return ["digital-products: product files not fully deleted; re-run erasure"];
}

import prisma from "@/lib/prisma";
import {
  deleteR2Object,
  getR2ObjectRange,
  headR2Object,
} from "@/lib/storage/r2-client";
import {
  DIGITAL_PRODUCT_MAX_FILE_BYTES,
  isDigitalProductMime,
  mimePolicy,
} from "@/lib/digital-products/constants";
import { checkFileSignature } from "@/lib/digital-products/file-signature";
import { inspectZip } from "@/lib/digital-products/zip-inspect";
import { digitalProductsBucket } from "@/lib/digital-products/storage";

const HEADER_BYTES = 4096;

export type AssetVerification =
  | { status: "VERIFIED" }
  | { status: "REJECTED"; reason: string }
  /** The object is not in the bucket yet; the asset stays PENDING. */
  | { status: "MISSING" }
  /** Another request already settled this asset. */
  | { status: "SETTLED" };

interface PendingAsset {
  id: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
}

/** The structural verdict on one uploaded object; reads only its header and ZIP directory. */
export async function inspectUploadedObject(
  asset: PendingAsset,
): Promise<{ ok: true } | { ok: false; reason: string } | { missing: true }> {
  const bucket = digitalProductsBucket();
  const mime = asset.mimeType;
  if (!isDigitalProductMime(mime)) {
    return { ok: false, reason: "UNSUPPORTED_FILE_TYPE" };
  }
  const policy = mimePolicy(mime);

  const head = await headR2Object({ key: asset.storageKey, bucket });
  if (!head) return { missing: true };
  if (
    head.contentLength > DIGITAL_PRODUCT_MAX_FILE_BYTES ||
    head.contentLength !== asset.sizeBytes ||
    head.contentLength === 0
  ) {
    return { ok: false, reason: "SIZE_MISMATCH" };
  }

  const header = await getR2ObjectRange({
    key: asset.storageKey,
    bucket,
    start: 0,
    endInclusive: Math.min(HEADER_BYTES, head.contentLength) - 1,
  });
  if (!header) return { missing: true };
  const signature = checkFileSignature(header, mime);
  if (!signature.ok) return { ok: false, reason: signature.problem };

  if (policy.zipContainer) {
    const zip = await inspectZip(
      async (start, endInclusive) => {
        const bytes = await getR2ObjectRange({
          key: asset.storageKey,
          bucket,
          start,
          endInclusive,
        });
        if (!bytes) throw new Error("R2 object vanished during inspection");
        return bytes;
      },
      head.contentLength,
      { checkEntryTypes: policy.zipContainer === "archive" },
    );
    if (!zip.ok) return { ok: false, reason: `ZIP_${zip.problem}` };
  }
  return { ok: true };
}

/**
 * Verify a PENDING asset and settle it by CAS: VERIFIED, or REJECTED with its
 * object deleted. A missing object leaves it PENDING for a retried commit.
 */
export async function verifyDigitalProductAsset(
  asset: PendingAsset,
): Promise<AssetVerification> {
  const verdict = await inspectUploadedObject(asset);
  if ("missing" in verdict) return { status: "MISSING" };
  if (verdict.ok) {
    const settled = await prisma.digitalProductAsset.updateMany({
      where: { id: asset.id, status: "PENDING" },
      data: { status: "VERIFIED", verifiedAt: new Date() },
    });
    return settled.count === 1 ? { status: "VERIFIED" } : { status: "SETTLED" };
  }
  await deleteR2Object({
    key: asset.storageKey,
    bucket: digitalProductsBucket(),
  });
  const settled = await prisma.digitalProductAsset.updateMany({
    where: { id: asset.id, status: "PENDING" },
    data: { status: "REJECTED", rejectReason: verdict.reason },
  });
  return settled.count === 1
    ? { status: "REJECTED", reason: verdict.reason }
    : { status: "SETTLED" };
}

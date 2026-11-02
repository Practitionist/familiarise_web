import prisma from "@/lib/prisma";
import {
  deleteR2Object,
  getR2ObjectRange,
  headR2Object,
  R2PreconditionFailedError,
} from "@/lib/storage/r2-client";
import {
  DIGITAL_PRODUCT_MAX_FILE_BYTES,
  isDigitalProductMime,
  mimePolicy,
} from "@/lib/digital-products/constants";
import { lockDigitalProductRow } from "@/lib/digital-products/product-lock";
import { checkFileSignature } from "@/lib/digital-products/file-signature";
import { inspectZip } from "@/lib/digital-products/zip-inspect";
import { digitalProductsBucket } from "@/lib/digital-products/storage";
import { formatRejectReason } from "@/lib/digital-products/reject-reasons";

const HEADER_BYTES = 4096;

export type AssetVerification =
  | { status: "VERIFIED" }
  | { status: "REJECTED"; reason: string }
  /** The object is not in the bucket yet; the asset stays PENDING. */
  | { status: "MISSING" }
  /** The object changed while it was read; the asset stays PENDING. */
  | { status: "CHANGED" }
  /** Another request already settled this asset. */
  | { status: "SETTLED" };

interface PendingAsset {
  id: string;
  productId: string;
  lineageId: string;
  version: number;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
}

type Inspection =
  | { ok: true }
  | { ok: false; reason: string }
  | { missing: true }
  | { changed: true };

/**
 * The structural verdict on one uploaded object, reading only its header and
 * ZIP directory. Every read is fenced to the ETag the HEAD saw.
 */
export async function inspectUploadedObject(
  asset: PendingAsset,
): Promise<Inspection> {
  try {
    return await inspectOneVersion(asset);
  } catch (error) {
    if (error instanceof R2PreconditionFailedError) return { changed: true };
    throw error;
  }
}

async function inspectOneVersion(asset: PendingAsset): Promise<Inspection> {
  const bucket = digitalProductsBucket();
  const mime = asset.mimeType;
  if (!isDigitalProductMime(mime)) {
    return { ok: false, reason: "UNSUPPORTED_FILE_TYPE" };
  }
  const policy = mimePolicy(mime);

  const head = await headR2Object({ key: asset.storageKey, bucket });
  if (!head) return { missing: true };
  if (!head.etag) throw new Error("R2 HEAD response missing an ETag");
  const ifMatch = head.etag;
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
    ifMatch,
  });
  if (!header) return { missing: true };
  const signature = checkFileSignature(header, mime);
  if (!signature.ok) {
    return {
      ok: false,
      reason: formatRejectReason(signature.problem, signature.detail),
    };
  }

  if (policy.zipContainer) {
    const zip = await inspectZip(
      async (start, endInclusive) => {
        const bytes = await getR2ObjectRange({
          key: asset.storageKey,
          bucket,
          start,
          endInclusive,
          ifMatch,
        });
        if (!bytes) throw new R2PreconditionFailedError(asset.storageKey);
        return bytes;
      },
      head.contentLength,
      { checkEntryTypes: policy.zipContainer === "archive" },
    );
    if (!zip.ok) {
      return {
        ok: false,
        reason: formatRejectReason(`ZIP_${zip.problem}`, zip.detail),
      };
    }
  }
  return { ok: true };
}

/**
 * Verify a PENDING asset and settle it by CAS under the product row lock:
 * VERIFIED (superseding older versions of its lineage), or REJECTED with its
 * object deleted. A version older than one already verified, or one whose
 * lineage's current file was deleted, never becomes current.
 */
export async function verifyDigitalProductAsset(
  asset: PendingAsset,
): Promise<AssetVerification> {
  const verdict = await inspectUploadedObject(asset);
  if ("missing" in verdict) return { status: "MISSING" };
  if ("changed" in verdict) return { status: "CHANGED" };
  const outcome = await prisma.$transaction(
    async (tx): Promise<AssetVerification> => {
      await lockDigitalProductRow(tx, asset.productId);
      const newer = verdict.ok
        ? await tx.digitalProductAsset.findFirst({
            where: {
              lineageId: asset.lineageId,
              version: { gt: asset.version },
              status: { in: ["VERIFIED", "SUPERSEDED"] },
            },
            select: { id: true },
          })
        : null;
      // A replacement is promoted only while its lineage still has a current file.
      const headless =
        verdict.ok && !newer && asset.version > 1
          ? (await tx.digitalProductAsset.count({
              where: { lineageId: asset.lineageId, status: "VERIFIED" },
            })) === 0
          : false;
      const reason = !verdict.ok
        ? verdict.reason
        : newer
          ? "NEWER_VERSION_EXISTS"
          : headless
            ? "LINEAGE_DELETED"
            : null;
      const now = new Date();
      if (reason) {
        const rejected = await tx.digitalProductAsset.updateMany({
          where: { id: asset.id, status: "PENDING" },
          data: { status: "REJECTED", rejectReason: reason },
        });
        return rejected.count === 1
          ? { status: "REJECTED", reason }
          : { status: "SETTLED" };
      }
      // Row-locks the still-PENDING asset; the one-verified-per-lineage index needs the old version retired first.
      const claimed = await tx.digitalProductAsset.updateMany({
        where: { id: asset.id, status: "PENDING" },
        data: { verifiedAt: now },
      });
      if (claimed.count === 0) return { status: "SETTLED" };
      await tx.digitalProductAsset.updateMany({
        where: {
          lineageId: asset.lineageId,
          status: "VERIFIED",
          version: { lt: asset.version },
        },
        data: { status: "SUPERSEDED", supersededAt: now },
      });
      await tx.digitalProductAsset.updateMany({
        where: { id: asset.id, status: "PENDING" },
        data: { status: "VERIFIED" },
      });
      return { status: "VERIFIED" };
    },
  );
  if (outcome.status === "REJECTED") {
    // A failed delete leaves the REJECTED row naming the key for the storage sweep.
    await deleteR2Object({
      key: asset.storageKey,
      bucket: digitalProductsBucket(),
    }).catch(() => undefined);
  }
  return outcome;
}

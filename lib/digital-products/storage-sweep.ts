/**
 * Keeps the digital products bucket equal to what the rows promise: deletes
 * the objects of versions superseded over 30 days ago or older than their
 * lineage's two newest (stamping purgedAt), retires and clears REJECTED and
 * abandoned PENDING uploads older than a day,
 * and pages through the bucket deleting objects older than a day no row names.
 */
import prisma from "@/lib/prisma";
import { readJobCheckpoint, withCronLock } from "@/lib/cron/with-cron-lock";
import { reportConfigSkip, type ConfigSkip } from "@/lib/cron/config-skip";
import { reportSentryError } from "@/lib/observability/report";
import { deleteR2Object, listR2Keys } from "@/lib/storage/r2-client";
import { DIGITAL_PRODUCT_KEY_PREFIX } from "@/lib/digital-products/constants";

const JOB = "reconcile-digital-product-storage";
const DAY_MS = 24 * 60 * 60_000;
const SUPERSEDED_KEEP_MS = 30 * DAY_MS;
const DEFAULT_LIMIT = 25;
/** One ListObjectsV2 page per run; the checkpoint resumes after its last key. */
const ORPHAN_PAGE_KEYS = 200;
const DELETE_CONCURRENCY = 10;

/** No verdict field: `failed > 0` makes the run partial. */
export interface DigitalProductStorageSweepResult {
  supersededPurged: number;
  uploadsCleared: number;
  orphansDeleted: number;
  keysListed: number;
  failed: number;
  /** The last key this run listed, or null once the bucket wrapped around. */
  checkpoint: string | null;
  skipped?: ConfigSkip;
}

async function deleteAll(
  bucket: string,
  keys: string[],
  failures: string[],
): Promise<Set<string>> {
  const deleted = new Set<string>();
  for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
    const chunk = keys.slice(i, i + DELETE_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((key) =>
        deleteR2Object({ key, bucket }).catch((error: unknown) => ({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        })),
      ),
    );
    results.forEach((res, j) => {
      if (res.success) deleted.add(chunk[j]);
      else failures.push(`${chunk[j]}: ${res.error ?? "delete failed"}`);
    });
  }
  return deleted;
}

/**
 * Delete the objects of SUPERSEDED versions and stamp purgedAt once R2
 * confirms; the row stays as download evidence. A failed delete stays for the sweep.
 */
export async function purgeSupersededObjects(
  bucket: string,
  rows: { id: string; storageKey: string }[],
  failures: string[],
  now: Date = new Date(),
): Promise<number> {
  if (rows.length === 0) return 0;
  const deleted = await deleteAll(
    bucket,
    rows.map((r) => r.storageKey),
    failures,
  );
  const ids = rows.filter((r) => deleted.has(r.storageKey)).map((r) => r.id);
  if (ids.length === 0) return 0;
  const stamped = await prisma.digitalProductAsset.updateMany({
    where: { id: { in: ids }, status: "SUPERSEDED", purgedAt: null },
    data: { purgedAt: now },
  });
  return stamped.count;
}

/** Unpurged versions superseded 30 days ago, or with two newer versions in their lineage. */
async function purgeSuperseded(
  bucket: string,
  limit: number,
  now: Date,
  failures: string[],
): Promise<number> {
  const cutoff = new Date(now.getTime() - SUPERSEDED_KEEP_MS);
  const rows = await prisma.$queryRaw<{ id: string; storageKey: string }[]>`
    SELECT a.id, a."storageKey" FROM "DigitalProductAsset" a
    WHERE a.status = 'SUPERSEDED' AND a."purgedAt" IS NULL
      AND (a."supersededAt" < ${cutoff} OR EXISTS (
        SELECT 1 FROM "DigitalProductAsset" b
        WHERE b."lineageId" = a."lineageId" AND b.version > a.version
          AND b.status IN ('VERIFIED', 'SUPERSEDED')
        OFFSET 1))
    ORDER BY a."supersededAt" ASC
    LIMIT ${limit}`;
  return purgeSupersededObjects(bucket, rows, failures, now);
}

/**
 * Retire abandoned PENDING uploads to REJECTED by CAS before any vendor delete,
 * so a racing commit can no longer verify them; a REJECTED row keeps naming its
 * key until R2 confirms the delete, and only then is removed.
 */
async function clearDeadUploads(
  bucket: string,
  limit: number,
  now: Date,
  failures: string[],
): Promise<number> {
  const cutoff = new Date(now.getTime() - DAY_MS);
  const rows = await prisma.digitalProductAsset.findMany({
    where: {
      status: { in: ["REJECTED", "PENDING"] },
      createdAt: { lt: cutoff },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, storageKey: true, status: true },
  });
  const pendingIds = rows
    .filter((r) => r.status === "PENDING")
    .map((r) => r.id);
  if (pendingIds.length > 0) {
    await prisma.digitalProductAsset.updateMany({
      where: { id: { in: pendingIds }, status: "PENDING" },
      data: { status: "REJECTED", rejectReason: "ABANDONED" },
    });
  }
  const retired = await prisma.digitalProductAsset.findMany({
    where: { id: { in: rows.map((r) => r.id) }, status: "REJECTED" },
    select: { id: true, storageKey: true },
  });
  const deleted = await deleteAll(
    bucket,
    retired.map((r) => r.storageKey),
    failures,
  );
  const ids = retired.filter((r) => deleted.has(r.storageKey)).map((r) => r.id);
  if (ids.length === 0) return 0;
  const res = await prisma.digitalProductAsset.deleteMany({
    where: { id: { in: ids }, status: "REJECTED" },
  });
  return res.count;
}

async function deleteOrphanPage(
  bucket: string,
  startAfter: string | null,
  now: Date,
  failures: string[],
): Promise<{ deleted: number; listed: number; checkpoint: string | null }> {
  const page = await listR2Keys({
    bucket,
    prefix: DIGITAL_PRODUCT_KEY_PREFIX,
    maxKeys: ORPHAN_PAGE_KEYS,
    ...(startAfter ? { startAfter } : {}),
  });
  const old = page.objects.filter(
    (o) => o.lastModified && now.getTime() - o.lastModified.getTime() > DAY_MS,
  );
  const known = old.length
    ? await prisma.digitalProductAsset.findMany({
        where: { storageKey: { in: old.map((o) => o.key) } },
        select: { storageKey: true },
      })
    : [];
  const knownKeys = new Set(known.map((k) => k.storageKey));
  const orphans = old.map((o) => o.key).filter((k) => !knownKeys.has(k));
  const deleted = await deleteAll(bucket, orphans, failures);
  return {
    deleted: deleted.size,
    listed: page.objects.length,
    checkpoint: page.truncated ? (page.keys.at(-1) ?? null) : null,
  };
}

export async function reconcileDigitalProductStorage(
  opts: { limit?: number } = {},
): Promise<DigitalProductStorageSweepResult> {
  const bucket = process.env.R2_DIGITAL_PRODUCTS_BUCKET?.trim();
  if (!bucket) {
    const skipped: ConfigSkip = "R2_DIGITAL_PRODUCTS_BUCKET not configured";
    reportConfigSkip(JOB, skipped);
    return {
      supersededPurged: 0,
      uploadsCleared: 0,
      orphansDeleted: 0,
      keysListed: 0,
      failed: 0,
      checkpoint: null,
      skipped,
    };
  }
  const limit = opts.limit ?? DEFAULT_LIMIT;
  // Fail-closed: two overlapping runs would race their deletes against commits.
  return withCronLock(
    "reconcile-digital-product-storage",
    { failMode: "closed" },
    async () => {
      const now = new Date();
      const failures: string[] = [];
      const supersededPurged = await purgeSuperseded(
        bucket,
        limit,
        now,
        failures,
      );
      const uploadsCleared = await clearDeadUploads(
        bucket,
        limit,
        now,
        failures,
      );
      const orphans = await deleteOrphanPage(
        bucket,
        await readJobCheckpoint(JOB),
        now,
        failures,
      );
      if (failures.length > 0) {
        // One Sentry event per run, never per object.
        reportSentryError(
          new Error(`${JOB}: ${failures.length} deletes failed`),
          {
            subsystem: "storage",
            op: JOB,
            fingerprint: [JOB],
            extra: { sample: failures.slice(0, 10) },
          },
        );
      }
      return {
        supersededPurged,
        uploadsCleared,
        orphansDeleted: orphans.deleted,
        keysListed: orphans.listed,
        failed: failures.length,
        checkpoint: orphans.checkpoint,
      };
    },
  );
}

/**
 * Document Storage Reconciliation - Core Logic
 *
 * Reconciles document records in database with files in Supabase storage.
 * - Finds orphaned files (in storage but not in DB)
 * - Finds missing files (in DB but not in storage)
 * - Deletes orphaned files after grace period
 *
 * This catches cases where:
 * - File uploaded but DB record creation failed
 * - DB record created but file upload failed
 * - File manually deleted from storage
 * - System errors during upload/delete operations
 *
 * Registered as `reconcile-document-storage` in lib/cron/cleanup-registry.ts.
 */

import prisma from "../../lib/prisma";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { DOCUMENT_DELETE_GRACE_DAYS } from "@/lib/documents/document-dates";

// Grace period before deleting orphaned files (days)
const ORPHAN_GRACE_PERIOD_DAYS = 7;
const PENDING_ATTACHMENT_PROTECTION_MS = 86_400_000;

// Buckets to check
const BUCKETS_TO_CHECK = ["documents", "support-attachments"];

export interface DocumentReconciliationResult {
  success: boolean;
  orphanedFilesFound: number;
  orphanedFilesDeleted: number;
  missingFilesFound: number;
  missingFilesMarked: number;
  errors: string[];
  timestamp: string;
}

interface OrphanedFile {
  bucket: string;
  path: string;
  name: string;
  createdAt?: Date;
}

/**
 * Get Supabase admin client for storage operations
 */
function getSupabaseAdmin(): SupabaseClient | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn("Supabase credentials not configured for admin operations");
    return null;
  }

  return createClient(supabaseUrl, supabaseServiceKey);
}

interface StorageFileEntry {
  path: string;
  name: string;
  createdAt?: Date;
}

async function collectEntriesFromBatch(
  supabase: SupabaseClient,
  bucket: string,
  basePath: string,
  batch: Array<{
    name: string;
    metadata?: unknown;
    created_at?: string | null;
  }>,
): Promise<StorageFileEntry[]> {
  const collected: StorageFileEntry[] = [];
  for (const item of batch) {
    const itemPath = basePath ? `${basePath}/${item.name}` : item.name;
    if (!item.metadata) {
      const subFiles = await listAllFilesInBucket(supabase, bucket, itemPath);
      collected.push(...subFiles);
    } else {
      collected.push({
        path: itemPath,
        name: item.name,
        createdAt: item.created_at ? new Date(item.created_at) : undefined,
      });
    }
  }
  return collected;
}

/**
 * Recursively list all files in a bucket path. Throws on any listing error so a
 * partial listing is never treated as the bucket's full contents.
 */
async function listAllFilesInBucket(
  supabase: SupabaseClient,
  bucket: string,
  path = "",
): Promise<StorageFileEntry[]> {
  const allFiles: StorageFileEntry[] = [];
  const PAGE_LIMIT = 1000;
  let offset = 0;

  while (true) {
    const { data: items, error } = await supabase.storage
      .from(bucket)
      .list(path, { limit: PAGE_LIMIT, offset });
    if (error) {
      console.error(`Error listing files in ${bucket}/${path}:`, error);
      throw error;
    }

    const batch = items ?? [];
    const pageEntries = await collectEntriesFromBatch(
      supabase,
      bucket,
      path,
      batch,
    );
    allFiles.push(...pageEntries);

    if (batch.length < PAGE_LIMIT) {
      break;
    }
    offset += PAGE_LIMIT;
  }

  return allFiles;
}

/** Objects in `bucket` that no active or within-grace-window DB row points at. */
async function findOrphanedFiles(
  supabase: SupabaseClient,
  bucket: string,
  loadDbPaths: () => Promise<Set<string>>,
): Promise<OrphanedFile[]> {
  console.log(`\n🔍 Checking ${bucket} bucket...`);

  const storageFiles = await listAllFilesInBucket(supabase, bucket);
  console.log(`   Found ${storageFiles.length} files in storage`);
  if (storageFiles.length === 0) return [];

  const dbPaths = await loadDbPaths();
  console.log(`   Found ${dbPaths.size} referenced paths in DB`);

  const orphanedFiles = storageFiles
    .filter((file) => !dbPaths.has(file.path))
    .map((file) => ({ bucket, ...file }));
  console.log(`   Found ${orphanedFiles.length} orphaned files`);
  return orphanedFiles;
}

/** Tombstoned rows keep their objects until the purge's grace window ends. */
const SOFT_DELETE_RETENTION_MS =
  DOCUMENT_DELETE_GRACE_DAYS * 24 * 60 * 60 * 1000;

/** The documents bucket holds appointment documents, plan materials and verification documents. */
async function documentsBucketPaths(): Promise<Set<string>> {
  const retentionCutoff = new Date(Date.now() - SOFT_DELETE_RETENTION_MS);
  const [appointmentDocs, planMaterials, verificationDocs] = await Promise.all([
    prisma.appointmentDocument.findMany({
      where: {
        OR: [{ deletedAt: null }, { deletedAt: { gte: retentionCutoff } }],
      },
      select: { storagePath: true },
    }),
    prisma.planMaterial.findMany({ select: { storagePath: true } }),
    prisma.profileVerificationDocument.findMany({
      select: { storagePath: true },
    }),
  ]);
  return new Set(
    [...appointmentDocs, ...planMaterials, ...verificationDocs].map(
      (row) => row.storagePath,
    ),
  );
}

async function supportAttachmentPaths(): Promise<Set<string>> {
  const rows = await prisma.supportCaseAttachment.findMany({
    where: {
      // A deleted row no longer protects its object, so a failed purge or erasure removal is swept as an orphan.
      OR: [
        { completedAt: { not: null }, deletedAt: null },
        {
          completedAt: null,
          deletedAt: null,
          createdAt: {
            gte: new Date(Date.now() - PENDING_ATTACHMENT_PROTECTION_MS),
          },
        },
      ],
    },
    select: { storagePath: true },
  });
  return new Set(rows.map((row) => row.storagePath));
}

interface MissingFile {
  id: string;
  storagePath: string;
  isStorageMissing: boolean;
}

async function findMissingFiles(
  supabase: SupabaseClient,
): Promise<{ missingFiles: MissingFile[]; recoveredIds: string[] }> {
  const missingFiles: MissingFile[] = [];
  const recoveredIds: string[] = [];

  console.log("\n🔍 Checking for missing files...");

  const [storageFiles, dbDocuments] = await Promise.all([
    listAllFilesInBucket(supabase, "documents"),
    prisma.appointmentDocument.findMany({
      where: { deletedAt: null },
      select: { id: true, storagePath: true, isStorageMissing: true },
    }),
  ]);
  const storagePaths = new Set(storageFiles.map((f) => f.path));

  console.log(`   Checking ${dbDocuments.length} document records...`);

  for (const doc of dbDocuments) {
    const present = storagePaths.has(doc.storagePath);
    if (present) {
      if (doc.isStorageMissing) recoveredIds.push(doc.id);
    } else {
      missingFiles.push({
        id: doc.id,
        storagePath: doc.storagePath,
        isStorageMissing: doc.isStorageMissing,
      });
    }
  }

  console.log(`   Found ${missingFiles.length} missing files`);
  return { missingFiles, recoveredIds };
}

/**
 * Batch-flag newly missing storage rows and clear the flag on recovered rows.
 */
async function persistMissingState(
  missingFiles: MissingFile[],
  recoveredIds: string[],
): Promise<number> {
  const newlyMissingIds = missingFiles
    .filter((doc) => !doc.isStorageMissing)
    .map((doc) => doc.id);

  if (newlyMissingIds.length > 0) {
    await prisma.appointmentDocument.updateMany({
      where: { id: { in: newlyMissingIds } },
      data: { isStorageMissing: true, missingDetectedAt: new Date() },
    });
  }

  if (recoveredIds.length > 0) {
    await prisma.appointmentDocument.updateMany({
      where: { id: { in: recoveredIds } },
      data: { isStorageMissing: false, missingDetectedAt: null },
    });
    console.log(
      `   ♻️ Cleared missing flag on ${recoveredIds.length} recovered files`,
    );
  }

  return newlyMissingIds.length;
}

/** Claims expired pending rows before deletion; tombstones cannot be finalised. */
async function claimSupportOrphanPaths(paths: string[]): Promise<string[]> {
  const pendingWhere = {
    storagePath: { in: paths },
    completedAt: null,
    deletedAt: null,
    createdAt: {
      lt: new Date(Date.now() - PENDING_ATTACHMENT_PROTECTION_MS),
    },
  };
  const pending = await prisma.supportCaseAttachment.findMany({
    where: pendingWhere,
    select: { id: true },
  });
  if (pending.length > 0) {
    await prisma.supportCaseAttachment.updateMany({
      where: { ...pendingWhere, id: { in: pending.map((row) => row.id) } },
      data: { deletedAt: new Date() },
    });
  }
  // Paths are server-generated before upload; retained tombstones prevent reuse.
  const live = await prisma.supportCaseAttachment.findMany({
    where: { storagePath: { in: paths }, deletedAt: null },
    select: { storagePath: true },
  });
  const protectedPaths = new Set(live.map((row) => row.storagePath));
  return paths.filter((path) => !protectedPaths.has(path));
}

async function deleteOrphanedBucketPaths(
  supabase: SupabaseClient,
  bucket: string,
  paths: string[],
): Promise<{ deleted: number; notRemoved: number }> {
  const batchSize = 100;
  let deleted = 0;
  let notRemoved = 0;
  // Keep ownership claims and vendor removals sequential to bound storage pressure.
  for (let i = 0; i < paths.length; i += batchSize) {
    const candidates = paths.slice(i, i + batchSize);
    const batch =
      bucket === "support-attachments"
        ? await claimSupportOrphanPaths(candidates)
        : candidates;
    if (batch.length === 0) continue;
    const { data, error } = await supabase.storage.from(bucket).remove(batch);
    if (error) {
      console.error(`   Error deleting batch from ${bucket}:`, error);
    }
    const removed = error ? 0 : (data?.length ?? 0);
    deleted += removed;
    notRemoved += batch.length - removed;
  }
  return { deleted, notRemoved };
}

/**
 * Delete orphaned files older than grace period. Counts only what Storage
 * reports as removed; any shortfall is added to `errors` once per bucket.
 */
async function deleteOrphanedFiles(
  supabase: SupabaseClient,
  orphanedFiles: OrphanedFile[],
  errors: string[],
): Promise<number> {
  const graceDate = new Date(
    Date.now() - ORPHAN_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000,
  );
  let deleted = 0;

  console.log(
    `\n🗑️ Deleting orphaned files older than ${ORPHAN_GRACE_PERIOD_DAYS} days...`,
  );

  // Group by bucket
  const byBucket = orphanedFiles.reduce(
    (acc, file) => {
      if (!acc[file.bucket]) acc[file.bucket] = [];
      acc[file.bucket].push(file);
      return acc;
    },
    {} as Record<string, OrphanedFile[]>,
  );

  for (const [bucket, files] of Object.entries(byBucket)) {
    const filesToDelete = files.filter(
      (f) => f.createdAt && f.createdAt < graceDate,
    );

    if (filesToDelete.length === 0) {
      console.log(`   No files to delete in ${bucket}`);
      continue;
    }

    console.log(`   Deleting ${filesToDelete.length} files from ${bucket}...`);

    const paths = filesToDelete.map((f) => f.path);

    const removed = await deleteOrphanedBucketPaths(supabase, bucket, paths);
    deleted += removed.deleted;
    const notRemoved = removed.notRemoved;
    if (notRemoved > 0) {
      errors.push(`${notRemoved} orphaned files in ${bucket} were not removed`);
    }
  }

  console.log(`   ✅ Deleted ${deleted} orphaned files`);
  return deleted;
}

/** Reconcile Supabase storage buckets against active and retention-protected DB rows under a single Postgres lease. */
export async function reconcileDocumentStorage(): Promise<DocumentReconciliationResult> {
  return withCronLock(
    "reconcile-document-storage",
    { failMode: "open", ttlMs: LONG_JOB_TTL_MS },
    () => reconcileDocumentStorageUnlocked(),
  );
}

async function reconcileDocumentStorageUnlocked(): Promise<DocumentReconciliationResult> {
  const errors: string[] = [];
  let orphanedFilesFound = 0;
  let orphanedFilesDeleted = 0;
  let missingFilesFound = 0;
  let missingFilesMarked = 0;

  console.log("📂 Starting document storage reconciliation...");
  console.log(`   Buckets to check: ${BUCKETS_TO_CHECK.join(", ")}`);
  console.log(`   Orphan grace period: ${ORPHAN_GRACE_PERIOD_DAYS} days`);

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    errors.push(
      "Supabase admin client not available - cannot reconcile storage",
    );
    return {
      success: false,
      orphanedFilesFound,
      orphanedFilesDeleted,
      missingFilesFound,
      missingFilesMarked,
      errors,
      timestamp: new Date().toISOString(),
    };
  }

  // Probe storage health before proceeding so transient connectivity failures never delete files.
  try {
    const { error: probeError } = await supabase.storage
      .from("documents")
      .list("", { limit: 1 });
    if (probeError) {
      const msg = `Storage health probe failed: ${probeError.message}. Aborting to prevent false deletions.`;
      console.warn(`⚠️ ${msg}`);
      errors.push(msg);
      return {
        success: false,
        orphanedFilesFound,
        orphanedFilesDeleted,
        missingFilesFound,
        missingFilesMarked,
        errors,
        timestamp: new Date().toISOString(),
      };
    }
    console.log("   ✅ Storage health probe passed");
  } catch (probeErr) {
    const msg = `Storage unreachable: ${probeErr instanceof Error ? probeErr.message : String(probeErr)}. Aborting to prevent false deletions.`;
    console.warn(`⚠️ ${msg}`);
    errors.push(msg);
    return {
      success: false,
      orphanedFilesFound,
      orphanedFilesDeleted,
      missingFilesFound,
      missingFilesMarked,
      errors,
      timestamp: new Date().toISOString(),
    };
  }

  try {
    const orphanedDocuments = [
      ...(await findOrphanedFiles(supabase, "documents", documentsBucketPaths)),
      ...(await findOrphanedFiles(
        supabase,
        "support-attachments",
        supportAttachmentPaths,
      )),
    ];
    orphanedFilesFound = orphanedDocuments.length;

    if (orphanedDocuments.length > 0) {
      console.log("\n📋 Orphaned files:");
      orphanedDocuments.slice(0, 10).forEach((f) => {
        console.log(
          `   - ${f.bucket}/${f.path} (created: ${f.createdAt?.toISOString() || "unknown"})`,
        );
      });
      if (orphanedDocuments.length > 10) {
        console.log(`   ... and ${orphanedDocuments.length - 10} more`);
      }

      // Delete orphaned files older than grace period
      orphanedFilesDeleted = await deleteOrphanedFiles(
        supabase,
        orphanedDocuments,
        errors,
      );
    }

    // Find missing files (and rows whose file has returned)
    const { missingFiles: missingDocuments, recoveredIds } =
      await findMissingFiles(supabase);
    missingFilesFound = missingDocuments.length;

    missingFilesMarked = await persistMissingState(
      missingDocuments,
      recoveredIds,
    );

    if (missingDocuments.length > 0) {
      console.log("\n⚠️ Missing files (in DB but not in storage):");
      missingDocuments.slice(0, 10).forEach((d) => {
        console.log(`   - ${d.id}: ${d.storagePath}`);
      });
      if (missingDocuments.length > 10) {
        console.log(`   ... and ${missingDocuments.length - 10} more`);
      }

      // Note: We don't automatically delete DB records for missing files
      // This should be handled manually or through a separate cleanup process
      console.log("\n   ℹ️ Missing file records should be reviewed manually");
    }
  } catch (error) {
    const msg = `Failed to reconcile document storage: ${error}`;
    console.error(`❌ ${msg}`);
    errors.push(msg);
  }

  // Summary
  console.log("\n📊 Document Storage Reconciliation Summary:");
  console.log(`   Orphaned files found: ${orphanedFilesFound}`);
  console.log(`   Orphaned files deleted: ${orphanedFilesDeleted}`);
  console.log(`   Missing files found: ${missingFilesFound}`);
  console.log(`   Missing files newly marked: ${missingFilesMarked}`);

  if (missingFilesFound > 0) {
    console.log("\n⚠️ ACTION REQUIRED:");
    console.log("   Some DB records reference missing files!");
  }

  return {
    success: errors.length === 0,
    orphanedFilesFound,
    orphanedFilesDeleted,
    missingFilesFound,
    missingFilesMarked,
    errors,
    timestamp: new Date().toISOString(),
  };
}

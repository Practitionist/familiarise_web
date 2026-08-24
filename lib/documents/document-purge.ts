/**
 * Nightly purge of soft-deleted appointment documents.
 *
 * Soft delete (#doc-versions) tombstones the row and defers storage removal
 * so an accidental click is recoverable for a grace window. This job finishes
 * what the DELETE route deferred: remove the Supabase object first (DPDP —
 * bytes must not outlive their tombstone), then hard-delete the row. Rows
 * whose object is already gone (isStorageMissing) skip straight to deletion.
 */
import prisma from "@/lib/prisma";
import { deleteAppointmentDocument } from "@/lib/supabase";

const BATCH_SIZE = 50;

export async function purgeExpiredDeletedDocuments(
  graceDays: number,
): Promise<{ purged: number; failedStorage: number }> {
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);

  const candidates = await prisma.appointmentDocument.findMany({
    where: { deletedAt: { lt: cutoff } },
    select: {
      id: true,
      storagePath: true,
      isStorageMissing: true,
    },
    orderBy: { deletedAt: "asc" },
    take: BATCH_SIZE,
  });

  let purged = 0;
  let failedStorage = 0;

  for (const doc of candidates) {
    let storageCleared = doc.isStorageMissing;
    if (!storageCleared) {
      try {
        storageCleared = await deleteAppointmentDocument(doc.storagePath);
      } catch (error) {
        console.error(
          `[purge-deleted-documents] storage delete threw for ${doc.id}:`,
          error,
        );
        storageCleared = false;
      }
    }

    if (!storageCleared) {
      // Retry next night rather than orphaning the row without its bytes
      // being provably gone.
      failedStorage += 1;
      continue;
    }

    try {
      await prisma.appointmentDocument.delete({ where: { id: doc.id } });
      purged += 1;
    } catch (error) {
      // Row may have been cascade-deleted by its appointment in the interim —
      // treat P2025 as success.
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "P2025"
      ) {
        purged += 1;
        continue;
      }
      throw error;
    }
  }

  return { purged, failedStorage };
}

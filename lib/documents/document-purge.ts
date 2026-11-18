/**
 * The `purge-deleted-documents` job. Arm 1 tombstones the documents of
 * bookings past their retention date; arm 2 purges tombstones past the grace
 * window, versions before roots and each object before its row, so a thread is
 * never split. Failures are retried next run and reported once per run.
 */
import type { DocumentRemovalReason, Prisma } from "@prisma/client";

import prisma, { type Db, type PrismaLike } from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
// The marker-free leaf module, so this job can run from a bare Node process.
import { deleteAppointmentDocument } from "@/lib/supabase-storage-core";
import { reportSentryMessage } from "@/lib/observability/report";
import { KNOWN_HISTORY_ENTITIES } from "@/lib/booking/history-entities";
import {
  DOCUMENT_DELETE_GRACE_DAYS,
  DOCUMENT_RETENTION_DAYS,
} from "./document-dates";
import {
  documentBookingSelect,
  liveDocumentSessionWhere,
  toDocumentBooking,
} from "./document-party";

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 50;
/** Hard ceiling so a pathological run cannot sweep unbounded. */
const MAX_BATCHES_PER_RUN = 20;
const TERMINAL_STATUSES = ["CANCELLED", "REJECTED", "EXPIRED"];

type ReasonKey = DocumentRemovalReason | "UNRECORDED";

export interface PurgeDeletedDocumentsResult {
  success: boolean;
  tombstoned: number;
  failedTombstones: number;
  purged: number;
  failedStorage: number;
  failedRows: number;
  byReason: Partial<Record<ReasonKey, number>>;
  remaining: number;
}

function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - DOCUMENT_RETENTION_DAYS * DAY_MS);
}

/** Bookings that may be past retention; the pure date rule makes the final call. */
function retentionCandidateWhere(cutoff: Date): Prisma.AppointmentWhereInput {
  return {
    documents: { some: { deletedAt: null } },
    OR: [
      {
        statusHistory: {
          some: {
            entity: { in: [...KNOWN_HISTORY_ENTITIES] },
            toStatus: { in: TERMINAL_STATUSES },
            createdAt: { lt: cutoff },
          },
        },
      },
      { consultation: { cancelledAt: { lt: cutoff } } },
      { subscription: { cancelledAt: { lt: cutoff } } },
      {
        AND: [
          { occurrences: { some: liveDocumentSessionWhere } },
          {
            occurrences: {
              none: { ...liveDocumentSessionWhere, endsAt: { gte: cutoff } },
            },
          },
        ],
      },
    ],
  };
}

/** Arm 1: tombstone every live document of bookings whose retention date has passed. */
async function tombstoneExpiredBookings(
  now: Date,
  options: PurgeOptions,
): Promise<{ tombstoned: number; failed: number }> {
  const cutoff = retentionCutoff(now);
  // The caller's limit budgets rows to purge; each due booking here costs a
  // lock and a write, so cap this arm at the same number. Counting only due
  // bookings keeps a run with few expiries from spending its whole budget on
  // cheap candidate scans.
  const maxBookings = options.limit ?? Number.POSITIVE_INFINITY;
  let attempted = 0;
  let tombstoned = 0;
  let failed = 0;
  let afterId: string | undefined;
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    if (attempted >= maxBookings) break;
    const rows = await prisma.appointment.findMany({
      where: {
        ...retentionCandidateWhere(cutoff),
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: documentBookingSelect,
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;
    afterId = rows.at(-1)!.id;

    for (const row of rows) {
      if (attempted >= maxBookings) break;
      const booking = toDocumentBooking(row, now);
      if (!booking?.keptUntil || booking.keptUntil > now) continue;
      attempted += 1;
      // Re-read under the booking lock: a reschedule or a subscription
      // extension between the candidate scan and the write moves `keptUntil`
      // into the future, and the tombstone must not outrun it. One contended
      // booking must not stop the others or the purge that follows.
      try {
        const count = await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT 1 FROM "Appointment" WHERE id = ${row.id} FOR UPDATE`;
          const fresh = await tx.appointment.findUnique({
            where: { id: row.id },
            select: documentBookingSelect,
          });
          const freshBooking = fresh ? toDocumentBooking(fresh, now) : null;
          if (!freshBooking?.keptUntil || freshBooking.keptUntil > now)
            return 0;
          const result = await tx.appointmentDocument.updateMany({
            where: { appointmentId: row.id, deletedAt: null },
            data: { deletedAt: now, removalReason: "RETENTION_EXPIRY" },
          });
          return result.count;
        });
        tombstoned += count;
      } catch (error) {
        failed += 1;
        console.error(`[purge-deleted-documents] tombstone ${row.id}:`, error);
      }
    }
  }
  return { tombstoned, failed };
}

interface PurgeCounts {
  purged: number;
  failedStorage: number;
  failedRows: number;
  byReason: Partial<Record<ReasonKey, number>>;
  /** Eligible tombstones still present after this run; retried next run. */
  remaining: number;
}

export interface PurgeOptions {
  /** Stop after this many rows have been attempted, purged or failed. */
  limit?: number;
}

/** Rows this call may delete: versions first, a root only once its thread is empty. */
function purgeableWhere(
  where: Prisma.AppointmentDocumentWhereInput,
): Prisma.AppointmentDocumentWhereInput {
  return {
    AND: [
      where,
      { deletedAt: { not: null } },
      {
        OR: [
          { rootDocumentId: { not: null } },
          { threadVersions: { none: {} } },
        ],
      },
    ],
  };
}

function siblingsOnPath(
  db: Pick<Db, "appointmentDocument">,
  doc: { id: string; storagePath: string },
): Promise<number> {
  return db.appointmentDocument.count({
    where: { storagePath: doc.storagePath, id: { not: doc.id } },
  });
}

/**
 * Deletes tombstoned rows matching `where`: versions first, a root only once
 * no row of its thread remains, and each object before its row. `remaining`
 * is the count the caller could not finish, so a capped run never reports a
 * complete erasure.
 */
export async function purgeTombstonedDocuments(
  where: Prisma.AppointmentDocumentWhereInput,
  db: Pick<Db, "appointmentDocument"> = prisma,
  options: PurgeOptions = {},
): Promise<PurgeCounts> {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const purgeable = purgeableWhere(where);
  const counts: PurgeCounts = {
    purged: 0,
    failedStorage: 0,
    failedRows: 0,
    byReason: {},
    remaining: 0,
  };
  // Rows attempted this run are excluded so a failing row cannot spin the loop.
  const attempted = new Set<string>();

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    if (attempted.size >= limit) break;
    const take = Math.min(
      BATCH_SIZE,
      Number.isFinite(limit) ? limit - attempted.size : BATCH_SIZE,
    );
    const candidates = await db.appointmentDocument.findMany({
      where: {
        AND: [
          purgeable,
          ...(attempted.size > 0 ? [{ id: { notIn: [...attempted] } }] : []),
        ],
      },
      select: {
        id: true,
        storagePath: true,
        isStorageMissing: true,
        removalReason: true,
      },
      orderBy: { deletedAt: "asc" },
      take,
    });
    if (candidates.length === 0) break;

    for (const doc of candidates) {
      if (attempted.size >= limit) break;
      attempted.add(doc.id);
      // Only live rows are unique on a path; a sibling row still owns the object.
      const shared =
        !doc.isStorageMissing && (await siblingsOnPath(db, doc)) > 0;
      const storageCleared =
        doc.isStorageMissing ||
        shared ||
        (await deleteAppointmentDocument(doc.storagePath).catch(() => false));
      if (!storageCleared) {
        counts.failedStorage += 1;
        continue;
      }
      try {
        await db.appointmentDocument.deleteMany({ where: { id: doc.id } });
        counts.purged += 1;
        const key: ReasonKey = doc.removalReason ?? "UNRECORDED";
        counts.byReason[key] = (counts.byReason[key] ?? 0) + 1;
      } catch (error) {
        console.error(`[purge-deleted-documents] row ${doc.id}:`, error);
        counts.failedRows += 1;
        continue;
      }
      // A concurrent purge may have removed the sibling meanwhile; the last row out deletes the object.
      if (
        shared &&
        (await siblingsOnPath(db, doc)) === 0 &&
        !(await deleteAppointmentDocument(doc.storagePath).catch(() => false))
      ) {
        counts.failedStorage += 1;
      }
    }
    if (candidates.length < take) break;
  }
  counts.remaining = await db.appointmentDocument.count({
    where: purgeable,
  });
  return counts;
}

/** Tombstones past the delete grace window. */
function graceExpiredWhere(now: Date): Prisma.AppointmentDocumentWhereInput {
  return {
    deletedAt: {
      lt: new Date(now.getTime() - DOCUMENT_DELETE_GRACE_DAYS * DAY_MS),
    },
  };
}

/** Ticker idle probe: a retention candidate booking or a purgeable tombstone past grace. */
export async function hasDocumentPurgeWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const booking = await db.appointment.findFirst({
    where: retentionCandidateWhere(retentionCutoff(now)),
    select: { id: true },
  });
  if (booking) return true;
  if (outOfTime()) return true;
  const doc = await db.appointmentDocument.findFirst({
    where: purgeableWhere(graceExpiredWhere(now)),
    select: { id: true },
  });
  return doc !== null;
}

async function purgeDeletedDocumentsUnlocked(
  now: Date,
  options: PurgeOptions,
): Promise<PurgeDeletedDocumentsResult> {
  const { tombstoned, failed: failedTombstones } =
    await tombstoneExpiredBookings(now, options);
  const counts = await purgeTombstonedDocuments(
    graceExpiredWhere(now),
    prisma,
    options,
  );

  const failed = failedTombstones + counts.failedStorage + counts.failedRows;
  // A capped run is expected to leave rows; only an uncapped run that still
  // has work after its ceiling is a backlog worth a page.
  const backlog = counts.remaining > 0 && options.limit === undefined;
  if (failed > 0 || backlog) {
    reportSentryMessage("purge-deleted-documents left rows for the next run", {
      subsystem: "documents",
      op: "purge-deleted-documents",
      level: "warning",
      extra: { tombstoned, failedTombstones, ...counts },
      fingerprint: ["purge-deleted-documents", "failures"],
    });
  }
  return { success: failed === 0, tombstoned, failedTombstones, ...counts };
}

/** Hourly: retention tombstones, then the grace-window purge. */
export function purgeDeletedDocuments(
  now: Date = new Date(),
  options: PurgeOptions = {},
): Promise<PurgeDeletedDocumentsResult> {
  return withCronLock("purge-deleted-documents", { failMode: "open" }, () =>
    purgeDeletedDocumentsUnlocked(now, options),
  );
}

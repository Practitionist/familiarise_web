/**
 * The lifecycle both notify-only interest lists share: the appointment waitlist
 * (`AppointmentWaitlist`, "Notify me" on a sold-out event) and slot backup
 * interest (`WindowBackupInterest`, a held 1:1 window). Rows go WAITING →
 * NOTIFIED → BOOKED or EXPIRED; a NOTIFIED row is eligible again after the
 * cooldown, and settled rows are deleted after the retention period.
 */

import { BackupInterestStatus, type Prisma } from "@prisma/client";

import type { PrismaLike } from "@/lib/prisma";

/** A notified row is eligible again after this; at most two notices a day per row. */
export const INTEREST_RENOTIFY_COOLDOWN_MS = 12 * 60 * 60_000;
/** Settled (EXPIRED or BOOKED) rows are deleted this long after their last change. */
export const INTEREST_RETENTION_MS = 30 * 24 * 60 * 60_000;

export const OPEN_INTEREST: BackupInterestStatus[] = [
  BackupInterestStatus.WAITING,
  BackupInterestStatus.NOTIFIED,
];
export const SETTLED_INTEREST: BackupInterestStatus[] = [
  BackupInterestStatus.EXPIRED,
  BackupInterestStatus.BOOKED,
];

/** The cooldown window `now` falls in; notice dedupe keys carry it. */
export function renoticeBucket(now: Date): number {
  return Math.floor(now.getTime() / INTEREST_RENOTIFY_COOLDOWN_MS);
}

/** WAITING, or NOTIFIED before the cooldown; the read and the claim CAS both use it. */
export function notifiableInterest(now: Date) {
  return {
    OR: [
      { status: BackupInterestStatus.WAITING },
      {
        status: BackupInterestStatus.NOTIFIED,
        notifiedAt: {
          lt: new Date(now.getTime() - INTEREST_RENOTIFY_COOLDOWN_MS),
        },
      },
    ],
  };
}

function retentionCutoff(now: Date): Date {
  return new Date(now.getTime() - INTEREST_RETENTION_MS);
}

/** Settled event-waitlist rows past retention, by their last write. */
export function purgeableEventWaitlistWhere(
  now: Date,
): Prisma.AppointmentWaitlistWhereInput {
  return {
    status: { in: SETTLED_INTEREST },
    updatedAt: { lt: retentionCutoff(now) },
  };
}

/** Settled backup-interest rows past retention; nothing can change a row after its window ends. */
export function purgeableBackupInterestWhere(
  now: Date,
): Prisma.WindowBackupInterestWhereInput {
  return {
    status: { in: SETTLED_INTEREST },
    windowEnd: { lt: retentionCutoff(now) },
  };
}

/** Delete at most `limit` settled event-waitlist rows past retention. */
export async function purgeSettledEventWaitlist(
  db: Pick<PrismaLike, "appointmentWaitlist">,
  now: Date,
  limit: number,
): Promise<number> {
  const where = purgeableEventWaitlistWhere(now);
  const rows = await db.appointmentWaitlist.findMany({
    where,
    select: { id: true },
    take: limit,
  });
  if (rows.length === 0) return 0;
  const { count } = await db.appointmentWaitlist.deleteMany({
    where: { ...where, id: { in: rows.map((r) => r.id) } },
  });
  return count;
}

/** Delete at most `limit` settled backup-interest rows past retention. */
export async function purgeSettledBackupInterest(
  db: Pick<PrismaLike, "windowBackupInterest">,
  now: Date,
  limit: number,
): Promise<number> {
  const where = purgeableBackupInterestWhere(now);
  const rows = await db.windowBackupInterest.findMany({
    where,
    select: { id: true },
    take: limit,
  });
  if (rows.length === 0) return 0;
  const { count } = await db.windowBackupInterest.deleteMany({
    where: { ...where, id: { in: rows.map((r) => r.id) } },
  });
  return count;
}

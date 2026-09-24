/**
 * #1778 — "Notify me if this time opens": a learner's backup interest in a
 * 1:1 window someone else holds.
 *
 * Notify-only by design: nothing is reserved and the lock/CAS machinery is
 * untouched, so when a held window is released every WAITING learner is told
 * at once and the first to book gets it. Rows are staged by the release paths
 * (decline, cancel, withdraw, the lapse sweep, the dead-hold reclaim and
 * checkout's superseded holds) inside their own transaction, and drained by
 * the outbox relays after the commit (ADR 27).
 */

import { AppointmentsType, BackupInterestStatus, Prisma } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { stageBell } from "@/lib/novu/stage-bell";
import {
  stageWindowOpenedEmail,
  type StagedRecipientEmail,
} from "@/lib/email/senders/booking";
import { BookingRuleError } from "./booking-rule-error";

/** A learner may wait on at most this many windows at once. */
export const BACKUP_INTEREST_CAP = 3;

const OPEN: BackupInterestStatus[] = [
  BackupInterestStatus.WAITING,
  BackupInterestStatus.NOTIFIED,
];

export interface BackupWindow {
  consultantProfileId: string;
  windowStart: Date;
  windowEnd: Date;
}

/** Rows whose window overlaps [start, end). */
const overlapping = (
  w: BackupWindow,
): Prisma.WindowBackupInterestWhereInput => ({
  consultantProfileId: w.consultantProfileId,
  windowStart: { lt: w.windowEnd },
  windowEnd: { gt: w.windowStart },
});

/** F-2 — register (idempotent on the window), capped at three WAITING rows. */
export async function registerBackupInterest(args: {
  userId: string;
  consultantProfileId: string;
  windowStart: Date;
  windowEnd: Date;
  planKind: AppointmentsType;
  planId?: string | null;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  if (args.windowEnd <= now || args.windowEnd <= args.windowStart) {
    throw new BookingRuleError(
      "BACKUP_WINDOW_PAST",
      "That time has already passed.",
      400,
    );
  }
  return prisma.$transaction(
    async (tx) => {
      const key = {
        consultantProfileId_userId_windowStart: {
          consultantProfileId: args.consultantProfileId,
          userId: args.userId,
          windowStart: args.windowStart,
        },
      };
      const existing = await tx.windowBackupInterest.findUnique({
        where: key,
        select: { id: true, status: true },
      });
      if (existing?.status === BackupInterestStatus.WAITING) return existing;
      const waiting = await tx.windowBackupInterest.count({
        where: { userId: args.userId, status: BackupInterestStatus.WAITING },
      });
      if (waiting >= BACKUP_INTEREST_CAP) {
        throw new BookingRuleError(
          "BACKUP_INTEREST_CAP",
          `You can wait on at most ${BACKUP_INTEREST_CAP} times at once — withdraw one to add another.`,
        );
      }
      return tx.windowBackupInterest.upsert({
        where: key,
        create: {
          consultantProfileId: args.consultantProfileId,
          userId: args.userId,
          windowStart: args.windowStart,
          windowEnd: args.windowEnd,
          planKind: args.planKind,
          planId: args.planId ?? null,
        },
        update: {
          status: BackupInterestStatus.WAITING,
          windowEnd: args.windowEnd,
          notifiedAt: null,
          bookedAt: null,
        },
        select: { id: true, status: true },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

/** F-2 — the learner withdraws; only their own open row moves. */
export function withdrawBackupInterest(userId: string, id: string) {
  return prisma.windowBackupInterest.updateMany({
    where: { id, userId, status: { in: OPEN } },
    data: { status: BackupInterestStatus.EXPIRED },
  });
}

/** F-2 — the learner's own open rows, soonest window first. */
export function listBackupInterest(userId: string) {
  return prisma.windowBackupInterest.findMany({
    where: { userId, status: { in: OPEN }, windowEnd: { gt: new Date() } },
    orderBy: { windowStart: "asc" },
    select: {
      id: true,
      consultantProfileId: true,
      windowStart: true,
      windowEnd: true,
      planKind: true,
      planId: true,
      status: true,
      consultantProfile: { select: { user: { select: { name: true } } } },
    },
  });
}

/** Where the notice sends the learner: the plan's checkout, window pre-filled. */
function bookHref(row: {
  consultantProfileId: string;
  planKind: AppointmentsType;
  planId: string | null;
  windowStart: Date;
  windowEnd: Date;
}): string {
  if (row.planId && row.planKind === AppointmentsType.CONSULTATION) {
    const q = new URLSearchParams({
      startsAt: row.windowStart.toISOString(),
      endsAt: row.windowEnd.toISOString(),
    });
    return `/checkout/plans/consultation/${row.planId}?${q.toString()}`;
  }
  return `/explore/experts/${row.consultantProfileId}`;
}

/**
 * F-3 — a held window was released: every WAITING row overlapping it flips to
 * NOTIFIED (the status in the WHERE) and a bell and an email are staged per
 * row, keyed on the row, so a second call stages nothing. Run it inside the
 * releasing transaction; attempt the returned emails after the commit.
 */
export async function stageBackupInterestNotices(
  tx: Tx,
  window: BackupWindow,
  now = new Date(),
): Promise<StagedRecipientEmail[]> {
  const rows = await tx.windowBackupInterest.findMany({
    where: { ...overlapping(window), status: BackupInterestStatus.WAITING },
    select: {
      id: true,
      userId: true,
      consultantProfileId: true,
      planKind: true,
      planId: true,
      windowStart: true,
      windowEnd: true,
      consultantProfile: { select: { user: { select: { name: true } } } },
    },
  });
  const emails: StagedRecipientEmail[] = [];
  for (const row of rows) {
    const claimed = await tx.windowBackupInterest.updateMany({
      where: { id: row.id, status: BackupInterestStatus.WAITING },
      data: { status: BackupInterestStatus.NOTIFIED, notifiedAt: now },
    });
    if (claimed.count === 0) continue;
    const consultantName = row.consultantProfile.user.name ?? "your consultant";
    const href = bookHref(row);
    await stageBell(tx, {
      workflowId: NOVU_WORKFLOWS.WINDOW_OPENED,
      recipients: [row.userId],
      payload: {
        consultantName,
        windowText: row.windowStart.toISOString(),
        dashboardUrl: href,
      },
      dedupeKey: `window-opened:${row.id}`,
    });
    emails.push(
      ...(await stageWindowOpenedEmail(tx, {
        interestId: row.id,
        userId: row.userId,
        consultantName,
        windowStart: row.windowStart,
        bookUrl: href,
      })),
    );
  }
  return emails;
}

/** F-4 — the booking user's own overlapping row is BOOKED; nobody else's. */
export function markBackupInterestBooked(
  tx: Pick<Tx, "windowBackupInterest">,
  userId: string,
  window: BackupWindow,
  now = new Date(),
) {
  return tx.windowBackupInterest.updateMany({
    where: { ...overlapping(window), userId, status: { in: OPEN } },
    data: { status: BackupInterestStatus.BOOKED, bookedAt: now },
  });
}

/** F-4 — rows whose window has passed are EXPIRED (the stale-request sweep). */
export async function expireBackupInterest(now = new Date()) {
  return prisma.windowBackupInterest.updateMany({
    where: { windowEnd: { lt: now }, status: { in: OPEN } },
    data: { status: BackupInterestStatus.EXPIRED },
  });
}

/**
 * F-3 — the one call a release path makes, inside its transaction and before
 * it frees the rows: every window this appointment still holds (tentative
 * holds only, unless a confirmed booking is being cancelled) tells its
 * waiting learners. A rollback takes the staged notices with it.
 */
export async function stageNoticesForAppointmentHolds(
  tx: Tx,
  appointmentId: string,
  opts: { includeConfirmed?: boolean } = {},
  now = new Date(),
): Promise<void> {
  const held = await tx.appointmentOccurrence.findMany({
    where: {
      appointmentId,
      deletedAt: null,
      completionStatus: "SCHEDULED",
      endsAt: { gt: now },
      consultantProfileId: { not: null },
      ...(opts.includeConfirmed ? {} : { isTentative: true }),
    },
    select: { consultantProfileId: true, startsAt: true, endsAt: true },
  });
  for (const row of held) {
    if (!row.consultantProfileId) continue;
    await stageBackupInterestNotices(
      tx,
      {
        consultantProfileId: row.consultantProfileId,
        windowStart: row.startsAt,
        windowEnd: row.endsAt,
      },
      now,
    );
  }
}

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

import prisma, { type Tx, type PrismaLike } from "@/lib/prisma";
import type { StagedTrigger } from "@/lib/novu/outbox";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { stageBells } from "@/lib/novu/stage-bell";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import {
  stageWindowOpenedEmail,
  whenText,
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

export interface StagedBackupInterestNotices {
  bells: StagedTrigger[];
  emails: StagedRecipientEmail[];
}

export async function flushBackupInterestNotices(
  bundle?: StagedBackupInterestNotices | null,
): Promise<void> {
  const bells = bundle?.bells ?? [];
  const emails = bundle?.emails ?? [];
  if (bells.length === 0 && emails.length === 0) return;
  await flushNotificationsAfter(
    {
      bells,
      emails:
        emails.length > 0 ? [{ rows: emails, emailType: "WINDOW_OPENED" }] : [],
    },
    "backup-interest.window-opened",
  );
}

/**
 * F-3 — a held window was released: every WAITING row overlapping it flips to
 * NOTIFIED (the status in the WHERE) and a bell and an email are staged per
 * row, keyed on the row, so a second call stages nothing. Run it inside the
 * releasing transaction; flush the returned bundle after the commit.
 */
export async function stageBackupInterestNotices(
  tx: Tx,
  window: BackupWindow,
  now = new Date(),
): Promise<StagedBackupInterestNotices> {
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
  const bells: StagedTrigger[] = [];
  const emails: StagedRecipientEmail[] = [];
  for (const row of rows) {
    const claimed = await tx.windowBackupInterest.updateMany({
      where: { id: row.id, status: BackupInterestStatus.WAITING },
      data: { status: BackupInterestStatus.NOTIFIED, notifiedAt: now },
    });
    if (claimed.count === 0) continue;
    const consultantName = row.consultantProfile.user.name ?? "your consultant";
    const href = bookHref(row);
    const viewer = await tx.user.findUnique({
      where: { id: row.userId },
      select: { timezone: true },
    });
    const bell = await stageBells(tx, {
      workflowId: NOVU_WORKFLOWS.WINDOW_OPENED,
      recipients: [row.userId],
      payload: {
        consultantName,
        // In the learner's own zone, as the email renders it.
        windowText: whenText(
          row.windowStart,
          viewer?.timezone ?? "Asia/Kolkata",
        ),
        dashboardUrl: href,
      },
      dedupeKey: `window-opened:${row.id}`,
    });
    bells.push(...bell);
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
  return { bells, emails };
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

// Shared by the expiry write and the stale-request sweep's idle probe.
function lapsedBackupInterestWhere(now: Date) {
  return {
    windowEnd: { lt: now },
    status: { in: OPEN },
  } satisfies Prisma.WindowBackupInterestWhereInput;
}

export async function hasLapsedBackupInterest(
  db: PrismaLike,
  now: Date,
): Promise<boolean> {
  const row = await db.windowBackupInterest.findFirst({
    where: lapsedBackupInterestWhere(now),
    select: { id: true },
  });
  return row !== null;
}

/** F-4 — rows whose window has passed are EXPIRED (the stale-request sweep). */
export async function expireBackupInterest(now = new Date()) {
  return prisma.windowBackupInterest.updateMany({
    where: lapsedBackupInterestWhere(now),
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
): Promise<StagedBackupInterestNotices> {
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
  const bells: StagedTrigger[] = [];
  const emails: StagedRecipientEmail[] = [];
  for (const row of held) {
    if (!row.consultantProfileId) continue;
    const staged = await stageBackupInterestNotices(
      tx,
      {
        consultantProfileId: row.consultantProfileId,
        windowStart: row.startsAt,
        windowEnd: row.endsAt,
      },
      now,
    );
    bells.push(...(staged?.bells ?? []));
    emails.push(...(staged?.emails ?? []));
  }
  return { bells, emails };
}

/**
 * A move freed these windows of a host (a reschedule replaced, a session went
 * back to the plan, a hold lapsed): tell the learners waiting on any window
 * the move did not take straight back. Staged in the releasing transaction;
 * the outbox relay delivers what the caller does not flush.
 */
export async function stageNoticesForFreedWindows(
  tx: Tx,
  consultantProfileId: string,
  freed: readonly { startsAt: Date; endsAt: Date }[],
  retaken: readonly { startsAt: Date; endsAt: Date }[] = [],
  now = new Date(),
): Promise<StagedBackupInterestNotices> {
  const bells: StagedTrigger[] = [];
  const emails: StagedRecipientEmail[] = [];
  for (const window of freed) {
    if (window.endsAt <= now) continue;
    const stillHeld = retaken.some(
      (row) => row.startsAt < window.endsAt && row.endsAt > window.startsAt,
    );
    if (stillHeld) continue;
    const staged = await stageBackupInterestNotices(
      tx,
      {
        consultantProfileId,
        windowStart: window.startsAt,
        windowEnd: window.endsAt,
      },
      now,
    );
    bells.push(...staged.bells);
    emails.push(...staged.emails);
  }
  return { bells, emails };
}

/**
 * When a booking's documents stop accepting changes and when they are deleted.
 * Pure, so the workspace, the hub, the libraries and the retention purge share
 * one rule. Client-safe.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Uploads, reviews and replies close this long after the last live session ends. */
export const DOCUMENT_UPLOAD_WINDOW_DAYS = 30;

/** Documents are tombstoned this long after the booking ends or is cancelled. */
export const DOCUMENT_RETENTION_DAYS = 90;

/** Tombstoned rows (and their objects) are purged after this grace window. */
export const DOCUMENT_DELETE_GRACE_DAYS = 7;

export interface DocumentDateInput {
  terminal: boolean;
  /** When the booking was cancelled, rejected or expired. */
  terminalAt: Date | null;
  /** `endsAt` of every live (not deleted, cancelled or rescheduled) session. */
  liveSessionEnds: readonly Date[];
  /** Subscriptions keep allocating sessions until their period ends. */
  activeUntil: Date | null;
}

export interface DocumentDates {
  lastSessionEndsAt: Date | null;
  /** Null while sessions remain (the window is open with no date yet). */
  uploadWindowClosesAt: Date | null;
  uploadWindowOpen: boolean;
  /** Null while the booking is still running. */
  keptUntil: Date | null;
}

/** True once a booking's documents are past retention and must not render. */
export function isPastRetention(
  keptUntil: Date | null,
  now: Date = new Date(),
): boolean {
  return keptUntil !== null && keptUntil.getTime() <= now.getTime();
}

const addDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * DAY_MS);

export function documentDates(
  input: DocumentDateInput,
  now: Date = new Date(),
): DocumentDates {
  const lastSessionEndsAt =
    input.liveSessionEnds.length > 0
      ? new Date(Math.max(...input.liveSessionEnds.map((d) => d.getTime())))
      : null;

  if (input.terminal) {
    const endedAt = input.terminalAt ?? lastSessionEndsAt ?? now;
    return {
      lastSessionEndsAt,
      uploadWindowClosesAt: endedAt,
      uploadWindowOpen: false,
      keptUntil: addDays(endedAt, DOCUMENT_RETENTION_DAYS),
    };
  }

  const ends = [lastSessionEndsAt, input.activeUntil].filter(
    (d): d is Date => d !== null,
  );
  const endedAt =
    ends.length > 0
      ? new Date(Math.max(...ends.map((d) => d.getTime())))
      : null;
  if (endedAt === null || endedAt > now) {
    return {
      lastSessionEndsAt,
      uploadWindowClosesAt: null,
      uploadWindowOpen: true,
      keptUntil: null,
    };
  }

  const closesAt = addDays(endedAt, DOCUMENT_UPLOAD_WINDOW_DAYS);
  return {
    lastSessionEndsAt,
    uploadWindowClosesAt: closesAt,
    uploadWindowOpen: now < closesAt,
    keptUntil: addDays(endedAt, DOCUMENT_RETENTION_DAYS),
  };
}

/**
 * #1569 — the miss predicates, in a module light enough for the money sweeps.
 * The make-up machine that owes each miss lives in class-sessions.ts.
 */

import type { Prisma } from "@prisma/client";

/** A cancelled session must be made up, and HELD, within this many days. */
export const MAKEUP_WINDOW_DAYS = 14;

/**
 * #1569 — a miss is a host-cancelled session or a voided one. Either keeps its
 * row, is owed a make-up within 14 days, or a refund; one row is never both.
 */
export const MISS_WHERE = {
  OR: [
    { completionStatus: "CANCELLED", hostCancelledAt: { not: null } },
    { completionStatus: "VOIDED", voidedAt: { not: null } },
  ],
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** A miss whose make-up or refund has not happened yet. */
export const UNSETTLED_MISS = {
  ...MISS_WHERE,
  seatsSettledAt: null,
  deletedAt: null,
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** When the session was lost; the make-up window runs from here. */
export const missedAt = (o: {
  hostCancelledAt?: Date | null;
  voidedAt?: Date | null;
}): Date | null => o.hostCancelledAt ?? o.voidedAt ?? null;

/**
 * A past session parked for a human (the ops needs-human list): the sweep could
 * not judge it, the detector declined a host no-show, maintenance cut it, or a
 * paid session had nobody join or no room. Its booking neither completes nor
 * releases earnings until ops decides.
 */
export const AWAITING_HUMAN = {
  completionStatus: "UNVERIFIED",
  deletedAt: null,
  OR: [
    { outcome: { in: ["INCONCLUSIVE", "HOST_ABSENT"] } },
    { outcome: null, meeting: { endedReason: "maintenance" } },
    // A free session nobody attended has no money to hold, so it completes.
    {
      outcome: { in: ["NOBODY_JOINED", "OFFLINE"] },
      appointment: {
        payment: { some: { paymentStatus: "SUCCEEDED", deletedAt: null } },
      },
    },
  ],
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** The ops needs-human list: the above, plus a paid trial that was voided (D4). */
export const NEEDS_HUMAN = {
  deletedAt: null,
  isTentative: false,
  OR: [
    AWAITING_HUMAN,
    {
      completionStatus: "VOIDED",
      seatsSettledAt: null,
      appointment: { trial: { paymentId: { not: null } } },
    },
  ],
} satisfies Prisma.AppointmentOccurrenceWhereInput;

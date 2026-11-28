/**
 * #1569 — when an earning may be released.
 *
 * The hold used to start at capture time, so a booking paid a month ahead was
 * payable weeks before the call happened and a refund after the session had
 * nothing left to claw back. The anchor is now the later of the capture and the
 * END of the last live occurrence, plus the type's hold hours; a reschedule that
 * moves the call moves the release with it.
 *
 * Its own module: `replaceOccurrence` and the allocator need it, and
 * `earnings-service` pulls Stream, Razorpay and Novu through its imports.
 */

import { EarningStatus, type Prisma } from "@prisma/client";

import type { PrismaLike, Tx } from "@/lib/prisma";
import { sumPaise } from "@/lib/payments/utils/money";
import { PAYOUT_CONSTANTS, type AppointmentType } from "./constants";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// #1569 — a voided session never anchors a hold: it was not delivered.
const DEAD_OCCURRENCE_STATUSES = [
  "CANCELLED",
  "RESCHEDULED",
  "VOIDED",
] as const;

/** Hours the type's earnings are held after the anchor. */
export function holdHoursFor(appointmentType: AppointmentType): number {
  return (
    PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS[appointmentType] ||
    PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS.CONSULTATION
  );
}

/** `max(captureTime, lastOccurrenceEndsAt) + holdHours`. */
export function computeHoldUntil(args: {
  capturedAt: Date;
  lastOccurrenceEndsAt: Date | null;
  holdHours: number;
}): Date {
  const anchor = Math.max(
    args.capturedAt.getTime(),
    args.lastOccurrenceEndsAt?.getTime() ?? 0,
  );
  return new Date(anchor + args.holdHours * HOUR_MS);
}

type NewExpertDb = {
  consultantEarnings: Pick<Tx["consultantEarnings"], "findFirst" | "aggregate">;
};

/**
 * `holdUntil` plus the new-expert days when the expert's first paid earning is
 * under the tenure window old (or they have none yet) or their lifetime share,
 * net of refunds, is below the threshold. A null hold stays null.
 */
export async function withNewExpertHold(
  db: NewExpertDb,
  consultantProfileId: string | null,
  holdUntil: Date | null,
  now = new Date(),
): Promise<Date | null> {
  if (!holdUntil || !consultantProfileId) return holdUntil;
  const first = await db.consultantEarnings.findFirst({
    where: { consultantProfileId, payment: { paymentStatus: "SUCCEEDED" } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  let isNew =
    !first ||
    now.getTime() - first.createdAt.getTime() <
      PAYOUT_CONSTANTS.NEW_EXPERT_TENURE_DAYS * DAY_MS;
  if (!isNew) {
    const lifetime = await db.consultantEarnings.aggregate({
      where: { consultantProfileId, status: { not: EarningStatus.REFUNDED } },
      _sum: { consultantSharePaise: true, refundedShareAmount: true },
    });
    isNew =
      sumPaise(lifetime._sum.consultantSharePaise) -
        sumPaise(lifetime._sum.refundedShareAmount) <
      PAYOUT_CONSTANTS.NEW_EXPERT_LIFETIME_SHARE_PAISE;
  }
  return isNew
    ? new Date(
        holdUntil.getTime() +
          PAYOUT_CONSTANTS.NEW_EXPERT_EXTRA_HOLD_DAYS * DAY_MS,
      )
    : holdUntil;
}

/**
 * Stamps `holdUntil` on the deferred consultant earnings `where` selects,
 * adding the new-expert days per payee; answers the rows stamped.
 */
export async function stampConsultantHolds(
  db: {
    consultantEarnings: Pick<
      Tx["consultantEarnings"],
      "findMany" | "findFirst" | "aggregate" | "updateMany"
    >;
  },
  where: Prisma.ConsultantEarningsWhereInput,
  holdUntil: Date,
): Promise<number> {
  const payees = await db.consultantEarnings.findMany({
    where,
    select: { consultantProfileId: true },
    distinct: ["consultantProfileId"],
  });
  let stamped = 0;
  for (const { consultantProfileId } of payees) {
    const res = await db.consultantEarnings.updateMany({
      where: { ...where, consultantProfileId },
      data: {
        holdUntil: await withNewExpertHold(db, consultantProfileId, holdUntil),
      },
    });
    stamped += res.count;
  }
  return stamped;
}

/** The end of the appointment's last live occurrence, or null when it has none. */
export async function lastLiveOccurrenceEnd(
  db: PrismaLike,
  appointmentId: string,
): Promise<Date | null> {
  const last = await db.appointmentOccurrence.findFirst({
    where: {
      appointmentId,
      deletedAt: null,
      completionStatus: { notIn: [...DEAD_OCCURRENCE_STATUSES] },
    },
    orderBy: { endsAt: "desc" },
    select: { endsAt: true },
  });
  return last?.endsAt ?? null;
}

/** Unreleased rows a session move re-anchors: a hold on a PENDING row freezes its status, not its date. */
const UNRELEASED = {
  OR: [
    { status: "PENDING" as const },
    { status: "HELD" as const, preHoldStatus: "PENDING" as const },
  ],
};

/**
 * Pull a reschedule's hold push back once its proposal ends, restored (withdraw,
 * expiry, decline) or confirmed (auto-confirm, accept): every unreleased hold later
 * than what the live sessions imply (plus the new-expert days) returns to it.
 * Never earlier than that; a NULL hold (an undelivered tranche) and a settled
 * subscription cycle's tranche are left alone.
 */
export async function restoreEarningsHold(
  db: PrismaLike,
  appointmentId: string,
): Promise<number> {
  const appointment = await db.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      appointmentType: true,
      payment: {
        where: { paymentStatus: "SUCCEEDED", deletedAt: null },
        select: { id: true },
      },
    },
  });
  if (!appointment || appointment.payment.length === 0) return 0;
  const lastEnd = await lastLiveOccurrenceEnd(db, appointmentId);
  const holdHours = holdHoursFor(
    appointment.appointmentType as AppointmentType,
  );
  // A settled subscription cycle keeps its own hold (cycle settle + hold).
  const where = {
    paymentId: { in: appointment.payment.map((p) => p.id) },
    ...UNRELEASED,
    holdUntil: { not: null },
    cycleOrdinal: null,
  };
  const select = {
    id: true,
    createdAt: true,
    holdUntil: true,
    consultantProfileId: true,
  } as const;
  const [consultantRows, orgRows] = await Promise.all([
    db.consultantEarnings.findMany({ where, select }),
    db.organizationEarnings.findMany({
      where,
      select: { id: true, createdAt: true, holdUntil: true },
    }),
  ]);
  const implied = (createdAt: Date) =>
    computeHoldUntil({
      capturedAt: createdAt,
      lastOccurrenceEndsAt: lastEnd,
      holdHours,
    });
  let moved = 0;
  for (const row of consultantRows) {
    const target = await withNewExpertHold(
      db,
      row.consultantProfileId,
      implied(row.createdAt),
    );
    if (!row.holdUntil || !target || row.holdUntil <= target) continue;
    const res = await db.consultantEarnings.updateMany({
      where: { id: row.id, ...UNRELEASED, holdUntil: row.holdUntil },
      data: { holdUntil: target },
    });
    moved += res.count;
  }
  for (const row of orgRows) {
    const target = implied(row.createdAt);
    if (!row.holdUntil || row.holdUntil <= target) continue;
    const res = await db.organizationEarnings.updateMany({
      where: { id: row.id, ...UNRELEASED, holdUntil: row.holdUntil },
      data: { holdUntil: target },
    });
    moved += res.count;
  }
  return moved;
}

/**
 * Re-anchor every unreleased earning of the appointment's payments after its
 * live occurrences changed (first allocation, top-up, reschedule). PENDING rows
 * and rows held from PENDING, which stay HELD; a READY or PAID row has already
 * left the hold, and a subscription tranche keeps the date its cycle stamped.
 * A consultant row's date carries the payee's new-expert days; an
 * organisation row's never does.
 *
 * The capture instant is the earnings row's own `createdAt` — Payment carries
 * no capture timestamp and its `createdAt` is order creation, which can sit
 * days earlier — and a hold is never moved EARLIER than it already is: a
 * recompute may only extend the wait, never shorten a release the capture
 * already promised.
 */
export async function recomputeEarningsHold(
  db: PrismaLike,
  appointmentId: string,
): Promise<number> {
  const appointment = await db.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      appointmentType: true,
      payment: {
        where: { paymentStatus: "SUCCEEDED", deletedAt: null },
        select: { id: true },
      },
    },
  });
  if (!appointment || appointment.payment.length === 0) return 0;

  const lastEnd = await lastLiveOccurrenceEnd(db, appointmentId);
  const holdHours = holdHoursFor(
    appointment.appointmentType as AppointmentType,
  );
  // A subscription tranche keeps its own date: only the completion path stamps
  // it, and once stamped a later session never moves it.
  const wherePendingHold = {
    paymentId: { in: appointment.payment.map((p) => p.id) },
    ...UNRELEASED,
    holdUntil: { not: null },
    cycleOrdinal: null,
  };
  const [pendingConsultant, pendingOrg] = await Promise.all([
    db.consultantEarnings.findMany({
      where: wherePendingHold,
      select: {
        id: true,
        createdAt: true,
        holdUntil: true,
        consultantProfileId: true,
      },
    }),
    db.organizationEarnings?.findMany({
      where: wherePendingHold,
      select: { id: true, createdAt: true, holdUntil: true },
    }) ?? Promise.resolve([]),
  ]);
  let moved = 0;
  for (const earning of pendingConsultant) {
    if (!earning.holdUntil) continue;
    // The new-expert days follow the payee, as at mint.
    const computed = await withNewExpertHold(
      db,
      earning.consultantProfileId,
      computeHoldUntil({
        capturedAt: earning.createdAt,
        lastOccurrenceEndsAt: lastEnd,
        holdHours,
      }),
    );
    if (!computed || computed.getTime() <= earning.holdUntil.getTime()) {
      continue;
    }
    const res = await db.consultantEarnings.updateMany({
      where: {
        id: earning.id,
        ...UNRELEASED,
        holdUntil: { lt: computed },
      },
      data: { holdUntil: computed },
    });
    moved += res.count;
  }
  for (const earning of pendingOrg) {
    if (!earning.holdUntil) continue;
    const computed = computeHoldUntil({
      capturedAt: earning.createdAt,
      lastOccurrenceEndsAt: lastEnd,
      holdHours,
    });
    if (computed.getTime() <= earning.holdUntil.getTime()) continue;
    const res = await db.organizationEarnings.updateMany({
      where: {
        id: earning.id,
        ...UNRELEASED,
        holdUntil: { lt: computed },
      },
      data: { holdUntil: computed },
    });
    moved += res.count;
  }
  return moved;
}

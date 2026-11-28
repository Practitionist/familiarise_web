/**
 * Resolve the refund facts for a WHOLE booking, not one appointment (#1006).
 *
 * Cancellation is a whole-booking act. Since #1554 every booking is ONE
 * Appointment wrapper with N occurrence rows: a subscription's wrapper carries
 * its Payment and gains an occurrence per allocated session, and a class's
 * wrapper carries every attendee's Payment and one participant row per seat
 * (a seat's own ledger is lib/booking/class-series.ts, #1780).
 *
 * The cancel route used to read the payment, the frozen policy snapshot and
 * the start time straight off the appointment it was handed, so:
 *
 *   - cancelling a subscription refunded NOTHING. The dashboards target the
 *     next actionable session, which never carries a Payment, so the route
 *     found no payment and skipped the refund block entirely while still
 *     cancelling every slot and the subscription itself.
 *   - the refund tier depended on WHICH session you cancelled from, and was
 *     computed from the earliest slot including already-delivered ones — so a
 *     live subscription whose first session is in the past always scored 0%.
 *
 * This module answers those questions once, against every appointment of the
 * booking: which payment funds it, whose terms were frozen at purchase, when
 * the next undelivered session starts, and how much has already been consumed.
 */

import { Prisma } from "@prisma/client";

import prisma, { type Db, type Tx } from "@/lib/prisma";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import {
  isCompletedOccurrence,
  sessionsTotalOf,
} from "@/lib/booking/entitlement";
import type { CancellationPolicyTerms } from "@/lib/payments/operations/cancellation-policy";
import {
  POLICY_TERMS_INCLUDE,
  termsFromPolicyRow,
} from "@/lib/payments/operations/cancellation-policy-store";
import { occurrenceRefundsPaise } from "@/lib/booking/class-series";
import { isSettleableVoidVerdict } from "@/lib/booking/misses";
import { countedReleases } from "@/lib/booking/released-sessions";
import {
  cancelWindowState,
  type SessionWindowState,
} from "@/lib/booking/session-window";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";

/** Slots that still represent an undelivered session. */
const LIVE_SLOT_STATUSES = ["SCHEDULED", "RESCHEDULED"] as const;

/** The refund quote's "next session" set: undelivered slots, never a voided or settled one. */
export const LIVE_SLOT_WHERE = {
  deletedAt: null,
  completionStatus: { in: [...LIVE_SLOT_STATUSES] },
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** A live session in a voided one's place (the same ordinal) makes it up. */
const MAKE_UP_STATUSES: ReadonlySet<string> = new Set([
  "SCHEDULED",
  "COMPLETED",
  "UNVERIFIED",
]);

/** A payment that funds its booking now: captured and not retired. */
export const LIVE_SUCCEEDED_PAYMENT_WHERE = {
  paymentStatus: "SUCCEEDED",
  deletedAt: null,
} as const satisfies Prisma.PaymentWhereInput;

export type BookingRefundContext = {
  /** The single SUCCEEDED payment funding this booking (zero-amount credit-funded included), if any. */
  paidPayment: {
    id: string;
    /** Gross captured — the base the policy percentage applies to. */
    amountPaise: number;
    /** #1161 — free_ (credit-funded) detection for the restoration rail. */
    paymentIntent: string;
    /** The plan price before discounts, credits and tax; zero on a free booking. */
    listPricePaise: number;
    /**
     * Gross less anything already given back. Callers must clamp to this: a
     * percentage of the gross overshoots on a payment with an earlier partial
     * refund, and the refund operation rejects the whole request rather than
     * paying the remainder.
     */
    refundablePaise: number;
  } | null;
  /**
   * #1499 — the terms the buyer was sold under, loaded from the immutable policy
   * version the booking points at. Always populated: a booking with no policy row
   * resolves to the platform ladder rather than to null, so no caller has to.
   */
  policy: CancellationPolicyTerms;
  /**
   * Hours until the earliest session that has not been delivered or cancelled,
   * capped by the shortest notice the consultee gave when moving that session;
   * null when the booking has no live session at all.
   */
  hoursUntilNextSession: number | null;
  /** Sessions delivered — COMPLETED or UNVERIFIED (#1006, #1766). */
  sessionsCompleted: number;
  /** Sessions still owed to the buyer. */
  sessionsRemaining: number;
  /**
   * #1766 — the plan entitlement a subscription was sold as (the frozen
   * `Subscription.sessionsTotal`, or the plan's total for an older row); null
   * for every other booking, which quotes off its slots.
   */
  sessionsTotal: number | null;
  /** Sessions a support refund removed from the plan (0 for any other booking). */
  sessionsRefunded: number;
  /**
   * One start instant (epoch ms, ascending) per session a plan cancel prices
   * at a notice tier: each confirmed session, and each session released for a
   * move at its original start, capped by the notice the consultee gave when
   * they released it.
   */
  scheduledStarts: number[];
  /** The instant `scheduledStarts` were measured at; the quote reads the same clock. */
  quotedAtMs: number;
  /**
   * Subscriptions: what the payment already got back for single sessions
   * (voids, incidents) and money-only support remedies. A session-count remedy
   * is counted through `sessionsRefunded` instead, never both.
   */
  alreadyRefundedPaise: number;
  /**
   * Slots of ANY status on the booking. Zero means no session was ever
   * scheduled, which is a different fact from "every session is terminal" —
   * and the two must not be conflated, because only the former means the
   * consultant never held time for this buyer.
   */
  slotsTotal: number;
  /** Slots of any status that were ever confirmed (not an unpaid tentative hold). */
  confirmedSlotsTotal: number;
  /** Where the booking stands against the clock; the cancel doors refuse unless BEFORE. */
  windowState: SessionWindowState;
  /**
   * Voided sessions a consultation's cancel refunds in full and settles: not settled, any negative
   * verdict on them confirmed, no make-up placed. Empty for a plan, whose voids settle with it.
   */
  unsettledVoidIds: string[];
};

/** Identifies a booking: the parent request/event, or a lone appointment. */
export type BookingRef = {
  /** Only used when no parent link is given (trials, unlinked appointments). */
  appointmentId?: string;
  consultationId?: string | null;
  subscriptionId?: string | null;
  classId?: string | null;
  webinarId?: string | null;
};

/**
 * The ONE Appointment row of the booking `ref` names. #1554 — a purchase is a
 * single wrapper and every event FK on it is unique, so an id and a parent
 * link identify the same row; the id wins when the caller already has it.
 */
export function bookingAppointmentFilter(
  ref: BookingRef,
): Prisma.AppointmentWhereInput {
  if (ref.appointmentId) return { id: ref.appointmentId };
  if (ref.subscriptionId) return { subscriptionId: ref.subscriptionId };
  if (ref.classId) return { classId: ref.classId };
  if (ref.consultationId) return { consultationId: ref.consultationId };
  if (ref.webinarId) return { webinarId: ref.webinarId };
  throw new Error("bookingAppointmentFilter: no booking identifier given");
}

/** The notice a never-replaced released session counts as: past every policy tier. */
const NEVER_REPLACED_NOTICE_HOURS = 24 * 365;

export async function resolveBookingRefundContext(
  ref: BookingRef,
  /**
   * Restrict the payment lookup to one buyer. Required for group events, where
   * every attendee's Payment hangs off the same appointment; omit it for 1:1
   * bookings, which have exactly one payer.
   */
  payerUserId?: string,
  /**
   * #1695 — the cancel route reads this INSIDE its appointment lock and
   * transaction, so a reschedule or capture landing between the quote and the
   * cancel cannot change the tier underneath it. A global-client read inside a
   * transaction deadlocks on the single-connection pool (#1435), so the
   * caller's client is threaded through.
   */
  db: Db | Tx = prisma,
): Promise<BookingRefundContext> {
  const row = await db.appointment.findFirst({
    // #1554 — one wrapper per booking: this is the row checkout created, so
    // it carries the payment and the frozen terms.
    where: { ...bookingAppointmentFilter(ref), deletedAt: null },
    // The refund quote's inputs in one joined statement; "query" loads each
    // relation separately. The selected columns and their values are unchanged.
    relationLoadStrategy: "join",
    select: {
      id: true,
      cancellationPolicy: POLICY_TERMS_INCLUDE,
      payment: {
        where: {
          // #1161 — no amount floor: a fully-credit-funded payment (amount 0,
          // free_ intent) must surface here or the cancel route's credit-
          // restoration branch can never fire (it was dead code behind this
          // filter — caught by the #1180 preview work).
          ...LIVE_SUCCEEDED_PAYMENT_WHERE,
          ...(payerUserId ? { userId: payerUserId } : {}),
        },
        select: {
          id: true,
          amount: true,
          // #1161 — free_ detection: a fully-credit-funded payment refunds as
          // credit restoration, which the amount-based tier math cannot see.
          paymentIntent: true,
          originalAmount: true,
          ...REFUNDABLE_BALANCE_SELECT,
        },
        orderBy: { createdAt: "asc" },
      },
      // #1766 — the unused-session quote measures against the plan.
      subscription: {
        select: {
          sessionsTotal: true,
          sessionsRefunded: true,
          subscriptionPlan: { select: { totalSessions: true } },
        },
      },
      occurrences: {
        // #1554 — every attendee of a class shares the appointment's
        // occurrences, so there is no per-payer subset to scope to; the payer
        // filter lives on the payment lookup above.
        where: { deletedAt: null },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          ordinal: true,
          completionStatus: true,
          isTentative: true,
          outcome: true,
          outcomeConfirmedAt: true,
          seatsSettledAt: true,
        },
      },
    },
  });

  const payments = row?.payment ?? [];
  const payment = payments[0];
  // More than one SUCCEEDED payment for one PAYER should be unreachable:
  // `@@unique([userId, appointmentId])` means one row per payer per
  // appointment, and the CHARGE_MEMBER overage side-charge is deliberately
  // created with `appointmentId: null` to avoid exactly that clash
  // (overage-settlement.ts). Which is precisely why this must not stay silent
  // — if it ever fires, the model has changed under us and a buyer is being
  // refunded less than they paid. #1554 — a class or webinar wrapper carries
  // one Payment per attendee, so the alarm is only meaningful once the lookup
  // is scoped to a payer (or the booking has exactly one: the 1:1 types).
  const singlePayer = !!payerUserId || (!ref.classId && !ref.webinarId);
  if (singlePayer && payments.length > 1) {
    // On the caller's client and awaited: inside a transaction a global-client
    // insert queues behind it on a one-connection pool, and a detached one outlives the commit.
    await recordSystemErrorSafe({
      db,
      organizationId: null,
      category: "PAYMENT",
      summary:
        `Booking carries ${payments.length} refundable payments; only the ` +
        `oldest is being refunded, so the buyer may be owed more`,
      err: new Error("MULTIPLE_REFUNDABLE_PAYMENTS"),
      context: { ref, payerUserId, paymentIds: payments.map((p) => p.id) },
    });
  }
  const paidPayment = payment
    ? {
        id: payment.id,
        amountPaise: Number(payment.amount),
        paymentIntent: payment.paymentIntent,
        listPricePaise: Number(payment.originalAmount),
        refundablePaise: refundableBalancePaise(
          Number(payment.amount),
          payment,
        ),
      }
    : null;

  // The terms that bind are the ones stamped on the row the buyer paid for; a
  // booking with none reads as the platform ladder, which is what it was sold
  // under.
  const policy = termsFromPolicyRow(row?.cancellationPolicy ?? null);

  const slots = row?.occurrences ?? [];
  const liveSlots = slots
    .filter((s) =>
      (LIVE_SLOT_STATUSES as readonly string[]).includes(s.completionStatus),
    )
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  const nowMs = Date.now();
  // A session that already ended but is not swept yet is not outstanding.
  const outstanding = liveSlots.filter(
    (s) => s.completionStatus === "RESCHEDULED" || s.endsAt.getTime() > nowMs,
  );
  // The notice the client gave when they released a session caps its notice.
  const floors =
    row && outstanding.length > 0
      ? await consulteeReleaseNoticeFloors(db, row.id)
      : new Map<number, number>();
  // A released session whose time has passed was never given a new one: it
  // counts as full notice, unless the client released it themselves.
  const noticeHoursOf = (s: (typeof liveSlots)[number]) => {
    const raw =
      s.completionStatus === "RESCHEDULED" && s.startsAt.getTime() <= nowMs
        ? NEVER_REPLACED_NOTICE_HOURS
        : (s.startsAt.getTime() - nowMs) / 3_600_000;
    const floor = floors.get(s.ordinal);
    return floor === undefined ? raw : Math.min(raw, floor);
  };
  // The booking's notice is the shortest effective notice among its
  // outstanding sessions; null with none left (the cancel door refuses
  // through cancelWindowState before it ever quotes).
  const hoursUntilNextSession =
    outstanding.length > 0
      ? Math.min(...outstanding.map((s) => noticeHoursOf(s)))
      : null;

  // One start per session a plan cancel prices on the calendar: a confirmed
  // session, or one released for a move (an unconfirmed SCHEDULED row is an
  // unpaid hold, not an entitlement). A released or learner-moved session
  // sits at its effective notice; every other session at its own start.
  const scheduledStarts = slots
    .filter((s) =>
      s.completionStatus === "SCHEDULED"
        ? !s.isTentative
        : s.completionStatus === "RESCHEDULED",
    )
    .map((s) =>
      s.completionStatus === "RESCHEDULED" || floors.has(s.ordinal)
        ? nowMs + noticeHoursOf(s) * 3_600_000
        : s.startsAt.getTime(),
    )
    .sort((a, b) => a - b);

  const sessionsCompleted = slots.filter(isCompletedOccurrence).length;
  const alreadyRefundedPaise =
    row?.subscription && payment
      ? (await occurrenceRefundsPaise(db, payment.id)) +
        (await moneyOnlySupportRefundsPaise(db, payment.id))
      : 0;
  const sessionsTotal = row?.subscription
    ? sessionsTotalOf(row.subscription)
    : null;
  const sessionsRefunded = row?.subscription?.sessionsRefunded ?? 0;
  // Sessions a support refund removed are not unscheduled entitlement.
  const schedulable =
    sessionsTotal === null ? null : sessionsTotal - sessionsRefunded;
  const windowState = cancelWindowState(slots, new Date(nowMs), {
    hasUnscheduledEntitlement:
      schedulable !== null &&
      schedulable - sessionsCompleted - scheduledStarts.length > 0,
  });

  // The day-14 sweep's own reading of a void: made up by a live session in its place, else owed.
  const madeUpOrdinals = new Set(
    slots
      .filter((s) => MAKE_UP_STATUSES.has(s.completionStatus))
      .map((s) => s.ordinal),
  );
  const unsettledVoidIds = row?.subscription
    ? []
    : slots
        .filter(
          (s) =>
            s.completionStatus === "VOIDED" &&
            s.seatsSettledAt === null &&
            isSettleableVoidVerdict(s) &&
            !madeUpOrdinals.has(s.ordinal),
        )
        .map((s) => s.id);

  return {
    paidPayment,
    policy,
    hoursUntilNextSession,
    sessionsCompleted,
    sessionsRemaining: liveSlots.length,
    slotsTotal: slots.length,
    confirmedSlotsTotal: slots.filter((s) => !s.isTentative).length,
    sessionsTotal,
    sessionsRefunded,
    scheduledStarts,
    quotedAtMs: nowMs,
    alreadyRefundedPaise,
    windowState,
    unsettledVoidIds,
  };
}

/**
 * Live money-only support refunds (goodwill) on a payment: an advance against
 * what the plan owes, so a cancel nets them as the plan end does. A
 * session-count remedy is netted through `sessionsRefunded` instead.
 */
async function moneyOnlySupportRefundsPaise(
  db: Pick<Tx, "refund">,
  paymentId: string,
): Promise<number> {
  const rows = await db.refund.findMany({
    where: {
      paymentId,
      status: { in: ["SUCCEEDED", "PENDING"] },
      supportRecommendation: { is: { sessionsRemoved: null } },
    },
    select: { amountPaise: true },
  });
  return rows.reduce((sum, r) => sum + Number(r.amountPaise), 0);
}

/**
 * The clock state of a group event (or any booking with no refund context),
 * read on the caller's client so the cancel transaction sees its own snapshot.
 */
export async function readCancelWindowState(
  db: Db | Tx,
  appointmentId: string,
  now: Date = new Date(),
): Promise<SessionWindowState> {
  const occurrences = await db.appointmentOccurrence.findMany({
    where: { appointmentId, deletedAt: null },
    select: {
      startsAt: true,
      endsAt: true,
      completionStatus: true,
      isTentative: true,
    },
  });
  return cancelWindowState(occurrences, now);
}

/**
 * Per session (its ordinal), the shortest notice the consultee side gave when
 * it moved it, read from the release records on its reschedule requests: the
 * original start against the instant of the release.
 */
async function consulteeReleaseNoticeFloors(
  db: Db | Tx,
  appointmentId: string,
): Promise<Map<number, number>> {
  const releases = await countedReleases(db, {
    appointmentId,
    initiatorRole: "CONSULTEE",
  });
  const floors = new Map<number, number>();
  for (const release of releases) {
    for (const session of release.sessions) {
      const hours =
        (new Date(session.startsAt).getTime() - release.createdAt.getTime()) /
        3_600_000;
      if (hours < 0) continue;
      const known = floors.get(session.ordinal);
      floors.set(
        session.ordinal,
        known === undefined ? hours : Math.min(known, hours),
      );
    }
  }
  return floors;
}

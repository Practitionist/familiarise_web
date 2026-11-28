// Resumes or supersedes this buyer's open PENDING order for the same booking
// before any new gateway order is minted.

import { isPreMintIntent } from "@/lib/payments/pre-mint-intent";
import {
  flushBackupInterestNotices,
  stageNoticesForAppointmentHolds,
  type StagedBackupInterestNotices,
} from "@/lib/booking/backup-interest";
import { reportSentryError } from "@/lib/observability/report";
import { releaseParticipant } from "@/lib/booking/participants";
import {
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
  transitionSubscriptionRequest,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import prisma, { type Tx } from "@/lib/prisma";
import { PaymentGateway, PaymentStatus } from "@prisma/client";
import {
  releasableHeldCreditsPaise,
  reverseCreditsForPayment,
} from "@/lib/referrals/service";
import type { CheckoutInput } from "@/schemas/checkout";
import { returnDiscountUse } from "@/lib/payments/checkout/discount-use";
import { reverseBookingUtilization } from "@/lib/api/organizations/program-helpers";

// Limits for checkout's transactions before the commit (pricing, in-lock checks, hold release);
// pricing plus the in-lock checks at 8 s each leave room under the ~26 s edge timeout.
export const CHECKOUT_PRE_COMMIT_TX_OPTIONS = {
  maxWait: 2_000,
  timeout: 8_000,
} as const;

/** Why a superseded open order's booking was cancelled (#1463). */
export const SUPERSEDED_HOLD_NOTE =
  "Superseded by a newer checkout attempt for the same booking";

/**
 * Rec C (bugs/finances/checkout-webhooks-idempotency.md Q2) — a checkout
 * remount or new tab mints a FRESH clientIdempotencyKey, so #828's same-key
 * replay sees nothing and a naive flow mints a PARALLEL Razorpay order for
 * the same user+plan — parallel charges. Before any gateway call we adopt an
 * open PENDING payment for the same user+plan(+org) whose expiresAt window
 * is still live and hand its orderId back so every mount resumes the SAME
 * order.
 *
 * The scope is deliberately tight: userId equality, status PENDING,
 * expiresAt strictly in the future (respect the minted window), same routed
 * gateway (a Razorpay order cannot be resumed through Stripe.js or vice
 * versa — the replay path refuses cross-gateway resume for the same reason),
 * soft-deletes excluded, and plan identity resolved through the appointment
 * join (Payment carries no planId column). Legitimate repeat purchases are
 * unaffected: once the hold expires or is cancelled, the row is no longer
 * (PENDING ∧ fresh) and the next attempt mints fresh.
 *
 * Race-safe without a claim column: every schema-valid checkout input takes
 * a distributed lock keyed identically for the same user+plan (consultee +
 * slot atoms for slot shapes, event-checkout:<type>:<event|plan> otherwise),
 * so two concurrent remounts serialize before reaching here and the loser
 * observes the winner's COMMITTED row; same-key duplicates stay covered by
 * the clientIdempotencyKey unique (#828 P2002 replay).
 */
/** A resumable open order — the fields the resume response needs. */
export interface ReusableOrder {
  id: string;
  paymentIntent: string;
  amount: number;
  currency: string;
  isMockPayment: boolean;
  /** #1861 L1 — the hold's end, echoed so Checkout can time out before it. */
  expiresAt?: Date | null;
  /** The booked window's slot rows (consultation/class shape); empty for
   *  subscription placeholders whose period lives on the slot rows too. */
  appointment?: {
    occurrences: Array<{ startsAt: Date; endsAt: Date }>;
  } | null;
}

/**
 * The [start, end) a set of slot rows actually covers.
 *
 * #1463 — a booked window is stored as N contiguous 30-minute atoms (#1319), so
 * the window gate below cannot read the first row's endpoints: for anything
 * longer than half an hour the first atom ends 30 minutes into the booking and
 * every resume was rejected as a slot-window mismatch. The run's first start and
 * last end are the window.
 */
export function slotRunWindow(
  slots: Array<{ startsAt: Date; endsAt: Date }> | undefined,
): { startsAt: Date; endsAt: Date } | null {
  if (!slots || slots.length === 0) return null;
  return {
    startsAt: new Date(Math.min(...slots.map((s) => s.startsAt.getTime()))),
    endsAt: new Date(Math.max(...slots.map((s) => s.endsAt.getTime()))),
  };
}

/** The buyer's checkout target: the same item is the same buyer, scope, gateway and booking. */
export interface OpenOrderTarget {
  userId: string;
  appointmentType: "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" | "CLASS";
  planId: string;
  eventId?: string;
  organizationId: string | null;
  paymentGateway: PaymentGateway;
  /** Slot window for direct bookings — a resume must be for THIS time, not just this plan. */
  slotWindow?: { startsAt: Date; endsAt: Date };
  /** Subscription billing-period window; both-null rows only match a
   *  both-null request. */
  schedulingPeriod?: { startsAt: Date; endsAt: Date } | null;
  /** A non-renewal subscription whose start the server takes from its own clock. */
  startsNow?: boolean;
}

/** Clock skew allowed between the checkout's clamped start and the row's insert time. */
const START_NOW_SKEW_MS = 60_000;

/** A non-renewal subscription whose stored start is no later than its insert: its start was clamped to "now". */
function startedNow(sub: {
  schedulingPeriodStartsAt: Date;
  createdAt: Date;
  renewedFromSubscriptionId: string | null;
}): boolean {
  return (
    sub.renewedFromSubscriptionId === null &&
    sub.schedulingPeriodStartsAt.getTime() <=
      sub.createdAt.getTime() + START_NOW_SKEW_MS
  );
}

type OpenOrderVerdict =
  | {
      order: ReusableOrder & { discountCodeId: string | null };
      verdict: "same-item";
    }
  | { order: { id: string }; verdict: "superseded"; reason: string };

export async function findReusablePendingOrderPayment(
  db: Pick<Tx, "payment">,
  params: OpenOrderTarget & {
    /** This request's total; a candidate at another amount is superseded, never resumed. */
    expectedAmountPaise: number;
    /** This request's priced code; a candidate that spent another code's use is superseded. */
    expectedDiscountCodeId: string | null;
  },
): Promise<{
  reusable: ReusableOrder | null;
  /** Lapsed holds, released seats and same-window stale-price orders — the
   *  caller EXPIRES these ("superseded") so they can neither be resumed nor
   *  re-minted into a parallel charge. A live order for another window is
   *  neither reused nor superseded. */
  supersede: Array<{ id: string; reason: string }>;
}> {
  const supersede: Array<{ id: string; reason: string }> = [];
  for (const entry of await classifyOpenOrders(db, params)) {
    if (entry.verdict === "superseded") {
      supersede.push({ id: entry.order.id, reason: entry.reason });
      continue;
    }
    // A changed coupon, credit choice or tax profile prices differently: expire and mint fresh.
    if (entry.order.amount !== params.expectedAmountPaise) {
      supersede.push({ id: entry.order.id, reason: "amount-mismatch" });
      continue;
    }
    // Another code at the same amount still holds that code's use: release it and mint fresh.
    if (
      (entry.order.discountCodeId ?? null) !== params.expectedDiscountCodeId
    ) {
      supersede.push({ id: entry.order.id, reason: "discount-mismatch" });
      continue;
    }
    return { reusable: entry.order, supersede }; // newest match wins
  }
  return { reusable: null, supersede };
}

/** The reuse target of a checkout request; null for a type checkout never resumes. */
export function openOrderTargetOf(
  input: Pick<
    CheckoutInput,
    | "appointmentType"
    | "planId"
    | "eventId"
    | "startsAt"
    | "endsAt"
    | "schedulingPeriodStartsAt"
    | "schedulingPeriodEndsAt"
    | "paymentGateway"
    | "renewsSubscriptionId"
  >,
  userId: string,
  organizationId: string | null,
  resolvedSchedulingPeriod: { startsAt: Date; endsAt: Date } | null,
): OpenOrderTarget | null {
  const { appointmentType } = input;
  if (appointmentType === "TRIAL") return null;
  const requestedPeriod =
    input.schedulingPeriodStartsAt && input.schedulingPeriodEndsAt
      ? {
          startsAt: new Date(input.schedulingPeriodStartsAt),
          endsAt: new Date(input.schedulingPeriodEndsAt),
        }
      : null;
  return {
    userId,
    appointmentType,
    planId: input.planId,
    eventId: input.eventId,
    organizationId,
    paymentGateway: input.paymentGateway,
    ...(appointmentType === "CONSULTATION" && input.startsAt && input.endsAt
      ? {
          slotWindow: {
            startsAt: new Date(input.startsAt),
            endsAt: new Date(input.endsAt),
          },
        }
      : {}),
    ...(appointmentType === "SUBSCRIPTION"
      ? {
          schedulingPeriod: resolvedSchedulingPeriod ?? requestedPeriod,
          // No start, or one already past, is clamped by resolvePlanStart to the request's clock.
          startsNow:
            !input.renewsSubscriptionId &&
            (!input.schedulingPeriodStartsAt ||
              new Date(input.schedulingPeriodStartsAt).getTime() <= Date.now()),
        }
      : {}),
  };
}

/**
 * What the buyer's own live orders for this target hold: the credit their
 * release would make spendable, and the discount codes each spent a use of.
 */
export async function ownOpenOrderHolds(
  db: Pick<Tx, "payment" | "referralCreditUsage">,
  target: OpenOrderTarget,
): Promise<{ creditsPaise: number; discountCodeIds: string[] }> {
  const open = (await classifyOpenOrders(db, target)).flatMap((entry) =>
    entry.verdict === "same-item" ? [entry.order] : [],
  );
  return {
    creditsPaise: await releasableHeldCreditsPaise(
      db,
      target.userId,
      open.map((order) => order.id),
    ),
    discountCodeIds: open.flatMap((order) =>
      order.discountCodeId ? [order.discountCodeId] : [],
    ),
  };
}

/**
 * The buyer's PENDING orders for this target, newest first: lapsed holds and
 * released seats to supersede, and live same-item orders. Other windows are omitted.
 */
async function classifyOpenOrders(
  db: Pick<Tx, "payment">,
  params: OpenOrderTarget,
): Promise<OpenOrderVerdict[]> {
  // Plan identity per type — events are identified by their event row (the
  // plan is 1:1 with it); direct bookings by their plan id. An undefined
  // eventId would make Prisma drop the filter entirely (matches ANY
  // appointment), which is exactly the over-broad reuse we must never do.
  let planScope: Record<string, unknown> | null;
  switch (params.appointmentType) {
    case "CONSULTATION":
      planScope = { consultation: { consultationPlanId: params.planId } };
      break;
    case "SUBSCRIPTION":
      planScope = { subscription: { subscriptionPlanId: params.planId } };
      break;
    case "WEBINAR":
      planScope = params.eventId ? { webinarId: params.eventId } : null;
      break;
    case "CLASS":
      planScope = params.eventId ? { classId: params.eventId } : null;
      break;
    default:
      planScope = null;
  }
  if (!planScope) return [];

  const now = new Date();
  const candidates = await db.payment.findMany({
    where: {
      userId: params.userId,
      paymentStatus: PaymentStatus.PENDING,
      // Null-safe org equality: personal stays personal, sponsored matches sponsor.
      organizationId: params.organizationId,
      paymentGateway: params.paymentGateway,
      deletedAt: null,
      appointment: planScope,
    },
    orderBy: { createdAt: "desc" },
    take: 5, // bounded: newest attempts first; older ones get superseded below
    // One joined statement, even when there is no candidate to nest under.
    relationLoadStrategy: "join",
    select: {
      id: true,
      paymentIntent: true,
      amount: true,
      currency: true,
      isMockPayment: true,
      expiresAt: true,
      discountCodeId: true,
      appointment: {
        select: {
          occurrences: {
            select: { startsAt: true, endsAt: true },
            orderBy: { startsAt: "asc" as const },
            // #1463 — the whole run, not its first atom. Bounded well above any
            // single bookable window so a pathological row cannot widen the read.
            take: 48,
          },
          subscription: {
            select: {
              schedulingPeriodStartsAt: true,
              schedulingPeriodEndsAt: true,
              createdAt: true,
              renewedFromSubscriptionId: true,
            },
          },
          participants: {
            where: { userId: params.userId, role: "CONSULTEE" },
            select: { status: true },
          },
        },
      },
    },
  });

  const entries: OpenOrderVerdict[] = [];

  for (const candidate of candidates) {
    // #1478 — a PENDING row whose hold window has lapsed is never resumed,
    // and must be actively superseded so its tentative slot / participant seat
    // is released before the new booking writes (even if the cleanup cron has
    // not swept it yet).
    if (
      !candidate.expiresAt ||
      candidate.expiresAt.getTime() <= now.getTime()
    ) {
      entries.push({
        order: candidate,
        verdict: "superseded",
        reason: "hold-expired",
      });
      continue;
    }

    // A seat whose order is still being minted is someone's in-flight attempt.
    if (isPreMintIntent(candidate.paymentIntent)) continue;

    const appt = candidate.appointment;

    // A group order pays for the buyer's HELD seat; one released while the
    // order stayed open (a leave, a removal) is no longer theirs to resume.
    if (
      (params.appointmentType === "WEBINAR" ||
        params.appointmentType === "CLASS") &&
      !appt?.participants.some((seat) => seat.status === "HELD")
    ) {
      entries.push({
        order: candidate,
        verdict: "superseded",
        reason: "seat-released",
      });
      continue;
    }

    // Gate 1 — slot window: a checkout for a DIFFERENT time never resumes
    // this order, and never kills it either: a live order for another window
    // is another booking (open in another tab), and the consultee lock and
    // overlap check already guard the two against each other.
    if (params.appointmentType === "CONSULTATION") {
      const run = slotRunWindow(appt?.occurrences);
      if (
        !params.slotWindow ||
        run?.startsAt.getTime() !== params.slotWindow.startsAt.getTime() ||
        run.endsAt.getTime() !== params.slotWindow.endsAt.getTime()
      ) {
        continue;
      }
    }
    if (params.appointmentType === "SUBSCRIPTION") {
      const reqPeriod = params.schedulingPeriod ?? null;
      // Subscription windows ride the SAME slot rows as consultations when
      // direct-slot booked, or live on `appointment.subscription` when minted
      // as a scheduling-period placeholder (which has no occurrences yet).
      const subRow = appt?.subscription;
      const rowPeriod =
        slotRunWindow(appt?.occurrences) ??
        (subRow?.schedulingPeriodStartsAt && subRow?.schedulingPeriodEndsAt
          ? {
              startsAt: subRow.schedulingPeriodStartsAt,
              endsAt: subRow.schedulingPeriodEndsAt,
            }
          : null);
      // Two "start now" checkouts of one plan are one item while the order's hold is live;
      // otherwise a live order for another window or period is another booking: left alone.
      const bothStartNow =
        params.startsNow === true && !!subRow && startedNow(subRow);
      if (!bothStartNow && !!reqPeriod !== !!rowPeriod) continue;
      if (
        !bothStartNow &&
        reqPeriod &&
        rowPeriod &&
        (rowPeriod.startsAt.getTime() !== reqPeriod.startsAt.getTime() ||
          rowPeriod.endsAt.getTime() !== reqPeriod.endsAt.getTime())
      ) {
        continue;
      }
    }

    entries.push({ order: candidate, verdict: "same-item" });
  }

  return entries;
}

/**
 * #1463 — superseding an open order is a RELEASE, not just a status flip.
 *
 * Expiring the Payment row alone left the superseded attempt's tentative
 * appointment and slots occupying the calendar, so the very next attempt for
 * the same window hit "Time slot is already booked" again and the buyer was
 * walled in until the cleanup sweep ran. The hold has to go back at the same
 * moment its payment stops being payable, which is why the payment CAS, the
 * slot release and the parent request's cancellation all sit in one
 * transaction: a partial release is exactly the state that reopens the wall.
 *
 * Every write is CAS-in-WHERE per ADR 21 — the payment claim carries
 * `paymentStatus: PENDING` so a capture that landed a millisecond earlier wins
 * and its booking is left completely alone, and the appointment and slot moves
 * go through the guarded helpers in `lib/booking/transitions.ts` rather than a
 * bare update. A parent that has already moved on (its own payment succeeded)
 * throws `IllegalTransitionError`, which is caught per appointment so the rest
 * of the release still commits.
 *
 * Group events mint no per-buyer occurrence: a webinar or class seat is the
 * buyer's participant row on the event's own appointment. Superseding the
 * order without giving that row back is a permanent loss, not a temporary wall
 * — `isAlreadyRegistered` / `isUserEnrolled` read `liveParticipant`, which
 * counts HELD, so every later attempt by this buyer is refused over a seat
 * whose payment is EXPIRED. And no sweep reclaims it: the abandoned-payment
 * sweep cohorts on `paymentStatus: PENDING`, which this row no longer is. So
 * the event runs one seat short with nothing left to release it. The seat is
 * released here, in the same transaction that stops the payment being payable,
 * and only for this buyer's own row — other attendees' seats are not ours.
 */
export async function releaseSupersededHolds(params: {
  paymentIds: string[];
  userId: string;
}): Promise<void> {
  const holdNotices = await prisma.$transaction(async (tx: Tx) => {
    const claimWhere = {
      id: { in: params.paymentIds },
      userId: params.userId,
      paymentStatus: PaymentStatus.PENDING,
    };
    const claimData = {
      paymentStatus: PaymentStatus.EXPIRED,
      expiresAt: new Date(),
    };
    const claimed = await tx.payment.updateManyAndReturn({
      where: claimWhere,
      data: claimData,
      select: { id: true, appointmentId: true },
    });

    for (const row of claimed) {
      await reverseCreditsForPayment(row.id, tx);
      await returnDiscountUse(tx, row.id);
      await reverseBookingUtilization(tx, {
        paymentId: row.id,
        reason: SUPERSEDED_HOLD_NOTE,
      });
    }

    const appointmentIds = claimed
      .map((row) => row.appointmentId)
      .filter((id): id is string => id !== null);
    if (appointmentIds.length === 0) return { bells: [], emails: [] };

    const appointments = await tx.appointment.findMany({
      where: { id: { in: appointmentIds }, deletedAt: null },
      select: {
        id: true,
        webinarId: true,
        classId: true,
        consultation: { select: { id: true } },
        subscription: { select: { id: true } },
      },
    });

    const notices: StagedBackupInterestNotices = { bells: [], emails: [] };
    for (const appointment of appointments) {
      if (appointment.webinarId || appointment.classId) {
        // The seat, not an occurrence, is what this buyer gave up. Scoped to
        // their own row on this event, and a CAS on the live statuses, so a
        // second pass — or a capture that confirmed the seat first — matches
        // zero rows and changes nothing.
        await releaseParticipant(tx, {
          appointmentId: appointment.id,
          userId: params.userId,
        });
        continue;
      }

      // #1778 — the superseded hold frees its times: tell anyone waiting.
      const staged = await stageNoticesForAppointmentHolds(tx, appointment.id);
      notices.bells.push(...(staged?.bells ?? []));
      notices.emails.push(...(staged?.emails ?? []));
      // Doctrine rule 2: a slot is freed by status, never by DELETE — the
      // buyer keeps the record of the attempt they abandoned.
      await transitionOccurrenceCompletion(tx, {
        where: {
          appointmentId: appointment.id,
          isTentative: true,
          deletedAt: null,
        },
        to: "CANCELLED",
        data: { deletedAt: new Date() },
        reason: SUPERSEDED_HOLD_NOTE,
        actorUserId: params.userId,
        allowZero: true,
      });

      try {
        if (appointment.consultation) {
          await transitionConsultationRequest(tx, {
            where: { id: appointment.consultation.id },
            to: "CANCELLED",
            fromIn: ["PENDING", "APPROVED_PENDING_PAYMENT"],
            actorUserId: params.userId,
            reason: SUPERSEDED_HOLD_NOTE,
            data: {
              cancellationNotes: SUPERSEDED_HOLD_NOTE,
              cancelledAt: new Date(),
            },
          });
        }
        if (appointment.subscription) {
          await transitionSubscriptionRequest(tx, {
            where: { id: appointment.subscription.id },
            to: "CANCELLED",
            fromIn: ["PENDING"],
            actorUserId: params.userId,
            reason: SUPERSEDED_HOLD_NOTE,
            data: {
              cancellationNotes: SUPERSEDED_HOLD_NOTE,
              cancelledAt: new Date(),
            },
          });
        }
      } catch (error) {
        // The parent moved past the payment stage under us, which means some
        // other payment already carried it — that booking is not ours to
        // cancel. Modelled, so it is reported for visibility only.
        if (!(error instanceof IllegalTransitionError)) throw error;
        reportSentryError(error, {
          subsystem: "payments",
          level: "warning",
          expected: true,
          extra: { appointmentId: appointment.id },
        });
      }
    }
    return notices;
  }, CHECKOUT_PRE_COMMIT_TX_OPTIONS);
  await flushBackupInterestNotices(holdNotices);
}

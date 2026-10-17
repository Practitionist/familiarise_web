import { reportSentryError } from "@/lib/observability/report";
import prisma, { type PrismaLike, type Tx } from "@/lib/prisma";
import {
  recordSystemEvent,
  recordSystemErrorSafe,
} from "@/lib/enterprise/system-events";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import { getAppUrl } from "@/lib/url";
import { notifyRefundProcessed } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { goHref } from "@/lib/dashboard/go";
import { EMAIL_BUDGET_MS, sendRefundProcessedEmail } from "@/lib/email";
import { refundBookingPayment } from "./booking-refund";
import { RefundValidationError } from "./refund";
import {
  driveRefundOwed,
  markerFromRow,
  REFUND_OWED_SELECT,
  stampRefundsOwed,
  type RefundOwedMarker,
} from "./refund-owed";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import {
  isFreeCreditIntent,
  type FundingRail,
} from "@/lib/payments/funding-rail";
import { computeRefundPct } from "./cancellation-policy";
import {
  POLICY_TERMS_INCLUDE,
  termsFromPolicyRow,
} from "./cancellation-policy-store";
import { findLiveEventSlot } from "@/lib/appointments/live-event-slot";
import {
  seatLedger,
  occurrenceRefundsPaise,
  seriesCancelRefundPaise,
  type SeriesSeat,
} from "@/lib/booking/class-series";

/**
 * Whole-event refund: every attendee of a cancelled class or
 * webinar is refunded through the booking front door, one keyed refund per
 * seat, so each rail (gateway, in-ledger org funding, credits) settles exactly
 * as a single booking would.
 *
 * The seats are stamped owed in the cancelling commit
 * ({@link stampWholeEventRefundsOwed}), and this drives a bounded bite of them
 * inline; the retry-auto-refunds sweep drains the rest, so a large roster never
 * outlives the request.
 */

export type WholeEventRefundSummary = {
  refundsIssued: number;
  refundedPaise: number;
  childRefundIds: string[];
  failures: { paymentId: string; error: string }[];
  /** Seats whose balance was already fully refunded — a re-run, not an error. */
  skippedAlreadyRefunded: number;
  /** Seats stamped owed but left for the retry sweep once the inline bite was spent. */
  deferred: number;
  /** Every seat was a skip: nothing issued, deferred or failed. */
  alreadyRefunded: boolean;
};

/** Seats refunded inline before the rest is left to the retry sweep. */
const INLINE_SEAT_LIMIT = 10;
const INLINE_BUDGET_MS = 10_000;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type EventSeatPlan =
  | { kind: "owe"; marker: RefundOwedMarker }
  | { kind: "settled" }
  | { kind: "escalate"; delivered: number; partlyReturned: boolean };

type EventRefundArgs = {
  kind: "class" | "webinar";
  eventId: string;
  reason: string;
  /**
   * #1780 D-5 — per-seat class ledgers read BEFORE the cancel tombstoned the
   * sessions (classSeriesLedgers); each seat then refunds only what was not
   * delivered. Absent (a webinar, a moderation sweep) → every seat in full.
   */
  ledgers?: ReadonlyMap<string, SeriesSeat>;
  /** Scopes the seat keys to the calling door, so two doors never share one refund. */
  dedupeKeyPrefix?: string;
};

/**
 * What each SUCCEEDED seat of the event is owed, read on `db`: the undelivered
 * share clamped to the remaining balance, a whole credit restoration, a skip
 * when nothing is left, or an escalation the credits rail cannot pay.
 */
async function planEventSeats(
  db: PrismaLike,
  args: EventRefundArgs,
): Promise<{ paymentIds: string[]; plans: Map<string, EventSeatPlan> }> {
  const prefix = args.dedupeKeyPrefix ?? "event-cancel";
  const payments = await db.payment.findMany({
    where: {
      appointment:
        args.kind === "webinar"
          ? { webinarId: args.eventId }
          : { classId: args.eventId },
      paymentStatus: "SUCCEEDED",
      // Retired rows stay out: the front door refuses them.
      deletedAt: null,
    },
    select: {
      id: true,
      amount: true,
      paymentIntent: true,
      ...REFUNDABLE_BALANCE_SELECT,
    },
  });
  const creditStates = await creditSeatStates(
    db,
    payments
      .filter((p) => isFreeCreditIntent(p.paymentIntent))
      .map((p) => p.id),
  );
  const plans = new Map<string, EventSeatPlan>();
  for (const p of payments) {
    const ledger = args.ledgers?.get(p.id);
    const key = `${prefix}:${args.eventId}:pay:${p.id}`;
    const credit = creditStates.get(p.id);
    if (credit) {
      // The credits rail restores whole or not at all, so a seat delivered part
      // of the series, or already partly returned, is escalated to a human.
      if (credit.claimed && credit.stillUsedPaise <= 0) {
        plans.set(p.id, { kind: "settled" });
      } else if ((ledger && ledger.deliveredHeld > 0) || credit.claimed) {
        plans.set(p.id, {
          kind: "escalate",
          delivered: ledger?.deliveredHeld ?? 0,
          partlyReturned: credit.claimed,
        });
      } else {
        plans.set(p.id, {
          kind: "owe",
          marker: {
            paymentId: p.id,
            amountPaise: null,
            key,
            reason: args.reason,
          },
        });
      }
      continue;
    }
    const balance = refundableBalancePaise(Number(p.amount), p);
    // Sessions already refunded one by one (occ:*) are not owed again.
    const undelivered = ledger
      ? Number(seriesCancelRefundPaise(ledger, p.amount)) -
        (ledger.occRefundedPaise ?? 0)
      : balance;
    const owed = Math.min(undelivered, balance);
    plans.set(
      p.id,
      owed > 0
        ? {
            kind: "owe",
            marker: {
              paymentId: p.id,
              amountPaise: owed,
              key,
              reason: args.reason,
            },
          }
        : { kind: "settled" },
    );
  }
  return { paymentIds: payments.map((p) => p.id), plans };
}

/**
 * Stamps every owed seat of the event on the caller's transaction, in one
 * statement, so the commit that cancels the event also records what it owes.
 */
export async function stampWholeEventRefundsOwed(
  tx: Tx,
  args: EventRefundArgs,
): Promise<Map<string, EventSeatPlan>> {
  const { plans } = await planEventSeats(tx, args);
  await stampRefundsOwed(
    tx,
    [...plans.values()].flatMap((plan) =>
      plan.kind === "owe" ? [plan.marker] : [],
    ),
  );
  return plans;
}

export async function refundWholeEventPayments(
  kind: "class" | "webinar",
  eventId: string,
  reason: string,
  initiatedByUserId: string | null,
  opts: {
    ledgers?: ReadonlyMap<string, SeriesSeat>;
    dedupeKeyPrefix?: string;
  } = {},
): Promise<WholeEventRefundSummary> {
  const summary: WholeEventRefundSummary = {
    refundsIssued: 0,
    refundedPaise: 0,
    childRefundIds: [],
    failures: [],
    skippedAlreadyRefunded: 0,
    deferred: 0,
    alreadyRefunded: false,
  };
  const args: EventRefundArgs = { kind, eventId, reason, ...opts };

  // A door that stamped in its own commit makes this a no-op: the CAS keeps
  // the first marker on every seat.
  const plans = await prisma.$transaction((tx) =>
    stampWholeEventRefundsOwed(tx, args),
  );
  if (plans.size === 0) return summary;

  const owing: string[] = [];
  for (const [paymentId, plan] of plans) {
    if (plan.kind === "settled") {
      summary.skippedAlreadyRefunded += 1;
    } else if (plan.kind === "escalate") {
      summary.failures.push({
        paymentId,
        error:
          "partial credit restoration after delivered sessions needs a human",
      });
      await escalatePartialCredit(paymentId, {
        eventId,
        kind,
        delivered: plan.delivered,
        partlyReturned: plan.partlyReturned,
      });
    } else {
      owing.push(paymentId);
    }
  }

  const [rows, disputes] = await Promise.all([
    prisma.payment.findMany({
      where: { id: { in: owing }, refundOwedKey: { not: null } },
      orderBy: { refundOwedAt: "asc" },
      select: REFUND_OWED_SELECT,
    }),
    prisma.dispute.findMany({
      where: {
        paymentId: { in: owing },
        status: { notIn: DISPUTE_INACTIVE_FOR_GATING },
      },
      select: { paymentId: true, status: true },
    }),
  ]);
  const disputed = new Map(disputes.map((d) => [d.paymentId, d.status]));
  const markers = rows.flatMap((row) => markerFromRow(row) ?? []);
  // A seat planned owed whose marker is already gone was settled by a racing drive.
  summary.skippedAlreadyRefunded += owing.length - markers.length;

  const deadline = Date.now() + INLINE_BUDGET_MS;
  let driven = 0;
  let firstError: unknown;
  for (const marker of markers) {
    const dispute = disputed.get(marker.paymentId);
    if (dispute) {
      // The marker waits for the dispute; the sweep skips it until it resolves.
      summary.failures.push({
        paymentId: marker.paymentId,
        error: `Payment ${marker.paymentId} has an open dispute (${dispute}); resolve it before refunding`,
      });
      continue;
    }
    if (driven >= INLINE_SEAT_LIMIT || Date.now() >= deadline) {
      summary.deferred += 1;
      continue;
    }
    driven += 1;
    const outcome = await driveRefundOwed(marker, { initiatedByUserId });
    switch (outcome.kind) {
      case "refunded":
        summary.refundsIssued += 1;
        summary.refundedPaise += outcome.refund.amountRefundedPaise;
        summary.childRefundIds.push(outcome.refund.refundId);
        break;
      case "replayed":
      case "settled":
        summary.skippedAlreadyRefunded += 1;
        break;
      case "blocked":
        summary.failures.push({
          paymentId: marker.paymentId,
          error: `Payment ${marker.paymentId} has an open dispute; resolve it before refunding`,
        });
        break;
      case "failed":
        firstError ??= outcome.error;
        summary.failures.push({
          paymentId: marker.paymentId,
          error: errMsg(outcome.error),
        });
        break;
    }
  }
  // One Sentry event per call, never per seat.
  if (firstError !== undefined) {
    reportSentryError(firstError, {
      subsystem: "payments",
      tags: { feature: "whole-event-refund" },
      extra: { eventId, kind, failed: summary.failures.length },
    });
  }

  summary.alreadyRefunded =
    summary.refundsIssued === 0 &&
    summary.failures.length === 0 &&
    summary.deferred === 0 &&
    summary.skippedAlreadyRefunded === plans.size;

  return summary;
}

/**
 * #1780 D-5 — each paid class seat's ledger by payment id, joined at the later
 * of its participant row and its payment (a re-bought seat reuses the row).
 * The cancel route reads this BEFORE its transaction tombstones the sessions.
 */
export async function classSeriesLedgers(
  classId: string,
): Promise<Map<string, SeriesSeat>> {
  const payments = await prisma.payment.findMany({
    where: {
      appointment: { classId },
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
    },
    select: {
      id: true,
      amount: true,
      userId: true,
      createdAt: true,
      appointmentId: true,
    },
  });
  const seats = await prisma.appointmentParticipant.findMany({
    where: {
      appointment: { classId },
      userId: { in: payments.map((p) => p.userId) },
    },
    select: { userId: true, createdAt: true, sessionsPurchased: true },
  });
  const ledgers = new Map<string, SeriesSeat>();
  for (const p of payments) {
    if (!p.appointmentId) continue;
    const seat = seats.find((s) => s.userId === p.userId);
    const seatAt = seat?.createdAt;
    const joinedAt = seatAt && seatAt > p.createdAt ? seatAt : p.createdAt;
    ledgers.set(p.id, {
      ...(await seatLedger(
        prisma,
        {
          appointmentId: p.appointmentId,
          createdAt: joinedAt,
          sessionsPurchased: seat?.sessionsPurchased,
        },
        p.amount,
      )),
      occRefundedPaise: await occurrenceRefundsPaise(prisma, p.id),
    });
  }
  return ledgers;
}

/**
 * Refund ONE attendee's seat when the organiser removes them from a live
 * class/webinar (#1003).
 *
 * The participant-removal endpoints moved the roster and left the money alone:
 * a consultant could pull a paying attendee out of an event and keep the fee,
 * with no refund, no earnings reversal and no notice to the attendee. The
 * moderation bulk-cancel has always refunded a removed attendee in full; the
 * interactive endpoints were the outlier.
 *
 * ## Who initiated the removal matters for the % (#1005)
 *
 * Historically only organisers hit this helper, so it always passed
 * `isConsultantInitiated: true` into `computeRefundPct` (full
 * `consultantInitiatedPct`, clock ignored). Self-leave reused that path and
 * paid out organiser-fault money even after the session had started — the
 * dialog copy promised "under the event's cancellation policy", which is the
 * attendee notice tiers.
 *
 * Default remains `"organiser"` so existing roster/moderation callers keep the
 * full-refund behaviour without an explicit flag. Self-leave must pass
 * `"attendee"` and we resolve `hoursUntilStart` from the next future live slot
 * (`startsAt >= now`) so a mid-program class leave uses the upcoming session,
 * not a past COMPLETED/UNVERIFIED row that would force 0%.
 *
 * Never throws: the roster change has already committed.
 */
export async function refundRemovedAttendeeSeat(args: {
  kind: "class" | "webinar";
  eventId: string;
  attendeeUserId: string;
  initiatedByUserId: string | null;
  /**
   * Defaults to organiser (full tier). Pass `"attendee"` for consultee
   * self-leave so notice-window tiers apply.
   */
  initiatedBy?: "organiser" | "attendee";
  /**
   * #1780 — the seat-leave rule's answer (lib/booking/seat-leave.ts): `full`
   * refunds 100 % with no ladder; a class quote arrives as `amountPaise`.
   */
  mode?: "full";
  amountPaise?: number;
  /** #1780 — the seat's key; the payment id is appended (a re-bought seat is a new sale). */
  dedupeKey?: string;
  /**
   * The sale this refund is for, when the caller already knows it.
   *
   * Absent, the payment is re-derived below — which is the right answer for the
   * roster doors, where the actor names a SEAT and the rule is deliberately
   * "the one they bought first". It is the wrong answer for a capture that has
   * already landed on a known Payment: the capture's own seat is the NEWEST
   * participant row (pre-#1319 data holds one row per session appointment, so
   * `confirmSeatAfterCapture` re-reads newest-first), and on a class whose
   * legacy rows still carry a session payment apiece the re-derivation answers
   * with a DIFFERENT payment — refunding money the capture never took and
   * leaving the captured money with the buyer, on a seat that is not there.
   *
   * Addressing the payment by id keeps every rail decision below intact (credit
   * restoration, the org wallet/invoice/licence reversal, the gateway phases and
   * the attendee notice) — only the SELECT changes. It is still scoped to the
   * event and the buyer, so a payment for some other seat cannot be reached
   * through it.
   */
  paymentId?: string;
}): Promise<{
  amountRefundedPaise: number;
  refundPct: number;
  /**
   * Which rail returned the seat fee, or null when nothing moved. The
   * organiser's toast has to say where the money went, and only the gateway
   * rail reaches the attendee — an org-funded seat returns to the sponsor's
   * wallet, accrual or licence, which the attendee never held.
   */
  rail: FundingRail | null;
} | null> {
  const eventFilter =
    args.kind === "webinar"
      ? { webinarId: args.eventId }
      : { classId: args.eventId };
  // Missing flag = legacy organiser path; do not flip the money default.
  const isOrganiserInitiated =
    (args.initiatedBy ?? "organiser") === "organiser";

  // Hoisted so the catch can scope its ops event to the funding organisation;
  // a failure reported against `null` never reaches the org that is owed it.
  let organizationId: string | null = null;

  try {
    const payment = await prisma.payment.findFirst({
      // Deterministic: the seat they bought first is the one being released —
      // unless the caller named the sale, which is the only way this door can
      // be sure it is refunding the payment in front of it.
      ...(args.paymentId ? {} : { orderBy: { createdAt: "asc" } }),
      where: {
        ...(args.paymentId ? { id: args.paymentId } : {}),
        userId: args.attendeeUserId,
        appointment: eventFilter,
        paymentStatus: "SUCCEEDED",
        // #1780 decision 11 — credit-funded (free_, amount 0) seats are in:
        // they restore credits under the same rule (see creditSeatRefund).
        deletedAt: null,
      },
      select: {
        id: true,
        amount: true,
        paymentIntent: true,
        currency: true,
        organizationId: true,
        ...REFUNDABLE_BALANCE_SELECT,
        appointment: { select: { cancellationPolicy: POLICY_TERMS_INCLUDE } },
      },
    });
    if (!payment) return null;
    organizationId = payment.organizationId;
    const dedupeKey = args.dedupeKey
      ? `${args.dedupeKey}:pay:${payment.id}`
      : undefined;
    if (isFreeCreditIntent(payment.paymentIntent)) {
      return await creditSeatRefund(args, payment.id, dedupeKey);
    }

    // Organiser branch ignores the clock inside computeRefundPct; skip the
    // slot lookup. Attendee branch needs a real hoursUntilStart — negative
    // means already started → 0% under the tiers (and the DELETE route should
    // have 400'd before we got here for self-leave).
    let hoursUntilStart = -1;
    if (!isOrganiserInitiated && args.mode === undefined) {
      hoursUntilStart = await hoursUntilNextLive(eventFilter);
    }

    const grossPaise = Number(payment.amount);
    const refundPct = seatRefundPct(args, grossPaise, () =>
      computeRefundPct(
        termsFromPolicyRow(payment.appointment?.cancellationPolicy),
        hoursUntilStart,
        isOrganiserInitiated,
      ),
    );
    // #1396 — `refundPct` may carry two decimals (a policy can say 12.5%), so
    // multiplying paise by the float first put a binary rounding error inside a
    // money amount before the floor ever ran. Scale to integer basis points and
    // divide once, exactly as `computeBookingRefundQuote` in cancellation-policy
    // does; BigInt because the intermediate product leaves the safe-integer
    // range long before the amounts stop being real money.
    const policyRefundPaise =
      args.amountPaise ??
      Number(
        (BigInt(grossPaise) * BigInt(Math.round(refundPct * 100))) /
          BigInt(10_000),
      );
    // Clamp to the remaining balance, exactly as the cancel route does. A seat
    // carrying an earlier partial refund would otherwise ask for more than is
    // left, `refundPayment` would reject the whole request, and the attendee
    // would receive nothing of the remainder they are owed.
    const amountPaise = Math.min(
      policyRefundPaise,
      refundableBalancePaise(grossPaise, payment),
    );
    if (amountPaise <= 0)
      return { amountRefundedPaise: 0, refundPct, rail: null };

    const actorLabel = isOrganiserInitiated ? "organiser" : "attendee";
    const result = await refundBookingPayment({
      paymentId: payment.id,
      amountPaise,
      reason: `removed from ${args.kind} ${args.eventId} by the ${actorLabel} (${refundPct}%)`,
      ...(isOrganiserInitiated
        ? { customerReason: `You were removed from this ${args.kind}.` }
        : {}),
      initiatedByUserId: args.initiatedByUserId,
      dedupeKey,
    });

    // Gateway refunds with status SUCCEEDED stage notices inside refundPayment
    // Phase 3b, and PENDING refunds wait for the settlement webhook.
    if (result.rail === "GATEWAY" && !result.status) {
      await Promise.allSettled([
        notifyRefundProcessed(args.attendeeUserId, {
          ...notificationScope(payment.organizationId),
          amount: amountPaise,
          currency: payment.currency,
          reason: isOrganiserInitiated
            ? `You were removed from this ${args.kind}.`
            : `You left this ${args.kind}.`,
          dashboardUrl: `${getAppUrl()}${goHref("client", "payments")}`,
        }),
        sendRefundProcessedEmail(
          {
            userId: args.attendeeUserId,
            paymentId: payment.id,
            amountPaise,
            currency: payment.currency,
          },
          { budgetMs: EMAIL_BUDGET_MS.REQUEST },
        ),
      ]);
    }

    return {
      amountRefundedPaise: result.amountRefundedPaise,
      refundPct,
      rail: result.rail,
    };
  } catch (err) {
    // Benign idempotent re-drives — a seat already refunded, or a payment that
    // never captured. Paging ops for these turns every repeat click into an
    // incident. Mirrors the overage credit-back exemption above.
    // AMOUNT_EXCEEDS_REFUNDABLE is unreachable through the clamp above, but a
    // concurrent refund settling between the read and the write can still
    // produce it, and that race is the benign case too.
    if (isBenignSeatRefundError(err))
      return { amountRefundedPaise: 0, refundPct: 0, rail: null };

    reportSentryError(err, {
      subsystem: "payments",
      tags: { feature: "attendee-removal-refund" },
      extra: { ...args },
    });
    void recordSystemErrorSafe({
      organizationId,
      category: "PAYMENT",
      summary: `Seat refund failed for attendee removed from ${args.kind} ${args.eventId}`,
      err,
      context: { ...args },
    });
    return { amountRefundedPaise: 0, refundPct: 0, rail: null };
  }
}

type SeatRefundArgs = Parameters<typeof refundRemovedAttendeeSeat>[0];

/** Hours to the next live session from now, or -1 when none is upcoming. */
async function hoursUntilNextLive(
  eventFilter: Parameters<typeof findLiveEventSlot>[0],
): Promise<number> {
  const now = new Date();
  // Next upcoming session — not the earliest historical live row.
  // Past class sessions stay SCHEDULED/COMPLETED/UNVERIFIED and would
  // otherwise pin hoursUntilStart negative → permanent 0% refund.
  const nextLive = await findLiveEventSlot(eventFilter, {
    order: "asc",
    startsAtGte: now,
  });
  if (!nextLive) return -1;
  return (nextLive.startsAt.getTime() - now.getTime()) / (1000 * 60 * 60);
}

/** The idempotent re-drive refusals a seat refund swallows without paging. */
function isBenignSeatRefundError(err: unknown): boolean {
  return (
    err instanceof RefundValidationError &&
    (err.code === "ALREADY_FULLY_REFUNDED" ||
      err.code === "PAYMENT_NOT_SUCCEEDED" ||
      err.code === "AMOUNT_EXCEEDS_REFUNDABLE")
  );
}

/** The percentage a seat refund reports: the rule's answer, else the ladder. */
function seatRefundPct(
  args: SeatRefundArgs,
  grossPaise: number,
  ladder: () => number,
): number {
  if (args.amountPaise !== undefined) {
    return grossPaise > 0
      ? Math.round((args.amountPaise * 10_000) / grossPaise) / 100
      : 0;
  }
  return args.mode === "full" ? 100 : ladder();
}

/**
 * #1780 decision 11 — a credit-funded seat returns credits, not cash. The
 * credits rail restores whole or not at all (#1161), so a full answer (an
 * organiser removal, a leave outside the window, a host move) restores it
 * and a per-session answer is escalated to ops rather than over-restored.
 */
/** What the credits rail keys on: a restoration row, and credit still consumed. */
/** Whether each credit seat already has a restoration row, and how much credit it still holds. */
async function creditSeatStates(
  db: PrismaLike,
  paymentIds: string[],
): Promise<Map<string, { claimed: boolean; stillUsedPaise: number }>> {
  if (paymentIds.length === 0) return new Map();
  const [claims, usages] = await Promise.all([
    db.refund.findMany({
      where: {
        paymentId: { in: paymentIds },
        status: { in: ["SUCCEEDED", "PENDING"] },
      },
      select: { paymentId: true },
    }),
    db.referralCreditUsage.findMany({
      where: { paymentId: { in: paymentIds } },
      select: { paymentId: true, amount: true },
    }),
  ]);
  const claimed = new Set(claims.map((c) => c.paymentId));
  return new Map(
    paymentIds.map((id) => [
      id,
      {
        claimed: claimed.has(id),
        stillUsedPaise: usages
          .filter((u) => u.paymentId === id)
          .reduce((sum, u) => sum + Number(u.amount), 0),
      },
    ]),
  );
}

async function creditSeatState(paymentId: string) {
  const states = await creditSeatStates(prisma, [paymentId]);
  return states.get(paymentId) ?? { claimed: false, stillUsedPaise: 0 };
}

/** #1771 K-5 — a durable row the Refunds tab lists for the credit door. */
async function escalatePartialCredit(
  paymentId: string,
  context: Record<string, unknown>,
): Promise<void> {
  await recordSystemEvent({
    category: "BOOKING",
    severity: "WARN",
    message: `Credit seat ${paymentId} needs a partial credit return`,
    context: { paymentId, ...context },
    correlationId: `partial-credit:${paymentId}`,
  });
}

async function creditSeatRefund(
  args: SeatRefundArgs,
  paymentId: string,
  dedupeKey: string | undefined,
): Promise<{
  amountRefundedPaise: number;
  refundPct: number;
  rail: FundingRail | null;
}> {
  const whole =
    (args.initiatedBy ?? "organiser") === "organiser" || args.mode === "full";
  // After an ops partial return the rail would refuse as "already refunded"
  // and the rest would be lost silently; queue it for the credit door instead.
  const state = await creditSeatState(paymentId);
  if (whole && state.claimed) {
    if (state.stillUsedPaise > 0) {
      await escalatePartialCredit(paymentId, {
        eventId: args.eventId,
        kind: args.kind,
        partlyReturned: true,
      });
    }
    return { amountRefundedPaise: 0, refundPct: 0, rail: "CREDITS" };
  }
  if (!whole) {
    await recordSystemErrorSafe({
      organizationId: null,
      category: "PAYMENT",
      summary: `Credit seat left ${args.kind} ${args.eventId} mid-series — per-session credit restoration needs a human`,
      err: new Error("CREDIT_SEAT_PARTIAL_RESTORE"),
      context: { ...args, paymentId },
    });
    return { amountRefundedPaise: 0, refundPct: 0, rail: null };
  }
  const r = await refundBookingPayment({
    paymentId,
    reason: `left ${args.kind} ${args.eventId} — credits restored in full`,
    initiatedByUserId: args.initiatedByUserId,
    dedupeKey,
  });
  return {
    amountRefundedPaise: r.amountRefundedPaise,
    refundPct: 100,
    rail: r.rail,
  };
}

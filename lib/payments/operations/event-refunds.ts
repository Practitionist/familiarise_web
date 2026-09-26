import { reportSentryError } from "@/lib/observability/report";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import {
  recordSystemError,
  recordSystemEvent,
} from "@/lib/enterprise/system-events";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import { getAppUrl } from "@/lib/url";
import { notifyRefundProcessed } from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { EMAIL_BUDGET_MS, sendRefundProcessedEmail } from "@/lib/email";
import { applyReversal, readRefundableBalances } from "./reversal-engine";
import { refundPayment, RefundValidationError } from "./refund";
import {
  isFreeCreditIntent,
  isInternalFundedIntent,
  refundBookingPayment,
  type FundingRail,
} from "./booking-refund";
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
 * Whole-event refund (#776 §C) — the production front door for the reversal
 * engine's CLASS_MULTI path.
 *
 * A cancelled class/webinar must refund EVERY attendee. Those attendees paid
 * through two very different rails, and each needs its own reversal:
 *
 *   - GATEWAY / MOCK seats (paymentIntent pi_/cs_/order_/pay_/…_mock_) — real
 *     card money. They must credit the card, so they go through `refundPayment`
 *     (which owns the gateway phases + its own overage credit-back). Routing
 *     them through the engine would strand the customer's money — the engine
 *     never calls the gateway.
 *   - INTERNAL org-funded seats (paymentIntent org_wallet/org_license/
 *     org_invoice) — no card ever charged; the money lives in the wallet /
 *     invoice accrual / license ledger. `refundPayment` can't refund these
 *     (createRefund throws UNKNOWN_GATEWAY on a synthetic id), so they reverse
 *     purely in-ledger via one CLASS_MULTI transaction.
 *
 * Idempotency: callers still gate on the appointment-cancel CAS / moderation
 * `moved === 0` guard, but a second call is now structurally harmless too —
 * every rail re-derives the refundable balance under Serializable isolation,
 * so an already-refunded seat surfaces as a skip, not a second payout
 * (#1169 PR 3; the old "a second call would double-refund" note predated the
 * balance clamps).
 */

export type WholeEventRefundSummary = {
  refundsIssued: number;
  refundedPaise: number;
  childRefundIds: string[];
  failures: { paymentId: string; error: string }[];
  /** Seats whose balance was already fully refunded — a re-run, not an error. */
  skippedAlreadyRefunded: number;
  /**
   * #1583 C-P0-03 — the internal batch had no refundable balance left, so the
   * CLASS_MULTI reversal was skipped rather than thrown. A re-run, not an error.
   */
  alreadyRefunded: boolean;
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function refundWholeEventPayments(
  kind: "class" | "webinar",
  eventId: string,
  reason: string,
  initiatedByUserId: string | null,
  /**
   * #1780 D-5 — per-seat class ledgers read BEFORE the cancel tombstoned the
   * sessions (classSeriesLedgers); each seat then refunds only what was not
   * delivered. Absent (a webinar, a moderation sweep) → every seat in full.
   */
  opts: { ledgers?: ReadonlyMap<string, SeriesSeat> } = {},
): Promise<WholeEventRefundSummary> {
  const summary: WholeEventRefundSummary = {
    refundsIssued: 0,
    refundedPaise: 0,
    childRefundIds: [],
    failures: [],
    skippedAlreadyRefunded: 0,
    alreadyRefunded: false,
  };

  const payments = await prisma.payment.findMany({
    where: {
      appointment:
        kind === "webinar" ? { webinarId: eventId } : { classId: eventId },
      paymentStatus: "SUCCEEDED",
      // #1161 — no amount filter: free_ (credit-funded) seats refund too, via
      // credit restoration.
      // #781 §B — retired rows stay out: the front door refuses them, so a
      // soft-deleted seat would only surface as a false failure.
      deletedAt: null,
    },
    select: {
      id: true,
      amount: true,
      paymentIntent: true,
      userId: true,
      createdAt: true,
      appointmentId: true,
    },
  });
  if (payments.length === 0) return summary;

  // #1780 D-5 — a class series refunds only what was not delivered: each seat
  // gets amount − unit × delivered (its own ledger); a webinar refunds in full.
  const ledgers = opts.ledgers ?? null;
  const seriesAmount = (p: (typeof payments)[number]) => {
    const ledger = ledgers?.get(p.id);
    // Sessions already refunded one by one (occ:*) are not owed again.
    return ledger
      ? Number(seriesCancelRefundPaise(ledger, p.amount)) -
          (ledger.occRefundedPaise ?? 0)
      : undefined;
  };

  const internal = payments.filter((p) =>
    isInternalFundedIntent(p.paymentIntent),
  );
  const credits = payments.filter((p) => isFreeCreditIntent(p.paymentIntent));
  const gateway = payments.filter(
    (p) =>
      !isInternalFundedIntent(p.paymentIntent) &&
      !isFreeCreditIntent(p.paymentIntent),
  );

  // Credit-funded seats — restoration through the front door (#1161).
  for (const p of credits) {
    // #1780 — the credits rail restores whole or not at all, so a seat that was
    // delivered part of the series is escalated rather than over-restored.
    const ledger = ledgers?.get(p.id);
    // The credits rail refuses once any restoration row exists (an ops
    // partial return), so read the facts it reads, not a key prefix.
    const state = await creditSeatState(p.id);
    if (state.claimed && state.stillUsedPaise <= 0) {
      summary.skippedAlreadyRefunded += 1;
      continue;
    }
    if ((ledger && ledger.deliveredHeld > 0) || state.claimed) {
      summary.failures.push({
        paymentId: p.id,
        error:
          "partial credit restoration after delivered sessions needs a human",
      });
      await escalatePartialCredit(p.id, {
        eventId,
        kind,
        delivered: ledger?.deliveredHeld ?? 0,
        partlyReturned: state.claimed,
      });
      continue;
    }
    try {
      const r = await refundBookingPayment({
        paymentId: p.id,
        reason,
        initiatedByUserId,
      });
      summary.refundsIssued += 1;
      summary.childRefundIds.push(r.refundId);
    } catch (err) {
      if (
        err instanceof RefundValidationError &&
        err.code === "ALREADY_FULLY_REFUNDED"
      ) {
        summary.skippedAlreadyRefunded += 1;
        continue;
      }
      summary.failures.push({ paymentId: p.id, error: errMsg(err) });
      reportSentryError(err, {
        subsystem: "payments",
        tags: { feature: "whole-event-refund" },
        extra: { paymentId: p.id, eventId, kind },
      });
    }
  }

  // Gateway / mock seats — one gateway-aware refund each (refundPayment also
  // handles any CHARGE_MEMBER overage credit-back internally).
  for (const p of gateway) {
    try {
      const owed = seriesAmount(p);
      if (owed !== undefined && owed <= 0) {
        summary.skippedAlreadyRefunded += 1;
        continue;
      }
      const r = await refundPayment({
        paymentId: p.id,
        reason,
        initiatedByUserId,
        ...(owed === undefined
          ? {}
          : {
              amountPaise: Math.min(
                owed,
                await gatewayBalance(p.id, Number(p.amount)),
              ),
              dedupeKey: `series-cancel:${p.id}`,
            }),
      });
      summary.refundsIssued += 1;
      summary.refundedPaise += r.amountRefundedPaise;
      summary.childRefundIds.push(r.refundId);
    } catch (err) {
      if (
        err instanceof RefundValidationError &&
        err.code === "ALREADY_FULLY_REFUNDED"
      ) {
        // A re-run over an already-settled seat (e.g. maintenance freeze
        // followed by a manual cancel) — the clamp held; not a failure.
        summary.skippedAlreadyRefunded += 1;
        continue;
      }
      summary.failures.push({ paymentId: p.id, error: errMsg(err) });
      reportSentryError(err, {
        subsystem: "payments",
        tags: { feature: "whole-event-refund" },
        extra: { paymentId: p.id, eventId, kind },
      });
    }
  }

  // Internal org-funded seats — one CLASS_MULTI reversal (ledger-only). Full
  // reversal of what is LEFT: amountPaise == Σ child refundable balances, read
  // in the same tx as the reversal, so a partly-refunded seat no longer makes
  // the whole batch throw and a fully-refunded batch is a no-op (#1583 C-P0-03).
  const memberOverageFollowUps: string[] = [];
  if (internal.length > 0) {
    let internalTotal = 0;
    let settledSeats = 0;
    try {
      const result = await withSerializableRetry(() =>
        prisma.$transaction(
          async (tx) => {
            const balances = await readRefundableBalances(
              tx,
              internal.map((p) => p.id),
            );
            // #1780 D-5 — Σ per-seat undelivered amounts, each clamped to its balance.
            internalTotal = balances.reduce((s, b) => {
              const seat = internal.find((p) => p.id === b.id);
              const owed = seat ? seriesAmount(seat) : undefined;
              return (
                s +
                (owed === undefined
                  ? b.refundablePaise
                  : Math.max(0, Math.min(owed, b.refundablePaise)))
              );
            }, 0);
            // Seats with nothing left are skips, whether or not the rest of
            // the batch still has a balance.
            settledSeats = balances.filter(
              (p) => p.refundablePaise <= 0,
            ).length;
            if (internalTotal === 0) return null;
            return applyReversal(tx, {
              source: {
                kind: "CLASS_MULTI",
                paymentIds: internal.map((p) => p.id),
              },
              amountPaise: internalTotal,
              reason,
              // Correlation tag only — reverseClassMulti mints its own child
              // Refund rows and keys idempotency off those, not this string.
              refundId: `event:${kind}:${eventId}`,
              initiatedByUserId,
            });
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 10_000,
            timeout: 15_000,
          },
        ),
      );
      summary.skippedAlreadyRefunded += settledSeats;
      if (result !== null) {
        summary.refundsIssued += result.childRefundIds.length;
        summary.refundedPaise += internalTotal;
        summary.childRefundIds.push(...result.childRefundIds);
        for (const c of result.cascades) {
          if (c.memberOverageRefundDue) {
            memberOverageFollowUps.push(
              c.memberOverageRefundDue.overagePaymentId,
            );
          }
        }
      }
    } catch (err) {
      // The whole internal batch rolled back atomically — surface each seat.
      for (const p of internal) {
        summary.failures.push({ paymentId: p.id, error: errMsg(err) });
      }
      reportSentryError(err, {
        subsystem: "payments",
        tags: { feature: "whole-event-refund" },
        extra: { eventId, kind, internalCount: internal.length },
      });
    }
  }

  // #715/#716 — CHARGE_MEMBER overages on the internal seats were collected on
  // separate gateway side-payments the CLASS_MULTI tx can't touch. Credit them
  // back now (best-effort; ops-paged on non-benign failure).
  for (const overagePaymentId of memberOverageFollowUps) {
    try {
      const r = await refundPayment({
        paymentId: overagePaymentId,
        reason: `overage credit-back — ${kind} ${eventId} cancelled`,
        initiatedByUserId,
      });
      summary.childRefundIds.push(r.refundId);
    } catch (err) {
      const benign =
        err instanceof RefundValidationError &&
        (err.code === "ALREADY_FULLY_REFUNDED" ||
          err.code === "PAYMENT_NOT_SUCCEEDED");
      if (!benign) {
        summary.failures.push({
          paymentId: overagePaymentId,
          error: errMsg(err),
        });
        void recordSystemError({
          organizationId: null,
          category: "PAYMENT",
          summary: `Overage credit-back failed for side-payment ${overagePaymentId}`,
          err,
          context: { overagePaymentId, eventId, kind },
        }).catch(() => {});
      }
    }
  }

  // Derived after every rail: the event is "already refunded" only when each
  // seat was a skip, nothing was issued and nothing failed — an internal no-op
  // beside a failed gateway seat is a failure, not idempotent success.
  summary.alreadyRefunded =
    summary.refundsIssued === 0 &&
    summary.failures.length === 0 &&
    summary.skippedAlreadyRefunded === payments.length;

  return summary;
}

/** A gateway seat's refundable balance (gross less what already came back). */
async function gatewayBalance(paymentId: string, grossPaise: number) {
  const row = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: REFUNDABLE_BALANCE_SELECT,
  });
  return row ? refundableBalancePaise(grossPaise, row) : 0;
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
    select: { userId: true, createdAt: true },
  });
  const ledgers = new Map<string, SeriesSeat>();
  for (const p of payments) {
    if (!p.appointmentId) continue;
    const seatAt = seats.find((s) => s.userId === p.userId)?.createdAt;
    const joinedAt = seatAt && seatAt > p.createdAt ? seatAt : p.createdAt;
    ledgers.set(p.id, {
      ...(await seatLedger(
        prisma,
        { appointmentId: p.appointmentId, createdAt: joinedAt },
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
      // Deterministic: the seat they bought first is the one being released.
      orderBy: { createdAt: "asc" },
      where: {
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
      initiatedByUserId: args.initiatedByUserId,
      dedupeKey,
    });

    // Only the gateway rail puts money back where this person can see it. On
    // the internal rail the value returned to the org's wallet, accrual or
    // licence — the member never paid, so telling them a refund is coming is
    // simply false.
    if (result.rail === "GATEWAY") {
      await notifyRefundProcessed(args.attendeeUserId, {
        ...notificationScope(payment.organizationId),
        amount: amountPaise,
        currency: payment.currency,
        reason: isOrganiserInitiated
          ? `You were removed from this ${args.kind}.`
          : `You left this ${args.kind}.`,
        dashboardUrl: `${getAppUrl()}/dashboard`,
      }).catch(() => {});
      // #1653 — the email twin; the sender never throws, the catch is belt
      // and braces so a settled refund can never fail on its receipt.
      await sendRefundProcessedEmail(
        {
          userId: args.attendeeUserId,
          paymentId: payment.id,
          amountPaise,
          currency: payment.currency,
        },
        { budgetMs: EMAIL_BUDGET_MS.REQUEST },
      ).catch(() => {});
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
    void recordSystemError({
      organizationId,
      category: "PAYMENT",
      summary: `Seat refund failed for attendee removed from ${args.kind} ${args.eventId}`,
      err,
      context: { ...args },
    }).catch(() => {});
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
async function creditSeatState(paymentId: string) {
  const [claim, usages] = await Promise.all([
    prisma.refund.findFirst({
      where: { paymentId, status: { in: ["SUCCEEDED", "PENDING"] } },
      select: { id: true },
    }),
    prisma.referralCreditUsage.findMany({
      where: { paymentId },
      select: { amount: true },
    }),
  ]);
  return {
    claimed: !!claim,
    stillUsedPaise: usages.reduce((sum, u) => sum + Number(u.amount), 0),
  };
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
    await recordSystemError({
      organizationId: null,
      category: "PAYMENT",
      summary: `Credit seat left ${args.kind} ${args.eventId} mid-series — per-session credit restoration needs a human`,
      err: new Error("CREDIT_SEAT_PARTIAL_RESTORE"),
      context: { ...args, paymentId },
    }).catch(() => {});
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

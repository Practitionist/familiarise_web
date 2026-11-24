import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/auth-helpers";
import {
  bookingAppointmentFilter,
  readCancelWindowState,
  resolveBookingRefundContext,
} from "@/lib/booking/cancellation-scope";
import { resolveCancelActor } from "@/lib/booking/cancel-actor";
import { cancelWindowRefusal } from "@/lib/booking/session-window";
import { isRefusal, Refusal } from "@/lib/errors/refusal";
import { pendingVoidRefusal } from "@/lib/booking/pending-void-gate";
import {
  isSuspendedInFundingOrg,
  membershipSuspendedResponse,
} from "@/lib/enterprise/suspended-member-sessions";
import { quoteSeatLeave } from "@/lib/booking/seat-leave";
import {
  classSeriesLedgers,
  quoteWholeEventRefunds,
} from "@/lib/payments/operations/event-refunds";
import { fundingRailForIntent } from "@/lib/payments/funding-rail";
import { quoteBookingRefund } from "@/lib/payments/operations/cancellation-policy";
import { creditStillUsedPaise } from "@/lib/payments/operations/credit-plan-return";
import prisma from "@/lib/prisma";

// A money read: never cached (repo rule for edited money GETs).
const NO_STORE = { headers: { "Cache-Control": "no-store" } };

/** The plan fields `resolveCancelActor` reads. */
const CANCEL_ACTOR_PLAN_SELECT = {
  consultantProfileId: true,
  organizationId: true,
  consultantProfile: { select: { user: { select: { id: true } } } },
} as const;

/** Every Appointment field the quote reads. */
async function loadPreviewAppointment(appointmentId: string) {
  return prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      organizationId: true,
      organization: { select: { name: true } },
      consultationId: true,
      subscriptionId: true,
      webinarId: true,
      classId: true,
      consultation: {
        select: {
          requestedById: true,
          requestedBy: { select: { user: { select: { id: true } } } },
          consultationPlan: { select: CANCEL_ACTOR_PLAN_SELECT },
        },
      },
      subscription: {
        select: {
          requestedById: true,
          requestedBy: { select: { user: { select: { id: true } } } },
          subscriptionPlan: { select: CANCEL_ACTOR_PLAN_SELECT },
        },
      },
      webinar: {
        select: { webinarPlan: { select: CANCEL_ACTOR_PLAN_SELECT } },
      },
      class: { select: { classPlan: { select: CANCEL_ACTOR_PLAN_SELECT } } },
    },
  });
}

type PreviewAppointment = NonNullable<
  Awaited<ReturnType<typeof loadPreviewAppointment>>
>;

/**
 * What cancelling a class or webinar actually pays back.
 *
 * The POST route does not tier a group event at all: it hands the whole event
 * to `refundWholeEventPayments`, whoever pressed cancel. The quote reads that
 * door's own seat plan, so it can never be a second opinion: each live paid
 * seat is owed what it was not delivered, clamped to its refundable balance,
 * and a seat already released is owed nothing.
 */
async function quoteWholeEventRefund(
  kind: "class" | "webinar",
  eventId: string,
) {
  // #1780 D-5 — a class series pays back only what each seat was not delivered.
  const ledgers = kind === "class" ? await classSeriesLedgers(eventId) : null;
  const quote = await quoteWholeEventRefunds(kind, eventId, ledgers);
  return {
    estimatedRefundPaise: quote.owedPaise,
    /** Paid seats — the attendees who are owed something, not the roster. */
    attendeeCount: quote.seats,
    currency: quote.currency,
  };
}

/**
 * What cancelling a 1:1 booking pays back: a tiered share of the one payment
 * that funds it.
 *
 * Every input is the POST route's own — the same context builder, the same tier
 * function, the same linear proration and the same clamp to the refundable
 * balance — because a quote that restates the rule is a rule that can drift
 * from the charge.
 */
async function quoteIndividualBooking(
  appointment: PreviewAppointment,
  isConsultantInitiated: boolean,
) {
  const bookingRef = {
    appointmentId: appointment.id,
    consultationId: appointment.consultationId,
    subscriptionId: appointment.subscriptionId,
    classId: appointment.classId,
    webinarId: appointment.webinarId,
  };
  const ctx = await resolveBookingRefundContext(bookingRef);
  const windowRefusal = cancelWindowRefusal(
    ctx.windowState,
    { appointmentId: appointment.id },
    isConsultantInitiated ? "host" : "buyer",
  );
  if (windowRefusal) throw windowRefusal;

  // The context deliberately ignores zero-amount payments, so a booking paid
  // entirely in referral credits reads as unpaid there. Its `free_` intent is
  // the only signal that value was exchanged at all (#1161).
  const bookingPayment = await prisma.payment.findFirst({
    where: {
      appointment: bookingAppointmentFilter(bookingRef),
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, currency: true, paymentIntent: true },
  });

  // #1319 — the notice tier, the proration and the clamp are the POST route's
  // own code now, not a restatement of it. An unpaid booking quotes off zeros,
  // which the clamp turns into zero.
  const quote = quoteBookingRefund({
    policy: ctx.policy,
    hoursUntilNextSession: ctx.hoursUntilNextSession,
    slotsTotal: ctx.slotsTotal,
    sessionsRemaining: ctx.sessionsRemaining,
    sessionsTotal: ctx.sessionsTotal,
    sessionsRefunded: ctx.sessionsRefunded,
    sessionsCompleted: ctx.sessionsCompleted,
    scheduledStarts: ctx.scheduledStarts,
    nowMs: ctx.quotedAtMs,
    alreadyRefundedPaise: ctx.alreadyRefundedPaise,
    isSubscription: !!appointment.subscriptionId,
    isConsultantInitiated,
    // #1500 — a booking funded entirely by referral credit. The rail alone is not
    // enough: `free_` with a non-zero amount is a mixed payment and settles on the
    // money arm, so both halves of the predicate are load-bearing.
    isFreeCreditFunded:
      fundingRailForIntent(bookingPayment?.paymentIntent) === "CREDITS" &&
      (ctx.paidPayment?.amountPaise ?? 0) === 0,
    grossPaise: ctx.paidPayment?.amountPaise ?? 0,
    refundablePaise: ctx.paidPayment?.refundablePaise ?? 0,
  });

  const fundingRail = fundingRailForIntent(bookingPayment?.paymentIntent);
  // A `free_` intent covers a ₹0 booking and a credit-funded one; only the
  // referral credit still held tells them apart.
  const creditUsedPaise =
    fundingRail === "CREDITS" && bookingPayment
      ? await creditStillUsedPaise(prisma, bookingPayment.id)
      : 0;
  return {
    refundPct: quote.refundPct,
    estimatedRefundPaise: quote.refundPaise,
    // #1500 — the dialog must say "your credit comes back in full" rather than show
    // a ₹0 refund next to a 100% tier, which is what a credit-funded quote looks
    // like when only the money fields are read.
    creditRestoresInFull: quote.creditRestoresInFull,
    // A credit-funded plan with sessions held: the rest is returned by hand,
    // unless no referral credit is still consumed (a 100% discount).
    creditReturnNeedsReview:
      quote.creditReturnNeedsReview && creditUsedPaise > 0,
    freeBooking:
      fundingRail === "CREDITS" &&
      (ctx.paidPayment?.amountPaise ?? 0) === 0 &&
      creditUsedPaise === 0,
    currency: bookingPayment?.currency ?? "INR",
    hoursUntilNextSession: ctx.hoursUntilNextSession,
    // Only true when proration actually moves the number — an untouched
    // subscription refunds off the whole price, like every other booking.
    // Keyed on the same two numbers the base is: any session that is no
    // longer live has already shrunk the quote, whether or not it COMPLETED.
    prorated: quote.prorated,
    // Which rail the money comes back on, which is the sentence the dialog
    // actually needs. `free_` alone was not enough: a wallet-, invoice- or
    // licence-funded learner was told their card would be credited in 5–7
    // working days for a card that was never charged, and the org whose
    // balance was actually restored was not mentioned at all.
    fundingRail,
    // The payer sentence names the org only on its own rail.
    payerOrganizationName:
      fundingRail === "INTERNAL"
        ? (appointment.organization?.name ?? null)
        : null,
    wholeEvent: false,
    attendeeCount: null,
    // The click echoes this back, so a capture landing after an unpaid quote
    // re-quotes instead of cancelling a paid booking at the policy tier.
    expectedPaid: ctx.paidPayment !== null,
  };
}

// The group event a booking belongs to, webinar first; null for a 1:1 booking.
function groupEventOf(
  appointment: Pick<PreviewAppointment, "webinarId" | "classId">,
): { kind: "class" | "webinar"; id: string } | null {
  if (appointment.webinarId) {
    return { kind: "webinar", id: appointment.webinarId };
  }
  if (appointment.classId) {
    return { kind: "class", id: appointment.classId };
  }
  return null;
}

async function wholeEventPreview(kind: "class" | "webinar", eventId: string) {
  const quote = await quoteWholeEventRefund(kind, eventId);
  return {
    refundPct: 100,
    estimatedRefundPaise: quote.estimatedRefundPaise,
    currency: quote.currency,
    // The whole-event rail never consults the clock, so no notice window is
    // computed for it.
    hoursUntilNextSession: null,
    prorated: false,
    // Seats fund through several rails at once (card, org wallet, credits),
    // so no single funding sentence is true of the aggregate. Null rather
    // than a rail: the whole-event copy stands on its own and naming one
    // rail here would be a claim about seats it does not cover.
    fundingRail: null,
    wholeEvent: true,
    attendeeCount: quote.attendeeCount,
  };
}

/**
 * What cancelling this booking right now would pay back — computed, never
 * written.
 *
 * The confirmation dialog said "any refund follows the booking's cancellation
 * policy", which is true and useless: the number is knowable before the click,
 * and someone deciding whether to cancel is deciding about that number.
 *
 * Every input is the sibling POST route's own: the same context builder, the
 * same tier function, the same linear proration and the same clamp to the
 * refundable balance. Restating any of that here would let the quote and the
 * charge drift.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    // #1583 D-P0-02 — fresh, ban-aware read; 401 / 403 / 503 shapes are the helper's.
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const { appointmentId } = await params;

    const appointment = await loadPreviewAppointment(appointmentId);

    if (!appointment) {
      return NextResponse.json(
        { error: "Appointment not found", code: "NOT_FOUND" },
        { status: 404 },
      );
    }

    // #1780 D-4 — `?scope=seat`: what the viewer leaving their OWN seat pays
    // back. It reads only the caller's seat, so it precedes the whole-event
    // cancel authorization, which an attendee never passes.
    const seatEvent = groupEventOf(appointment);
    if (
      seatEvent &&
      new URL(request.url).searchParams.get("scope") === "seat"
    ) {
      return NextResponse.json(
        await quoteSeatLeave(seatEvent.kind, seatEvent.id, session.user.id),
        NO_STORE,
      );
    }

    // One actor derivation with the POST, so the preview neither refuses a
    // viewer the cancel admits nor quotes a tier the cancel would not charge.
    const actor = await resolveCancelActor(appointment, session.user);
    if (!actor.authorized) {
      return NextResponse.json(
        {
          error: "You are not authorized to cancel this appointment",
          code: "FORBIDDEN",
        },
        { status: 403 },
      );
    }

    // #1527 decision 6 — same refusal as the POST: no quote for a cancel a
    // suspended learner can't make.
    if (
      actor.isLearner &&
      !actor.isPrivilegedUser &&
      (await isSuspendedInFundingOrg(
        session.user.id,
        appointment.organizationId,
      ))
    ) {
      return membershipSuspendedResponse();
    }

    // Group events never reach the notice tiers or the viewer's own payment:
    // the POST route refunds the entire roster in full. Quote that instead.
    const groupEvent = groupEventOf(appointment);
    if (groupEvent) {
      const windowRefusal = cancelWindowRefusal(
        await readCancelWindowState(prisma, appointment.id),
        { appointmentId: appointment.id },
        actor.isConsultantInitiated ? "host" : "buyer",
      );
      if (windowRefusal) throw windowRefusal;
      // The cancel itself refuses while a class void's verdict is pending, with the same sentence.
      if (groupEvent.kind === "class") {
        const pending = await pendingVoidRefusal(prisma, {
          appointmentId: appointment.id,
          readerUserId: session.user.id,
          action: "cancel",
        });
        if (pending) {
          throw new Refusal({
            code: "CANCEL_WAITS_FOR_VERDICT",
            userMessage: pending,
          });
        }
      }
      return NextResponse.json(
        await wholeEventPreview(groupEvent.kind, groupEvent.id),
        NO_STORE,
      );
    }

    return NextResponse.json(
      await quoteIndividualBooking(appointment, actor.isConsultantInitiated),
      NO_STORE,
    );
  } catch (error) {
    if (isRefusal(error)) {
      return NextResponse.json(
        { error: error.userMessage, code: error.code },
        { status: error.httpStatus, ...NO_STORE },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      { error: "Could not estimate the refund" },
      { status: 500 },
    );
  }
}

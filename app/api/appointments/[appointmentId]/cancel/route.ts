import { PROFILE_WITH_USER_SELECT } from "@/lib/booking/list-selects";
import {
  flushBackupInterestNotices,
  stageNoticesForAppointmentHolds,
} from "@/lib/booking/backup-interest";
import * as Sentry from "@sentry/nextjs";
import { applyRateLimit, eventMutationLimiter } from "@/lib/rate-limit";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
  withAppointmentLock,
  withEventCheckoutLock,
} from "@/utils/appointmentlock";
import {
  cancelGatewayOrders,
  expirePendingPaymentsInTx,
} from "@/lib/booking/pending-payment-expiry";
import {
  liveParticipant,
  transitionParticipant,
} from "@/lib/booking/participants";
import prisma, { type Tx } from "@/lib/prisma";
import { collaboratorUserIds } from "@/lib/collaborators/recipients";
import { NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import { type AppointmentStatus, CancellationReason } from "@prisma/client";
import { notifyAppointmentCancelled } from "@/lib/novu";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { refundOnItsWay } from "@/lib/email";
import { stageAppointmentCancelledEmail } from "@/lib/email/senders/booking";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { planTitleOrSessionLabel } from "@/lib/novu/humanize";
import { CancelAppointmentSchema } from "@/schemas/appointments";

import { isPrivileged, requireApiAuth } from "@/lib/auth-helpers";
import { platformCancelGrant } from "@/lib/booking/platform-cancel";
import {
  recordSystemErrorSafe,
  recordSystemEvent,
} from "@/lib/enterprise/system-events";
import {
  driveRefundOwed,
  heldMarkerRefusal,
  opsHeldMarkerMessage,
  recordRefundNeedsSupport,
  stampRefundOwed,
  type RefundOwedMarker,
} from "@/lib/payments/operations/refund-owed";
import { creditStillUsedPaise } from "@/lib/payments/operations/credit-plan-return";
import {
  isFreeCreditIntent,
  isInternalFundedIntent,
  type FundingRail,
} from "@/lib/payments/funding-rail";
import {
  isModelledRefundRefusal,
  RefundGatewayError,
} from "@/lib/payments/operations/refund";
import { reportSentryError } from "@/lib/observability/report";
import { recordActForOrg } from "@/lib/booking/org-actor";
import { resolveCancelActor } from "@/lib/booking/cancel-actor";
import {
  isSuspendedInFundingOrg,
  membershipSuspendedResponse,
} from "@/lib/enterprise/suspended-member-sessions";
import {
  LIVE_SLOT_WHERE,
  LIVE_SUCCEEDED_PAYMENT_WHERE,
  readCancelWindowState,
  resolveBookingRefundContext,
} from "@/lib/booking/cancellation-scope";
import { cancelWindowRefusal } from "@/lib/booking/session-window";
import { isRefusal } from "@/lib/errors/refusal";
import { stampTranchesOnCancel } from "@/lib/booking/subscription-cycle";
import {
  classSeriesLedgers,
  refundWholeEventPayments,
  stampWholeEventRefundsOwed,
  type WholeEventRefundSummary,
} from "@/lib/payments/operations/event-refunds";
import { hasActiveDisputeForAppointment } from "@/lib/payments/dispute-guard";
import {
  quoteBookingRefund,
  type BookingRefundQuote,
} from "@/lib/payments/operations/cancellation-policy";
import {
  CANCELLABLE_FROM,
  CLASS_EVENT_ALLOWED_FROM,
  EVENT_ALLOWED_FROM,
  SLOT_RESCHEDULABLE_FROM,
  transitionClassEvent,
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
  transitionSubscriptionRequest,
  transitionWebinarEvent,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { declineOpenReschedules } from "@/lib/booking/reschedule-decline";
import { recordExpertStrike } from "@/lib/booking/expert-reliability";
import {
  revokeEndedBookingChatAccess,
  revokeEndedEventChatAccess,
} from "@/lib/stream/access-revocation";
import { bookingOrgId } from "@/lib/stream-utils";

/** Audit attribution shared by every CAS this cancel drives (#1322 A12). */
type CancelAuditMeta = {
  actorUserId: string;
  reason: string | null;
  organizationId: string | null;
};

/**
 * A refund that did not land after the cancel committed. A modelled refusal
 * (no payment on the order, nothing refundable) is reported `expected` at
 * `warning` — it still needs a human via `recordSystemError`, but it is not a
 * fault (FAMILIARISE_WEB-3K). Anything else stays an error.
 */
function reportRefundFailure(err: unknown, subsystem: string): void {
  const modelled = isModelledRefundRefusal(err);
  reportSentryError(err, {
    subsystem,
    op: "cancel.refund",
    expected: modelled,
    ...(modelled ? { level: "warning" as const } : {}),
    // The gateway's own answer, so "no capture on this order" (a mock or seed
    // intent, FAMILIARISE_WEB-3K) is told apart from a transport fault.
    ...(err instanceof RefundGatewayError && err.gatewayCode
      ? { tags: { gatewayCode: err.gatewayCode } }
      : {}),
  });
}

/**
 * Which rows this cancel sweeps. #1554 — a booking is ONE Appointment, so a
 * whole-subscription or whole-class cancel ends every occurrence of that one
 * wrapper. The slot sweep and the participant sweep must never disagree about
 * the scope, so both read it from here (#1383).
 */
function cancelSweepScope(appointment: { id: string }) {
  return { appointmentId: appointment.id };
}

/**
 * #1775 P-3 (#1639 item 2) — a gateway throw leaves the reserved Refund row
 * PENDING for the reconcile cron, so the money is in flight, not failed.
 */
async function refundLeftPending(err: unknown): Promise<boolean> {
  if (!(err instanceof RefundGatewayError)) return false;
  const row = await prisma.refund
    .findUnique({ where: { id: err.refundRowId }, select: { status: true } })
    .catch(() => null);
  return row?.status === "PENDING";
}

type CancelBody = z.infer<typeof CancelAppointmentSchema>;

const NOT_CANCELLABLE = "NOT_CANCELLABLE";

/** The key a cancel refunds under: one per booking and payment. */
const cancelRefundKey = (appointmentId: string, paymentId: string) =>
  `cancel:${appointmentId}:${paymentId}`;

/** What the cancel route reports about the money; the client branches on `status`. */
type CancelRefund = {
  amountRefundedPaise: number;
  refundPct: number;
  status:
    "REFUNDED" | "PENDING" | "FAILED" | "NOTHING_REFUNDABLE" | "POLICY_ZERO";
  /** Set when the refund needs a human, not a formula. */
  requiresManualReview?: boolean;
  /** Which rail returned the money; the client words each rail differently. */
  rail?: FundingRail;
};

/** The click carried a quote the server no longer agrees with; nothing was committed. */
class RefundQuoteChangedError extends Error {
  readonly httpStatus = 409 as const;
  readonly code = "REFUND_QUOTE_CHANGED" as const;
  constructor(
    readonly quote: BookingRefundQuote,
    paymentLanded = false,
  ) {
    super(
      paymentLanded
        ? "Your payment just went through. Review the refund before you cancel."
        : "The refund for this booking has changed since you saw it. Check the new amount and confirm again.",
    );
    this.name = "RefundQuoteChangedError";
  }
}

/**
 * A capture committed under the cancel's read. The first run reruns and
 * re-quotes; a second one answers this 409 rather than a 500.
 */
class CaptureLandedError extends Error {
  readonly httpStatus = 409 as const;
  readonly code = "BOOKING_CHANGED" as const;
  constructor() {
    super(
      "This booking changed while you were cancelling it. Refresh to see where it stands, then try again.",
    );
    this.name = "CaptureLandedError";
  }
}

/**
 * A support refund took sessions off the plan after this cancel read it; the
 * first run re-quotes once, so the cancel never pays those sessions again.
 */
class PlanRefundLandedError extends Error {
  readonly httpStatus = 409 as const;
  readonly code = "BOOKING_CHANGED" as const;
  constructor() {
    super(
      "A refund changed this plan while you were cancelling it. Check the new amount and confirm again.",
    );
    this.name = "PlanRefundLandedError";
  }
}

/**
 * The refund charged is the refund the dialog showed. A click made on an
 * unpaid screen (or under a capture that landed mid-cancel) never cancels a
 * paid booking; an absent figure is an N-1 client and stays unbound.
 */
function assertQuoteMatchesClick(
  quote: BookingRefundQuote,
  body: CancelBody,
  clickSawUnpaid: boolean,
) {
  if (clickSawUnpaid) throw new RefundQuoteChangedError(quote, true);
  if (body.expectedRefundPaise === undefined) {
    console.info("[cancel] no expectedRefundPaise on the click; quote unbound");
    return;
  }
  const creditMismatch =
    body.expectedCreditRestoresInFull !== undefined &&
    body.expectedCreditRestoresInFull !== quote.creditRestoresInFull;
  if (body.expectedRefundPaise !== quote.refundPaise || creditMismatch) {
    throw new RefundQuoteChangedError(quote);
  }
}

/** The 1:1 request's status as this transaction reads it now; null for events. */
async function readRequestStatus(
  tx: Tx,
  appointment: {
    consultation: { id: string } | null;
    subscription: { id: string } | null;
  },
): Promise<AppointmentStatus | null> {
  if (appointment.consultation) {
    const row = await tx.consultation.findUnique({
      where: { id: appointment.consultation.id },
      select: { status: true },
    });
    return row?.status ?? null;
  }
  if (appointment.subscription) {
    const row = await tx.subscription.findUnique({
      where: { id: appointment.subscription.id },
      select: { status: true },
    });
    return row?.status ?? null;
  }
  return null;
}

function isNotCancellable(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === NOT_CANCELLABLE;
}

/**
 * The committed result of a cancel this caller already made, or null when the
 * booking was ended by someone else. The refund status is read from what the
 * first click persisted (the keyed Refund row or the owed marker), never requoted.
 */
async function replayCommittedCancel(
  appointment: {
    id: string;
    consultation: { id: string } | null;
    subscription: { id: string } | null;
  },
  userId: string,
) {
  const select = {
    status: true,
    cancelledBy: true,
    cancelledAt: true,
    cancellationReason: true,
  } as const;
  let request: {
    status: string;
    cancelledBy: string | null;
    cancelledAt: Date | null;
    cancellationReason: CancellationReason | null;
  } | null = null;
  if (appointment.consultation) {
    request = await prisma.consultation.findUnique({
      where: { id: appointment.consultation.id },
      select,
    });
  } else if (appointment.subscription) {
    request = await prisma.subscription.findUnique({
      where: { id: appointment.subscription.id },
      select,
    });
  }
  if (request?.status !== "CANCELLED" || request.cancelledBy !== userId) {
    return null;
  }
  const payments = await prisma.payment.findMany({
    where: { appointmentId: appointment.id, ...LIVE_SUCCEEDED_PAYMENT_WHERE },
    select: {
      id: true,
      refundOwedKey: true,
      refunds: {
        select: { dedupeKey: true, status: true, amountPaise: true },
      },
    },
  });
  let refund: Pick<CancelRefund, "amountRefundedPaise" | "status"> | null =
    null;
  for (const p of payments) {
    const key = cancelRefundKey(appointment.id, p.id);
    const row = p.refunds.find((r) => r.dedupeKey === key);
    if (row?.status === "SUCCEEDED") {
      refund = { amountRefundedPaise: row.amountPaise, status: "REFUNDED" };
    } else if (row?.status === "PENDING" || p.refundOwedKey === key) {
      refund = { amountRefundedPaise: 0, status: "PENDING" };
    }
  }
  return {
    success: true,
    replayed: true,
    cancellationReason: request.cancellationReason,
    cancelledAt: request.cancelledAt,
    refund:
      refund ??
      (payments.length > 0
        ? { amountRefundedPaise: 0, status: "POLICY_ZERO" }
        : null),
    eventRefund: null,
  };
}

/** A failed replay read answers the original 409, which the client handles. */
async function safeReplayCommittedCancel(
  ...args: Parameters<typeof replayCommittedCancel>
) {
  try {
    return await replayCommittedCancel(...args);
  } catch (readErr) {
    console.warn("[cancel] replay read failed:", readErr);
    return null;
  }
}

/** The refund a 1:1 cancel owes under its quote, or null when it pays nothing. */
function cancelRefundOwed(
  appointmentId: string,
  paymentId: string,
  quote: BookingRefundQuote,
  isConsultantInitiated: boolean,
): RefundOwedMarker | null {
  if (quote.creditRestoresInFull) {
    return {
      paymentId,
      amountPaise: null,
      key: cancelRefundKey(appointmentId, paymentId),
      reason: `cancellation (credit-funded booking, credit restored in full from the ${quote.tierRefundPct}% tier)`,
    };
  }
  if (quote.refundPaise <= 0) return null;
  const side = isConsultantInitiated ? "consultant" : "consultee";
  return {
    paymentId,
    amountPaise: quote.refundPaise,
    key: cancelRefundKey(appointmentId, paymentId),
    reason: `cancellation (${quote.refundPct}% per booking-time policy, ${side}-initiated)`,
  };
}

/**
 * Drives the stamped marker and words the outcome for the client. A failure is
 * reported once here and left on the marker for the retry sweep.
 */
async function settleCancelRefund(
  owed: RefundOwedMarker,
  quote: BookingRefundQuote,
  ctx: {
    appointmentId: string;
    organizationId: string | null;
    initiatedByUserId: string;
    refundablePaise: number;
    grossPaise: number;
  },
): Promise<CancelRefund> {
  const credit = quote.creditRestoresInFull;
  const refundPct = credit ? 100 : quote.refundPct;
  const outcome = await driveRefundOwed(owed, {
    initiatedByUserId: ctx.initiatedByUserId,
  });
  switch (outcome.kind) {
    case "refunded":
    case "replayed":
      return {
        amountRefundedPaise: outcome.refund.amountRefundedPaise,
        refundPct,
        status: outcome.refund.status === "PENDING" ? "PENDING" : "REFUNDED",
        ...(credit ? { requiresManualReview: false } : {}),
        ...(outcome.refund.rail ? { rail: outcome.refund.rail } : {}),
      };
    case "settled":
      return {
        amountRefundedPaise: 0,
        refundPct,
        status: "NOTHING_REFUNDABLE",
      };
    case "blocked":
      return { amountRefundedPaise: 0, refundPct, status: "PENDING" };
    case "failed":
      return failedCancelRefund(outcome, owed, quote, refundPct, ctx);
  }
}

/** Reports a failed drive once; the marker stays for the retry sweep. */
async function failedCancelRefund(
  { error: err, stuck }: { error: unknown; stuck: boolean },
  owed: RefundOwedMarker,
  quote: BookingRefundQuote,
  refundPct: number,
  ctx: Parameters<typeof settleCancelRefund>[2],
): Promise<CancelRefund> {
  const credit = quote.creditRestoresInFull;
  reportRefundFailure(err, credit ? "bookings" : "appointments");
  // Sentry is an alert channel rather than a queue anyone works; money owed
  // on a cancelled booking also lands on the durable ops surface.
  await recordSystemErrorSafe({
    organizationId: ctx.organizationId,
    category: "PAYMENT",
    summary: credit
      ? "Credit-funded booking cancelled but the credit restoration failed"
      : `Cancellation refund failed for payment ${owed.paymentId}; ` +
        `${refundPct}% of ${ctx.grossPaise} paise is still owed`,
    err,
    context: {
      appointmentId: ctx.appointmentId,
      paymentId: owed.paymentId,
      refundPct,
      tierRefundPct: quote.tierRefundPct,
      attemptedPaise: owed.amountPaise,
      refundablePaise: ctx.refundablePaise,
    },
  });
  // The marker stays owed for the retry sweep until its attempts are spent.
  if (!stuck || (await refundLeftPending(err))) {
    return { amountRefundedPaise: 0, refundPct, status: "PENDING" };
  }
  return {
    amountRefundedPaise: 0,
    refundPct,
    status: "FAILED",
    ...(credit ? { requiresManualReview: true } : {}),
  };
}

type AttendeesByRail = {
  all: string[];
  gateway: string[];
  credits: string[];
  internal: string[];
  free: string[];
  /** Payment id → payer, so a failed seat refund can be told apart. */
  payerOf: Map<string, string>;
};

/**
 * #1780 R-3 — every attendee of a group event, sorted by how their seat was
 * funded: a paid seat by its payment's rail, a seat with no payment as free.
 * Read off the seats as well as the payments, so a free seat is not skipped.
 */
/** A seat still held under a SUCCEEDED payment, read on the cancel's own transaction. */
async function hasPaidLiveSeat(
  tx: Tx,
  appointmentId: string,
): Promise<boolean> {
  const seats = await tx.appointmentParticipant.findMany({
    where: { appointmentId, role: "CONSULTEE", ...liveParticipant() },
    select: { userId: true },
  });
  if (seats.length === 0) return false;
  const paid = await tx.payment.count({
    where: {
      appointmentId,
      ...LIVE_SUCCEEDED_PAYMENT_WHERE,
      userId: { in: seats.map((seat) => seat.userId) },
    },
  });
  return paid > 0;
}

async function eventAttendeesByRail(
  appointmentId: string,
): Promise<AttendeesByRail> {
  const [payments, seats] = await Promise.all([
    prisma.payment.findMany({
      where: { appointmentId, ...LIVE_SUCCEEDED_PAYMENT_WHERE },
      select: { id: true, userId: true, paymentIntent: true },
    }),
    prisma.appointmentParticipant.findMany({
      where: { appointmentId, role: "CONSULTEE", ...liveParticipant() },
      select: { userId: true },
    }),
  ]);
  const seated = new Set(seats.map((s) => s.userId));
  const out: AttendeesByRail = {
    all: [],
    gateway: [],
    credits: [],
    internal: [],
    free: [],
    payerOf: new Map(),
  };
  const paid = new Set<string>();
  for (const p of payments) {
    // A seat given back earlier was already told (and refunded) when it left.
    if (!seated.has(p.userId)) continue;
    paid.add(p.userId);
    out.payerOf.set(p.id, p.userId);
    if (isFreeCreditIntent(p.paymentIntent)) out.credits.push(p.userId);
    else if (isInternalFundedIntent(p.paymentIntent))
      out.internal.push(p.userId);
    else out.gateway.push(p.userId);
  }
  for (const seat of seats) {
    if (!paid.has(seat.userId)) out.free.push(seat.userId);
  }
  out.all = Array.from(new Set([...paid, ...out.free]));
  return out;
}

/**
 * One email per rail; a class series refunds only the sessions not yet held.
 * A payer whose seat refund failed gets a neutral line, never a money claim.
 */
function attendeeEmailGroups(
  a: AttendeesByRail,
  isClass: boolean,
  failedPaymentIds: readonly string[],
) {
  const failed = new Set(
    failedPaymentIds.flatMap((id) => a.payerOf.get(id) ?? []),
  );
  const ok = (ids: string[]) => uniq(ids).filter((id) => !failed.has(id));
  const cash = isClass
    ? "The sessions not yet held are being refunded to you."
    : "Your payment for this event is being refunded in full.";
  return [
    { userIds: ok(a.gateway), refundText: cash },
    {
      userIds: ok(a.credits),
      refundText: "Your credits have been restored.",
    },
    {
      userIds: ok(a.internal),
      refundText:
        "The amount has been returned to the sponsoring organisation's balance.",
    },
    {
      userIds: Array.from(failed),
      refundText: "Your refund is being processed.",
    },
    { userIds: uniq(a.free), refundText: undefined },
  ].filter((g) => g.userIds.length > 0);
}

const uniq = (ids: string[]) => Array.from(new Set(ids));

// The name the cancellation email gives the canceller; a platform/org actor reads "Familiarise".
function cancellerName(
  meta: {
    cancelledBy: string;
    consultantUserId?: string;
    consultantName?: string;
    consulteeName?: string;
  },
  consulteeUserId: string | undefined,
): string {
  if (meta.cancelledBy === meta.consultantUserId) {
    return meta.consultantName || "The consultant";
  }
  if (meta.cancelledBy === consulteeUserId) {
    return meta.consulteeName || "The consultee";
  }
  return "Familiarise";
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  // An operator (ADMIN or STAFF, the class-wide cancel door included) reads refusals with ids and next steps.
  let opsViewer = false;
  try {
    // #1583 D-P0-02 — fresh, ban-aware read; 401 / 403 / 503 shapes are the helper's.
    const authResult = await requireApiAuth({ expectUser: true });
    if (authResult.error) return authResult.error;
    const { session } = authResult;
    opsViewer = isPrivileged(session.user.role);
    // #1319 — this route triggers refunds/reallocation and had no limiter.
    const limited = await applyRateLimit(eventMutationLimiter, session.user.id);
    if (limited) return limited;

    const { appointmentId } = await params;

    // Parse optional request body for cancellation reason
    let validatedData: CancelBody = {};
    try {
      const text = await request.text();
      if (text) {
        const parsed = JSON.parse(text);
        const result = CancelAppointmentSchema.safeParse(parsed);
        if (!result.success) {
          return NextResponse.json(
            { error: "Validation failed", details: result.error.issues },
            { status: 400 },
          );
        }
        validatedData = result.data;
      }
    } catch {
      // Body parsing is optional - continue without it
    }

    // Fetch appointment BEFORE transaction to avoid timeout on heavy queries
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        consultation: {
          include: {
            consultationPlan: {
              include: {
                consultantProfile: PROFILE_WITH_USER_SELECT,
              },
            },
            requestedBy: {
              include: { user: { select: { id: true, name: true } } },
            },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: PROFILE_WITH_USER_SELECT,
              },
            },
            requestedBy: {
              include: { user: { select: { id: true, name: true } } },
            },
          },
        },
        webinar: {
          include: {
            webinarPlan: {
              include: {
                consultantProfile: PROFILE_WITH_USER_SELECT,
              },
            },
          },
        },
        class: {
          include: {
            classPlan: {
              include: {
                consultantProfile: PROFILE_WITH_USER_SELECT,
              },
            },
          },
        },
        // Notification copy only. The refund tier reads the whole booking's
        // next undelivered session instead (#1006, cancellation-scope.ts) —
        // this row's earliest slot is the wrong answer for a subscription.
        occurrences: {
          where: LIVE_SLOT_WHERE,
          take: 1,
          orderBy: { startsAt: "asc" },
          select: { startsAt: true },
        },
      },
    });

    if (!appointment) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    const actor = await resolveCancelActor(appointment, session.user);
    const { isParticipant, isPrivilegedUser, isHostOrgOperator, orgActor } =
      actor;

    // A platform operator who is not a party cancels only through the audited,
    // money-bounded door, which grants this request.
    if (isPrivilegedUser && !isParticipant && !platformCancelGrant(request)) {
      return NextResponse.json(
        {
          error:
            "Cancel this booking from the back office so the refund is audited.",
          code: "PLATFORM_CANCEL_DOOR_REQUIRED",
        },
        { status: 403 },
      );
    }

    if (!actor.authorized) {
      return NextResponse.json(
        { error: "You are not authorized to cancel this appointment" },
        { status: 403 },
      );
    }

    // #1527 decision 6 — a suspended learner keeps join, not cancel, on an
    // org-funded booking; refused before any refund logic.
    if (
      actor.isLearner &&
      !isPrivilegedUser &&
      (await isSuspendedInFundingOrg(
        session.user.id,
        appointment.organizationId,
      ))
    ) {
      return membershipSuspendedResponse();
    }

    // Extract notification data BEFORE transaction (appointment will be deleted)
    let consultantUserId: string | undefined;
    let consulteeUserId: string | undefined;
    let consultantName: string | undefined;
    let consulteeName: string | undefined;
    let planTitle: string | undefined;
    const appointmentType: string = appointment.appointmentType;
    const dateTime = appointment.occurrences?.[0]?.startsAt?.toISOString();

    if (appointment.consultation) {
      consultantUserId =
        appointment.consultation.consultationPlan?.consultantProfile?.user?.id;
      consulteeUserId = appointment.consultation.requestedBy?.user?.id;
      consultantName =
        appointment.consultation.consultationPlan?.consultantProfile?.user
          ?.name || undefined;
      consulteeName =
        appointment.consultation.requestedBy?.user?.name || undefined;
      planTitle = appointment.consultation.consultationPlan?.title;
    } else if (appointment.subscription) {
      consultantUserId =
        appointment.subscription.subscriptionPlan?.consultantProfile?.user?.id;
      consulteeUserId = appointment.subscription.requestedBy?.user?.id;
      consultantName =
        appointment.subscription.subscriptionPlan?.consultantProfile?.user
          ?.name || undefined;
      consulteeName =
        appointment.subscription.requestedBy?.user?.name || undefined;
      planTitle = appointment.subscription.subscriptionPlan?.title;
    } else if (appointment.webinar || appointment.class) {
      // #1003 — group events had no recipients assembled at all, so cancelling
      // one told nobody. The organiser is the consultant on the plan; the
      // attendees are gathered after the refund fan-out below.
      const plan =
        appointment.webinar?.webinarPlan ?? appointment.class?.classPlan;
      consultantUserId = plan?.consultantProfile?.user?.id;
      consultantName = plan?.consultantProfile?.user?.name || undefined;
      planTitle = plan?.title;
    }

    // #1008 — refuse to cancel while a dispute is live on this appointment: the
    // cancel would fire refunds that double-pay against a gateway chargeback.
    if (await hasActiveDisputeForAppointment(appointmentId)) {
      return NextResponse.json(
        {
          error:
            "This appointment has an open payment dispute and can't be cancelled until it resolves.",
          code: "DISPUTE_ACTIVE",
        },
        { status: 409 },
      );
    }

    const isExclusiveType =
      !!appointment.consultation || !!appointment.subscription;

    // #1006 — the refund facts are resolved BEFORE the cancel writes and, as
    // of #1695, INSIDE the appointment lock and transaction (see below).
    //
    // The read must precede the cancel: the transaction stamps every
    // SCHEDULED/RESCHEDULED slot CANCELLED, and "which session is still owed"
    // is derived from exactly those two statuses. Resolved afterwards, the
    // booking always looks like it has no live session left, every
    // consultee-initiated cancellation falls to the 0% tier, and the refund is
    // silently skipped. Resolved before the lock, a reschedule or a capture
    // landing in the gap quoted the wrong tier against the wrong payment.
    const bookingRef = {
      appointmentId,
      consultationId: appointment.consultationId,
      subscriptionId: appointment.subscriptionId,
    };

    // Prepare cancellation data. `status` is NOT here: the transition helpers
    // own that column, and their `data` type excludes it so a caller cannot
    // write a status past the CAS.
    const cancellationData = {
      cancellationReason: (validatedData.reason as CancellationReason) || null,
      cancellationNotes: validatedData.notes || null,
      cancelledAt: new Date(),
      cancelledBy: session.user.id,
    };

    // Audit attribution for every BookingStatusHistory row this cancel writes
    // (#1322 A12).
    const auditMeta: CancelAuditMeta = {
      actorUserId: session.user.id,
      reason: validatedData.reason ?? null,
      organizationId: appointment.organizationId,
    };

    // One scope for both sweeps below, resolved before the transaction opens.
    const sweepScope = cancelSweepScope(appointment);

    // Cancellable from-states: never COMPLETED (history), never CANCELLED
    // (idempotency — a double-cancel must not re-run refunds), never
    // REJECTED/EXPIRED (nothing to cancel). The guard rides the WHERE and is
    // re-evaluated under the row lock (B2/B16 — the #825 CAS doctrine), so a
    // cancel racing the capture webhook resolves to exactly one winner.
    // The set lives in lib/booking/transitions.ts so the map is canonical (#836).

    // #1780 R-3 — the live roster, read before the cancel releases it: free
    // and credit seats are told too, each with its rail's words.
    const attendees =
      appointment.class || appointment.webinar
        ? await eventAttendeesByRail(appointmentId)
        : null;

    const { isConsultantInitiated, isExpertSideCancel, hostProfileId } = actor;

    let eventKind: "class" | "webinar" | null = null;
    if (appointment.class) eventKind = "class";
    else if (appointment.webinar) eventKind = "webinar";
    const eventId = appointment.class?.id ?? appointment.webinar?.id ?? null;
    const eventRefundReason = `whole-event ${eventKind ?? "event"} cancellation (${validatedData.reason ?? "cancelled"})`;

    // Transaction for critical database operations only (with increased timeout)
    // #1319 — serialize lifecycle mutations per appointment (lock order:
    // appointment first, before any consultee/slot key a future change adds).
    // Whole-event cancel takes the event's checkout key first (event → appointment),
    // so no seat checkout commits a HELD seat under a cancel's participant sweep.
    const eventCheckoutKey =
      eventKind && eventId
        ? {
            appointmentType: eventKind === "class" ? "CLASS" : "WEBINAR",
            eventId,
          }
        : null;
    const runCancel = (captureLanded: boolean) =>
      withEventCheckoutLock(eventCheckoutKey, () =>
        withAppointmentLock(appointmentId, () =>
          prisma.$transaction(
            async (tx) => {
              // The CAS below is pinned to this read, so a capture committing
              // after it makes the cancel match zero rows instead of cancelling
              // a paid booking with no refund.
              const observedStatus = await readRequestStatus(tx, appointment);
              // #1695 — the quote's inputs (the next live session, the SUCCEEDED
              // payment and its refundable balance, the frozen policy) are read
              // under the lock, before the CAS terminalises the slots, on the
              // transaction's own client (#1435).
              const bookingCtx = isExclusiveType
                ? await resolveBookingRefundContext(bookingRef, undefined, tx)
                : null;
              // A session about to start, under way or already held is the
              // outcome machinery's to settle, never a cancel's.
              const windowRefusal = cancelWindowRefusal(
                bookingCtx?.windowState ??
                  (await readCancelWindowState(tx, appointmentId)),
                { appointmentId },
                isConsultantInitiated ? "host" : "buyer",
              );
              if (windowRefusal) throw windowRefusal;
              const paidPayment = bookingCtx?.paidPayment ?? null;
              // The quote is pure and runs before the CAS, so a click bound to a
              // stale figure is refused with nothing committed.
              const quoted =
                bookingCtx && paidPayment
                  ? quoteBookingRefund({
                      policy: bookingCtx.policy,
                      hoursUntilNextSession: bookingCtx.hoursUntilNextSession,
                      slotsTotal: bookingCtx.slotsTotal,
                      sessionsRemaining: bookingCtx.sessionsRemaining,
                      sessionsTotal: bookingCtx.sessionsTotal,
                      sessionsRefunded: bookingCtx.sessionsRefunded,
                      sessionsCompleted: bookingCtx.sessionsCompleted,
                      scheduledStarts: bookingCtx.scheduledStarts,
                      alreadyRefundedPaise: bookingCtx.alreadyRefundedPaise,
                      isSubscription: !!appointment.subscription,
                      isConsultantInitiated,
                      // Both halves are load-bearing: `free_` with a
                      // non-zero amount is a mixed payment on the money arm.
                      isFreeCreditFunded:
                        paidPayment.amountPaise === 0 &&
                        paidPayment.paymentIntent.startsWith("free_"),
                      grossPaise: paidPayment.amountPaise,
                      refundablePaise: paidPayment.refundablePaise,
                    })
                  : null;
              // A plan with no referral credit still consumed (a 100% discount,
              // or credit already returned) has nothing for a human to return.
              const quote =
                quoted?.creditReturnNeedsReview &&
                paidPayment &&
                (await creditStillUsedPaise(tx, paidPayment.id)) <= 0
                  ? { ...quoted, creditReturnNeedsReview: false }
                  : quoted;
              if (quote)
                assertQuoteMatchesClick(
                  quote,
                  validatedData,
                  captureLanded || validatedData.expectedPaid === false,
                );

              // An unpaid booking's live payment dies with it: a capture landing
              // later finds EXPIRED and is parked + refunded. Expired before the
              // request CAS, in the capture's own lock order (payment → request).
              const pendingExpiry = isExclusiveType
                ? await expirePendingPaymentsInTx(tx, {
                    appointmentId,
                    reason: "booking cancelled before payment",
                  })
                : null;
              if (
                isExclusiveType &&
                !paidPayment &&
                (await tx.payment.count({
                  where: { appointmentId, ...LIVE_SUCCEEDED_PAYMENT_WHERE },
                })) > 0
              ) {
                throw new CaptureLandedError();
              }
              const cancellableFrom =
                observedStatus && CANCELLABLE_FROM.includes(observedStatus)
                  ? [observedStatus]
                  : [...CANCELLABLE_FROM];

              // Update appointment status based on type — through the CAS helpers,
              // which bake the same allowed-from set into the WHERE and append the
              // BookingStatusHistory row this route used to skip entirely.
              let moved = false;
              try {
                if (appointment.consultation) {
                  await transitionConsultationRequest(tx, {
                    ...auditMeta,
                    appointmentId,
                    where: { id: appointment.consultation.id },
                    to: "CANCELLED",
                    data: cancellationData,
                    fromIn: cancellableFrom,
                  });
                  moved = true;
                } else if (appointment.subscription) {
                  await transitionSubscriptionRequest(tx, {
                    ...auditMeta,
                    appointmentId,
                    // Pinned to the removed-session count the quote read, so a
                    // support refund committing meanwhile makes this re-quote.
                    where: {
                      id: appointment.subscription.id,
                      ...(bookingCtx
                        ? { sessionsRefunded: bookingCtx.sessionsRefunded }
                        : {}),
                    },
                    to: "CANCELLED",
                    data: cancellationData,
                    fromIn: cancellableFrom,
                  });
                  moved = true;
                } else if (appointment.webinar) {
                  // Explicit allowed-from (was notIn) — robust against future enum
                  // additions (#837).
                  await transitionWebinarEvent(tx, {
                    ...auditMeta,
                    appointmentId,
                    where: { id: appointment.webinar.id },
                    to: "CANCELLED",
                    fromIn: EVENT_ALLOWED_FROM.CANCELLED,
                  });
                  moved = true;
                } else if (appointment.class) {
                  await transitionClassEvent(tx, {
                    ...auditMeta,
                    appointmentId,
                    where: { id: appointment.class.id },
                    to: "CANCELLED",
                    fromIn: CLASS_EVENT_ALLOWED_FROM.CANCELLED,
                  });
                  moved = true;
                }
              } catch (err) {
                // The helper's zero-row throw IS the old `moved === 0`; the client
                // contract stays NOT_CANCELLABLE rather than ILLEGAL_TRANSITION.
                if (!(err instanceof IllegalTransitionError)) throw err;
              }
              if (!moved && appointment.subscription && bookingCtx) {
                const now = await tx.subscription.findUnique({
                  where: { id: appointment.subscription.id },
                  select: { sessionsRefunded: true },
                });
                if (now && now.sessionsRefunded !== bookingCtx.sessionsRefunded)
                  throw new PlanRefundLandedError();
              }
              if (!moved && observedStatus) {
                const nowStatus = await readRequestStatus(tx, appointment);
                if (
                  nowStatus !== observedStatus &&
                  nowStatus &&
                  CANCELLABLE_FROM.includes(nowStatus)
                ) {
                  throw new CaptureLandedError();
                }
              }
              if (!moved) {
                throw Object.assign(
                  new Error(
                    "This appointment can no longer be cancelled (already cancelled, completed, or expired).",
                  ),
                  { httpStatus: 409, code: NOT_CANCELLABLE },
                );
              }
              // #1851 decision 2 — the org's own trail, beside the booking's.
              if (orgActor) {
                await recordActForOrg(tx, {
                  actor: orgActor,
                  action: "cancel",
                  appointmentId,
                  reason: validatedData.reason,
                });
              }

              // The refund this cancel owes commits with the cancel, so a death
              // before the refund leaves a marker the retry sweep drives.
              const owed =
                quote && paidPayment
                  ? cancelRefundOwed(
                      appointmentId,
                      paidPayment.id,
                      quote,
                      isConsultantInitiated,
                    )
                  : null;
              // Only the door that owns the marker drives it; a payment already
              // owing another door's refund refuses the cancel with nothing
              // committed, so this cancel's debt is never left undurable.
              if (owed && !(await stampRefundOwed(tx, owed))) {
                throw await heldMarkerRefusal(tx, owed.paymentId, {
                  appointmentId,
                });
              }
              // The undelivered share of a credit-funded plan is returned by
              // hand; the durable row commits with the cancel.
              if (quote?.creditReturnNeedsReview && paidPayment) {
                await recordSystemEvent({
                  db: tx,
                  strict: true,
                  category: "BOOKING",
                  severity: "WARN",
                  message: `Credit seat ${paidPayment.id} needs a partial credit return`,
                  context: {
                    paymentId: paidPayment.id,
                    appointmentId,
                    sessionsTotal: bookingCtx?.sessionsTotal,
                    sessionsCompleted: bookingCtx?.sessionsCompleted,
                  },
                  correlationId: `partial-credit:${paidPayment.id}`,
                });
              }
              // With no refund to cascade, the subscription's kept tranches
              // start their hold in this commit. A plan whose credit return is
              // pending review keeps them unheld until ops returns the credit
              // or closes the return; either stamps them.
              if (
                !owed &&
                paidPayment &&
                appointment.subscription &&
                !quote?.creditReturnNeedsReview
              ) {
                await stampTranchesOnCancel(tx, {
                  paymentId: paidPayment.id,
                  now: cancellationData.cancelledAt,
                });
              }
              if (
                isExpertSideCancel &&
                hostProfileId &&
                (paidPayment !== null ||
                  (eventKind !== null &&
                    (await hasPaidLiveSeat(tx, appointmentId))))
              ) {
                const cancelledSessions =
                  await tx.appointmentOccurrence.findMany({
                    where: { appointmentId, ...LIVE_SLOT_WHERE },
                    select: { id: true },
                  });
                await recordExpertStrike(tx, {
                  consultantProfileId: hostProfileId,
                  cause: "EXPERT_CANCEL",
                  appointmentId,
                  occurrenceIds: cancelledSessions.map((o) => o.id),
                  organizationId: appointment.organizationId,
                });
              }
              // Each class seat's ledger, read under the locks on this
              // transaction and before it tombstones the sessions below, so the
              // series refunds exactly what was not delivered as of this commit.
              const seriesLedgers = appointment.class
                ? await classSeriesLedgers(appointment.class.id, tx)
                : undefined;
              const eventPlans =
                eventKind && eventId
                  ? await stampWholeEventRefundsOwed(tx, {
                      kind: eventKind,
                      eventId,
                      reason: eventRefundReason,
                      ledgers: seriesLedgers,
                    })
                  : null;

              // Soft-cancel: mark slots as CANCELLED instead of deleting.
              // CRITICAL: Do NOT delete appointments — Payment records have onDelete: Cascade
              // and deleting appointments would permanently destroy payment/refund/dispute audit trail.
              //
              // RESCHEDULED counts too. A slot released by a pending reschedule is not
              // SCHEDULED, so filtering on SCHEDULED alone left those rows in a
              // non-terminal state on a booking that no longer exists — and proposals
              // hang off exactly those rows.
              //
              // The from-set rides in `fromIn`, never in `where`: the helper
              // overwrites `completionStatus` in the caller's WHERE with its own
              // from-set, so a status left there is silently discarded.
              // #1778 — a cancelled 1:1 frees its times: tell anyone waiting.
              const holdNotices =
                appointment.consultation || appointment.subscription
                  ? await stageNoticesForAppointmentHolds(tx, appointmentId, {
                      includeConfirmed: true,
                    })
                  : null;
              const slotsCancelled = await transitionOccurrenceCompletion(tx, {
                ...auditMeta,
                where: sweepScope,
                to: "CANCELLED",
                // The tombstone is half of the soft-cancel: without it the row
                // still occupies the consultant's calendar for every reader that
                // filters on `deletedAt: null` (#676 A10, the shape
                // cleanup-abandoned-payments already writes).
                data: { deletedAt: new Date() },
                // Cancel must also sweep UNVERIFIED slots: auto-complete stamps
                // past-no-meeting sessions UNVERIFIED, and leaving them live keeps
                // a non-tombstoned row occupying the calendar on a dead booking.
                fromIn: [...SLOT_RESCHEDULABLE_FROM, "UNVERIFIED"],
                // A booking whose sessions are all delivered or already terminal
                // is still cancellable; matching no live slot is not a conflict.
                allowZero: true,
              });
              // #1319 A9 — every participant of the cancelled engagement.
              await transitionParticipant(tx, sweepScope, "CANCELLED");

              await declineOpenReschedules(tx, appointmentId, auditMeta);

              return {
                success: true,
                cancellationReason: validatedData.reason,
                cancelledAt: cancellationData.cancelledAt,
                // Slots actually cancelled; terminal history stays live by contract.
                slotsCancelled,
                webinarId: appointment.webinar?.id,
                classId: appointment.class?.id,
                paidPayment,
                quote,
                owed,
                holdNotices,
                eventPlans,
                gatewayCancels: pendingExpiry?.gatewayCancels ?? [],
              };
            },
            {
              maxWait: 10000, // Max time to wait for connection
              timeout: 30000, // 30 second transaction timeout (was 5s default)
            },
          ),
        ),
      );
    const committed = await runCancel(false)
      .catch((err: unknown) => {
        if (err instanceof CaptureLandedError) return runCancel(true);
        if (err instanceof PlanRefundLandedError) return runCancel(false);
        throw err;
      })
      .catch(async (err: unknown) => {
        // A retry after a 504 finds the booking already cancelled by this
        // caller (its requote differs once the first click refunded): answer
        // with what that click committed. Otherwise the original 409 stands.
        const replay =
          isNotCancellable(err) || err instanceof RefundQuoteChangedError
            ? await safeReplayCommittedCancel(appointment, session.user.id)
            : null;
        if (replay) return { replay };
        throw err;
      });
    if ("replay" in committed) return NextResponse.json(committed.replay);
    const {
      holdNotices,
      paidPayment,
      quote,
      owed,
      gatewayCancels,
      eventPlans,
      ...result
    } = committed;
    await flushBackupInterestNotices(holdNotices);
    await cancelGatewayOrders(gatewayCancels, {
      op: "cancel.gateway-cancel",
      appointmentId,
    });

    // B1 — policy-driven refund, AFTER the cancel tx commits, under the key the
    // owed marker carries; the CAS above runs this block at most once per click.
    let refund: CancelRefund | null = null;
    if (paidPayment && quote) {
      refund = owed
        ? await settleCancelRefund(owed, quote, {
            appointmentId,
            organizationId: appointment.organizationId ?? null,
            initiatedByUserId: session.user.id,
            refundablePaise: paidPayment.refundablePaise,
            grossPaise: paidPayment.amountPaise,
          })
        : quote.creditReturnNeedsReview
          ? {
              amountRefundedPaise: 0,
              refundPct: quote.refundPct,
              status: "PENDING",
              requiresManualReview: true,
              rail: "CREDITS",
            }
          : {
              // Two different facts, and the buyer is owed different words for
              // each: the policy tier is genuinely zero, or the tier is positive
              // but nothing is left to give back.
              amountRefundedPaise: 0,
              refundPct: quote.refundPct,
              status:
                quote.refundPct > 0 && paidPayment.refundablePaise <= 0
                  ? "NOTHING_REFUNDABLE"
                  : "POLICY_ZERO",
            };

      // A refunded subscription stamps its remaining tranches AFTER the refund,
      // so allocateCycleClawback sees holdUntil: null (rank 0) on undelivered
      // cycles and a failed or pending refund does not release them for payout.
      if (
        owed &&
        appointment.subscription &&
        (refund.status === "REFUNDED" || refund.status === "NOTHING_REFUNDABLE")
      ) {
        try {
          await stampTranchesOnCancel(prisma, {
            paymentId: paidPayment.id,
            now: result.cancelledAt,
          });
        } catch (stampErr) {
          reportRefundFailure(stampErr, "appointments");
          await recordSystemErrorSafe({
            organizationId: appointment.organizationId ?? null,
            category: "PAYMENT",
            summary: `Failed to stamp subscription tranches after cancel for payment ${paidPayment.id}`,
            err: stampErr,
            context: { appointmentId, paymentId: paidPayment.id },
          });
        }
      }
    }

    // A whole-event cancel refunds every attendee in full; the seats
    // were stamped owed in the cancel commit, and this drives a bounded bite of
    // them now, leaving the rest to the retry sweep.
    let eventRefund: WholeEventRefundSummary | null = null;
    if (eventKind && eventId) {
      eventRefund = await refundWholeEventPayments(
        eventKind,
        eventId,
        eventRefundReason,
        session.user.id,
        { plans: eventPlans ?? undefined },
      );
    }

    // Chat access ends with the booking, synchronously; a Stream failure queues a retry.
    if (eventKind && eventId && attendees) {
      await revokeEndedEventChatAccess(eventKind, eventId, attendees.all);
    } else if (consulteeUserId && consultantUserId) {
      await revokeEndedBookingChatAccess({
        userIds: [consulteeUserId],
        dmCounterpartUserIds: [consultantUserId],
        dmOrganizationId: bookingOrgId({
          consultationPlan: appointment.consultation?.consultationPlan,
          subscriptionPlan: appointment.subscription?.subscriptionPlan,
          appointment,
        }),
      });
    }

    // Notification metadata (for fire-and-forget notifications after transaction)
    const notificationMeta = {
      consultantUserId,
      consulteeUserId,
      consultantName,
      consulteeName,
      planTitle,
      appointmentType,
      dateTime,
      cancelledBy: session.user.id,
    };

    // #1003 — every paid attendee of a cancelled group event has to hear about
    // it too. They have no 1:1 counterpart on the booking, so they are read off
    // the payments, exactly as the moderation bulk-cancel does.
    const attendeeUserIds = attendees ? attendees.all : [];

    // #1580 C-P1-5 — the event's accepted collaborators hear about it too.
    let collaboratorIds: string[] = [];
    if (appointment.webinar?.webinarPlan) {
      collaboratorIds = await collaboratorUserIds(
        "webinar",
        appointment.webinar.webinarPlan.id,
      );
    } else if (appointment.class?.classPlan) {
      collaboratorIds = await collaboratorUserIds(
        "class",
        appointment.class.classPlan.id,
      );
    }

    // Fire-and-forget: notify both parties about cancellation
    const userIds = Array.from(
      new Set(
        [
          notificationMeta.consultantUserId,
          notificationMeta.consulteeUserId,
          ...attendeeUserIds,
          ...collaboratorIds,
        ].filter((id): id is string => !!id),
      ),
    );
    if (userIds.length > 0) {
      const refundText =
        refund?.status === "REFUNDED"
          ? refund.rail === "CREDITS"
            ? "Your credits have been restored."
            : refund.rail === "INTERNAL"
              ? "The amount has been returned to the sponsoring organisation's balance."
              : // The amount is in paise, so the currency is INR by construction.
                refundOnItsWay(refund.amountRefundedPaise, "INR")
          : undefined;
      const emailArgs = {
        appointmentId,
        startsAt: appointment.occurrences?.[0]?.startsAt ?? null,
        cancelledBy: cancellerName(notificationMeta, consulteeUserId),
        reason: validatedData.reason || undefined,
        dashboardUrl: notificationHref(
          appointment.organizationId,
          "appointments",
        ),
      };
      const attendeeGroups =
        attendees && eventRefund
          ? attendeeEmailGroups(
              attendees,
              !!appointment.class,
              eventRefund.failures.map((f) => f.paymentId),
            )
          : [];
      const [bellResults, ...stagedEmailBatches] = await Promise.all([
        notifyAppointmentCancelled(userIds, {
          ...notificationScope(appointment.organizationId),
          appointmentId,
          appointmentType: notificationMeta.appointmentType,
          consultantName: notificationMeta.consultantName || "Consultant",
          consulteeName: notificationMeta.consulteeName || "Consultee",
          planTitle: planTitleOrSessionLabel(
            notificationMeta.planTitle,
            notificationMeta.appointmentType,
          ),
          dateTime: notificationMeta.dateTime,
          dashboardUrl: notificationHref(
            appointment.organizationId,
            "appointments",
          ),
          reason: validatedData.reason || undefined,
          cancelledBy:
            notificationMeta.cancelledBy ===
              notificationMeta.consultantUserId ||
            (isHostOrgOperator && session.user.id !== consulteeUserId)
              ? "consultant"
              : notificationMeta.cancelledBy === consulteeUserId
                ? "consultee"
                : "system",
        }).catch((err) => {
          console.error(
            "Failed to send appointment cancellation notification:",
            err,
          );
          return [];
        }),
        ...attendeeGroups.map((group) =>
          stageAppointmentCancelledEmail(prisma, {
            ...emailArgs,
            userIds: group.userIds,
            refundText: group.refundText,
            refundUserIds: group.refundText ? group.userIds : [],
          }).catch(() => []),
        ),
        stageAppointmentCancelledEmail(prisma, {
          appointmentId,
          userIds: userIds.filter((id) => !attendeeUserIds.includes(id)),
          startsAt: appointment.occurrences?.[0]?.startsAt ?? null,
          cancelledBy:
            notificationMeta.cancelledBy === notificationMeta.consultantUserId
              ? notificationMeta.consultantName || "The consultant"
              : notificationMeta.cancelledBy === consulteeUserId
                ? notificationMeta.consulteeName || "The consultee"
                : "Familiarise",
          reason: validatedData.reason || undefined,
          refundText,
          refundUserIds: refund
            ? [consulteeUserId].filter((id): id is string => !!id)
            : [],
          dashboardUrl: notificationHref(
            appointment.organizationId,
            "appointments",
          ),
        }).catch(() => []),
      ]);
      await flushNotificationsAfter(
        {
          bells: (bellResults ?? []).map((r) => r?.staged),
          emails: [
            {
              rows: stagedEmailBatches.flat(),
              emailType: "APPOINTMENT_CANCELLED",
            },
          ],
        },
        "cancel-route",
      );
    }

    return NextResponse.json({ ...result, refund, eventRefund });
  } catch (error) {
    if (isRefusal(error)) {
      await recordRefundNeedsSupport(error);
      const message =
        (opsViewer ? opsHeldMarkerMessage(error) : null) ?? error.userMessage;
      return NextResponse.json(
        { error: message, code: error.code },
        { status: error.httpStatus },
      );
    }
    if (error instanceof RefundQuoteChangedError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          refundPaise: error.quote.refundPaise,
          refundPct: error.quote.refundPct,
          creditRestoresInFull: error.quote.creditRestoresInFull,
        },
        { status: error.httpStatus },
      );
    }
    // #1319 — lock outcomes are structured, never a 500.
    if (error instanceof BookingLockUnavailableError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    if (error instanceof AppointmentBusyError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    if (error instanceof Error && "httpStatus" in error) {
      const status =
        typeof (error as { httpStatus?: number }).httpStatus === "number"
          ? (error as { httpStatus: number }).httpStatus
          : 500;
      const code =
        "code" in error && typeof (error as { code?: string }).code === "string"
          ? (error as { code: string }).code
          : undefined;
      return NextResponse.json(
        { error: error.message, ...(code && { code }) },
        { status },
      );
    }
    if (error instanceof Error && error.message === "Appointment not found") {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404 },
      );
    }

    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "appointments" } },
    );
    console.error("Error canceling appointment:", error);
    return NextResponse.json(
      { error: "Failed to cancel appointment" },
      { status: 500 },
    );
  }
}

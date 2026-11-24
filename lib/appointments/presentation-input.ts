/**
 * #1675 — the detail payload → `deriveBookingPresentation` input. One mapper
 * so the consultant and consultee pages hand the derivation the same facts;
 * Prisma-free (types only) so the client component can import it.
 */

import type { TAppointmentDetail } from "@/lib/data/appointment-detail";
import { pendingVoidVerdict } from "@/lib/booking/pending-void-verdict";
import {
  sessionsTotalOf,
  soldTermsOf,
  subscriptionEntitlement,
  type SubscriptionEntitlement,
} from "@/lib/booking/entitlement";
import { isSponsoredPayment } from "./payment-display";
import { normalizeOccurrences } from "./normalize";
import { seriesLedgerFrom } from "@/lib/booking/class-series";
import { isReleasedForReschedule } from "@/utils/scheduling-engine/types";
import {
  requestHoldDeadline,
  type BookingPresentationInput,
  type PaymentInput,
} from "@/lib/dashboard/money-state";

type Detail = TAppointmentDetail["appointment"];
type PaymentRow = Detail["payment"][number];

function toPaymentInput(
  p: PaymentRow | PaymentRow["childPayments"][number],
): PaymentInput {
  return {
    id: p.id,
    paymentStatus: p.paymentStatus,
    paymentMethod: p.paymentMethod,
    paymentGateway: p.paymentGateway,
    receiptUrl: p.receiptUrl,
    consumerInvoice: p.consumerInvoice,
    legs: "legs" in p ? p.legs : undefined,
    refunds: p.refunds,
    amount: p.amount,
    taxAmount: p.taxAmount,
    currency: p.currency,
    createdAt: p.createdAt,
    expiresAt: "expiresAt" in p ? p.expiresAt : null,
    capturedAt: "capturedAt" in p ? p.capturedAt : null,
    gatewayOrderMinted:
      "gatewayOrderMinted" in p ? p.gatewayOrderMinted : undefined,
  };
}

/**
 * #1766 / #1775 C-5 — a subscription's frozen entitlement, or null when the
 * detail read lacks the plan shape. The header count and the next-cycle
 * ALLOCATE arm both read it.
 */
export function detailEntitlement(
  a: Detail,
  now = new Date(),
): SubscriptionEntitlement | null {
  const sub = a.subscription;
  const plan = sub?.subscriptionPlan;
  if (
    a.appointmentType !== "SUBSCRIPTION" ||
    !sub ||
    !plan ||
    typeof plan.sessionsPerWeek !== "number" ||
    typeof plan.durationInMonths !== "number" ||
    typeof plan.totalSessions !== "number"
  ) {
    return null;
  }
  return subscriptionEntitlement({
    ...soldTermsOf({ ...sub, subscriptionPlan: plan }),
    occurrences: normalizeOccurrences(a.occurrences).map((o) => ({
      ...o,
      endsAt: o.endsAt ?? o.startsAt,
    })),
    schedulingPeriodStartsAt: sub.schedulingPeriodStartsAt ?? now,
    schedulingTimezone: sub.schedulingTimezone ?? "Asia/Kolkata",
    planEndsAt: sub.planEndsAt ?? null,
    now,
  });
}

type Money = bigint | number | string;
type Priced = { price: Money; priceCurrency: string };
type Requested = {
  status: string;
  requestedAt?: Date | string | null;
  createdAt?: Date | string | null;
  bookingSource?: string | null;
};

/**
 * The lifecycle relations as any read carries them — the detail payload or
 * a payment-history row (lib/data/consultee-payments.ts). Structural, so
 * each read passes its own select.
 */
export type LifecycleRows = {
  trial?:
    | (Requested & {
        subscriptionPlan?: {
          trialPriceInPaise: Money;
          priceCurrency: string;
        } | null;
      })
    | null;
  consultation?: (Requested & { consultationPlan?: Priced | null }) | null;
  subscription?:
    | (Requested & {
        /** #1766 — the frozen entitlement; a read without it falls back to the plan. */
        sessionsTotal?: number | null;
        subscriptionPlan?: (Priced & { totalSessions: number }) | null;
      })
    | null;
  webinar?: { status: string; webinarPlan?: Priced | null } | null;
  class?: { status: string; classPlan?: Priced | null } | null;
};

/** The lifecycle row and the enum family its status belongs to. */
export function lifecycleOf(
  a: LifecycleRows,
): BookingPresentationInput["request"] {
  if (a.trial) {
    return {
      status: a.trial.status,
      kind: "TRIAL",
      requestedAt: a.trial.requestedAt,
      bookedAt: a.trial.createdAt,
    };
  }
  const request = a.consultation ?? a.subscription;
  if (request) {
    return {
      status: request.status,
      kind: a.consultation ? "CONSULTATION" : "SUBSCRIPTION",
      requestedAt: request.requestedAt,
      bookedAt: request.createdAt,
    };
  }
  const event = a.webinar ?? a.class;
  return event
    ? { status: event.status, kind: a.webinar ? "WEBINAR" : "CLASS" }
    : null;
}

/** How a consultation or subscription began; null for a trial or an event seat. */
export function bookingSourceOf(a: LifecycleRows): string | null {
  return a.consultation?.bookingSource ?? a.subscription?.bookingSource ?? null;
}

/**
 * When the unpaid hold releases: the soonest live pay link, else the trial's
 * due time, else a submitted request's answer window. A pay-first hold has
 * only its payment's own clock.
 */
export function holdDeadlineOf(args: {
  payments: ReadonlyArray<{
    paymentStatus: string;
    expiresAt?: Date | string | null;
  }>;
  trialDueAt?: Date | string | null;
  request: BookingPresentationInput["request"];
  source: string | null;
}): Date | null {
  const pending =
    args.payments
      .filter((p) => p.paymentStatus === "PENDING" && p.expiresAt)
      .map((p) => new Date(p.expiresAt!))
      .sort((x, y) => x.getTime() - y.getTime())[0] ?? null;
  if (pending) return pending;
  if (args.trialDueAt) return new Date(args.trialDueAt);
  return args.request?.status === "PENDING" && args.source !== "DIRECT_CHECKOUT"
    ? requestHoldDeadline(args.request.kind, args.request.requestedAt)
    : null;
}

export function planOf(a: LifecycleRows): BookingPresentationInput["plan"] {
  if (a.trial) {
    const p = a.trial.subscriptionPlan;
    return p
      ? {
          pricePaise: p.trialPriceInPaise ?? 0,
          currency: p.priceCurrency,
          sessions: 1,
        }
      : null;
  }
  if (a.subscription?.subscriptionPlan) {
    const p = a.subscription.subscriptionPlan;
    return {
      pricePaise: p.price,
      currency: p.priceCurrency,
      // #1766 — the entitlement frozen at purchase, not today's plan.
      sessions: sessionsTotalOf({
        sessionsTotal: a.subscription.sessionsTotal ?? null,
        subscriptionPlan: p,
      }),
    };
  }
  const p =
    a.consultation?.consultationPlan ??
    a.webinar?.webinarPlan ??
    a.class?.classPlan;
  return p
    ? { pricePaise: p.price, currency: p.priceCurrency, sessions: 1 }
    : null;
}

export function toPresentationInput(
  detail: TAppointmentDetail,
  args: {
    /** The viewer's user id — names their own co-pay rows. */
    viewerId: string | null;
    names: { payer: string; consultant: string };
    sponsorOrgName: string | null;
  },
): BookingPresentationInput {
  const a = detail.appointment;
  const request = lifecycleOf(a);
  const payments = a.payment.map(toPaymentInput);
  const source = bookingSourceOf(a);
  const holdExpiresAt = holdDeadlineOf({
    payments: a.payment,
    trialDueAt: a.trial?.paymentDueAt,
    request,
    source,
  });
  const sponsored = a.payment.some(isSponsoredPayment);
  return {
    appointmentType: a.appointmentType,
    request,
    occurrences: normalizeOccurrences(a.occurrences),
    payments,
    refunds: a.payment.flatMap((p) => p.refunds),
    disputes: a.payment.flatMap((p) => p.disputes),
    childPayments: a.payment.flatMap((p) =>
      p.childPayments
        .filter((c) => c.userId === args.viewerId)
        .map(toPaymentInput),
    ),
    sponsorOrgName: sponsored ? args.sponsorOrgName : null,
    holdExpiresAt,
    history: a.statusHistory,
    source,
    reschedule: openReschedule(a, args.viewerId),
    seatStatus:
      a.webinar || a.class
        ? (a.participants.find(
            (p) => p.userId === args.viewerId && p.role === "CONSULTEE",
          )?.status ?? null)
        : null,
    plan: planOf(a),
    names: args.names,
    entitlement: entitlementSummary(detailEntitlement(a)),
    series: classSeriesSummary(a),
  };
}

/** The open proposal with the original start it would move; null when none is open. */
function openReschedule(
  a: Detail,
  viewerId: string | null,
): BookingPresentationInput["reschedule"] {
  const open = a.rescheduleRequests[0];
  if (!open) return null;
  const original = normalizeOccurrences(a.occurrences).find(
    (o) => !o.deletedAt && isReleasedForReschedule(o),
  );
  return {
    by: open.initiatorRole === "CONSULTANT" ? "CONSULTANT" : "REQUESTER",
    // Unknown until the session loads; the page's own side decides meanwhile.
    mine: viewerId ? open.initiatedById === viewerId : undefined,
    proposedStartsAt: open.proposedTimes[0]?.startsAt ?? null,
    originalStartsAt: original?.startsAt ?? null,
    expiresAt: open.expiresAt,
  };
}

/** #1780 E-5 — a class's misses and exit right, from the detail's sessions. */
function classSeriesSummary(a: Detail): BookingPresentationInput["series"] {
  const N = a.class?.classPlan?.totalSessions;
  if (!a.class || !N) return null;
  const ledger = seriesLedgerFrom({
    N,
    occurrences: normalizeOccurrences(a.occurrences)
      .filter((o) => !o.deletedAt && !o.isTentative)
      .map((o) => ({
        ordinal: o.ordinal,
        startsAt: new Date(o.startsAt),
        endsAt: new Date(o.endsAt),
        completionStatus: o.completionStatus,
        movedAt: o.movedAt ? new Date(o.movedAt) : null,
        hostCancelledAt: o.hostCancelledAt ? new Date(o.hostCancelledAt) : null,
        // #1569 — a voided session is a miss too.
        voidedAt: o.voidedAt ? new Date(o.voidedAt) : null,
        outcome: o.outcome,
        outcomeConfirmedAt: o.outcomeConfirmedAt
          ? new Date(o.outcomeConfirmedAt)
          : null,
      })),
    now: new Date(),
  });
  return {
    misses: ledger.misses,
    N,
    exitRight: ledger.exitRight,
    undelivered: ledger.remaining + ledger.neverScheduled,
    exitWait: pendingVoidVerdict(normalizeOccurrences(a.occurrences)),
  };
}

/**
 * The card's entitlement facts. "Not held" is what was never placed or
 * delivered: a placed session awaiting its outcome is not counted yet.
 */
export function entitlementSummary(
  e: SubscriptionEntitlement | null,
  now = new Date(),
): BookingPresentationInput["entitlement"] {
  return e
    ? {
        remaining: e.remaining,
        nextBatch: e.cycle.nextBatch,
        notHeld: e.remaining,
        planEnded: now.getTime() >= e.planEndsAt.getTime(),
      }
    : null;
}

/** Who pays and who delivers, by name; the derivation swaps in "you" per viewer. */
export function presentationNames(
  detail: TAppointmentDetail,
  viewer: { role: "consultee" | "consultant"; name: string | null },
): { payer: string; consultant: string } {
  const a = detail.appointment;
  const plan =
    a.consultation?.consultationPlan ??
    a.subscription?.subscriptionPlan ??
    a.trial?.subscriptionPlan ??
    a.webinar?.webinarPlan ??
    a.class?.classPlan;
  const consultant = plan?.consultantProfile?.user?.name ?? "The consultant";
  const requester =
    a.consultation?.requestedBy?.user?.name ??
    a.subscription?.requestedBy?.user?.name ??
    a.trial?.consulteeProfile?.user?.name ??
    null;
  // A group event has no single requester: the attendee viewing is the payer.
  const payer =
    requester ??
    (viewer.role === "consultee" ? viewer.name : null) ??
    "The attendee";
  return { payer, consultant };
}

/**
 * A learner whose seat on this webinar or class was given back, reaching the
 * page only through their old payment: they read "no longer registered", not
 * the event (the API refuses them the detail).
 */
export function viewerSeatReleased(
  detail: TAppointmentDetail,
  userId: string,
): boolean {
  const a = detail.appointment;
  if (!a.webinar && !a.class) return false;
  const live = a.participants.some((p) => p.userId === userId);
  const host = a.participants.some(
    (p) => p.userId === userId && p.role !== "CONSULTEE",
  );
  return !live && !host && a.payment.some((p) => p.userId === userId);
}

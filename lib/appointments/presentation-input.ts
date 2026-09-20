/**
 * #1675 — the detail payload → `deriveBookingPresentation` input. One mapper
 * so the consultant and consultee pages hand the derivation the same facts;
 * Prisma-free (types only) so the client component can import it.
 */

import type { TAppointmentDetail } from "@/lib/data/appointment-detail";
import { sessionsTotalOf } from "@/lib/booking/entitlement";
import { isSponsoredPayment } from "./payment-display";
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
  };
}

/** The lifecycle row and the enum family its status belongs to. */
function lifecycleOf(a: Detail): BookingPresentationInput["request"] {
  if (a.trial) {
    return {
      status: a.trial.status,
      kind: "TRIAL",
      requestedAt: a.trial.requestedAt,
    };
  }
  const request = a.consultation ?? a.subscription;
  if (request) {
    return {
      status: request.status,
      kind: a.consultation ? "CONSULTATION" : "SUBSCRIPTION",
      requestedAt: request.requestedAt,
    };
  }
  const event = a.webinar ?? a.class;
  return event
    ? { status: event.status, kind: a.webinar ? "WEBINAR" : "CLASS" }
    : null;
}

function planOf(a: Detail): BookingPresentationInput["plan"] {
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
      sessions: sessionsTotalOf(a.subscription),
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
  // The pay link's own clock while one is live; else the request hold's.
  const pendingDeadline =
    a.payment
      .filter((p) => p.paymentStatus === "PENDING" && p.expiresAt)
      .map((p) => new Date(p.expiresAt!))
      .sort((x, y) => x.getTime() - y.getTime())[0] ?? null;
  const holdExpiresAt =
    pendingDeadline ??
    a.trial?.paymentDueAt ??
    (request?.status === "PENDING"
      ? requestHoldDeadline(request.kind, request.requestedAt)
      : null);
  const sponsored = a.payment.some(isSponsoredPayment);
  return {
    appointmentType: a.appointmentType,
    request,
    occurrences: a.occurrences,
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
    plan: planOf(a),
    names: args.names,
  };
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

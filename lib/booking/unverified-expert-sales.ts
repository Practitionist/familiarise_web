/**
 * What a moderation reject ends: an expert who is not verified takes no new
 * sale. Right after the reject commits, every unpaid approved link, unanswered
 * unpaid request, unpaid trial hold and unpaid group seat of theirs ends in one
 * transaction; anything with a successful payment is honoured. An order the
 * gateway has not cleared keeps its sale open.
 */

import {
  AppointmentStatus,
  PaymentStatus,
  TrialStatus,
  type PaymentGateway,
  type Prisma,
} from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { readExpertStandingForShare } from "@/lib/booking/expert-standing";
import { isPublicExpertProfile } from "@/lib/profiles/public-profile";
import { lapseApprovedRequest } from "@/lib/booking/lapse-approved-request";
import {
  expirePendingPaymentsInTx,
  type GatewayCancel,
} from "@/lib/booking/pending-payment-expiry";
import {
  NOT_BEING_MOVED,
  releaseDeclinedRequestHold,
} from "@/lib/booking/request-route-guards";
import { releaseParticipant } from "@/lib/booking/participants";
import {
  transitionConsultationRequest,
  transitionSubscriptionRequest,
  transitionTrial,
} from "@/lib/booking/transitions";
import type { StagedBackupInterestNotices } from "@/lib/booking/backup-interest";
import { softCancelTrialAppointmentInTx } from "@/lib/trials/cancellation";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import {
  PRE_MINT_INTENT_PREFIX,
  isPreMintIntent,
} from "@/lib/payments/pre-mint-intent";

/** The history reason every ending below records; neutral, since learners read their history. */
export const EXPERT_UNAVAILABLE_REASON = "EXPERT_UNAVAILABLE";

/** One booking the reject ended: who to tell, and about what. */
export interface EndedSale {
  kind: "consultation" | "subscription" | "trial" | "seat";
  /** The booking's type, as the learner's notice names it. */
  appointmentType: "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" | "CLASS";
  id: string;
  appointmentId: string | null;
  organizationId: string | null;
  learnerUserId: string;
  learnerName: string;
  expertName: string;
  planTitle: string;
  startsAt: Date | null;
  /** A gateway order existed for it, so the notice may not promise no charge. */
  orderExisted: boolean;
}

export interface EndedUnpaidSales {
  payLinksClosed: number;
  requestsDeclined: number;
  trialHoldsReleased: number;
  seatsReleased: number;
  /** Sales left open because an order of theirs was not cleared by the gateway. */
  salesKept: number;
  /** Open orders the gateway was not asked about under their current intent. */
  ordersChanged: string[];
  /** The expert was verified again by the time the ending ran, so nothing ended. */
  skipped: boolean;
  ended: EndedSale[];
  /** The real gateway orders this ending expired, re-read after commit. */
  closedOrders: GatewayCancel[];
  holdNotices: StagedBackupInterestNotices[];
}

/** One open order the gateway was asked about before anything closed. */
export interface OpenOrder {
  paymentId: string;
  paymentIntent: string;
  paymentGateway: PaymentGateway;
  isMockPayment: boolean;
}

/** The PENDING orders on every sale of the expert's that the ending could close. */
export function openSaleOrdersWhere(
  consultantProfileId: string,
): Prisma.PaymentWhereInput {
  return {
    paymentStatus: PaymentStatus.PENDING,
    appointment: {
      OR: [
        { consultation: { consultationPlan: { consultantProfileId } } },
        { subscription: { subscriptionPlan: { consultantProfileId } } },
        { trial: { consultantProfileId } },
        { webinar: { webinarPlan: { consultantProfileId } } },
        { class: { classPlan: { consultantProfileId } } },
      ],
    },
  };
}

/** Whether an order needs the gateway's answer: a mock or pre-mint order names none. */
export function isGatewayOrder(order: OpenOrder): boolean {
  return !order.isMockPayment && !isPreMintIntent(order.paymentIntent);
}

const FIRST_SESSION = {
  where: { deletedAt: null },
  orderBy: { startsAt: "asc" as const },
  take: 1,
  select: { startsAt: true },
};
const PARTIES = {
  id: true,
  requestedBy: { select: { user: { select: { id: true, name: true } } } },
  appointment: {
    select: { id: true, organizationId: true, occurrences: FIRST_SESSION },
  },
} as const;
const PLAN = {
  select: {
    title: true,
    consultantProfile: { select: { user: { select: { name: true } } } },
  },
} as const;

const NO_SUCCEEDED_PAYMENT = {
  payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
} as const;
/** No captured payment: a request with no appointment yet has none either. */
const UNPAID_REQUEST = {
  OR: [{ appointment: null }, { appointment: NO_SUCCEEDED_PAYMENT }],
};

type Party = { user: { id: string; name: string | null } };
type Booking = {
  id: string;
  organizationId: string | null;
  occurrences: { startsAt: Date }[];
} | null;
type PlanNames = {
  title: string;
  consultantProfile: { user: { name: string | null } } | null;
};

interface EndingContext {
  tx: Tx;
  actorUserId: string;
  /** Order id to the intent the gateway cleared; anything else keeps its sale open. */
  cleared: ReadonlyMap<string, string>;
  /** Every order id the gateway step read, cleared or not. */
  asked: ReadonlySet<string>;
  out: EndedUnpaidSales;
}

const NOTICE_TYPE = {
  consultation: "CONSULTATION",
  subscription: "SUBSCRIPTION",
  trial: "SUBSCRIPTION",
} as const;

function saleOf(
  kind: EndedSale["kind"],
  appointmentType: EndedSale["appointmentType"],
  id: string,
  party: Party,
  booking: Booking,
  plan: PlanNames,
  orderExisted: boolean,
): EndedSale {
  return {
    kind,
    appointmentType,
    id,
    appointmentId: booking?.id ?? null,
    organizationId: booking?.organizationId ?? null,
    learnerUserId: party.user.id,
    learnerName: party.user.name || "User",
    expertName: plan.consultantProfile?.user.name || "Consultant",
    planTitle: plan.title,
    startsAt: booking?.occurrences[0]?.startsAt ?? null,
    orderExisted,
  };
}

/**
 * Whether every open order on the booking (one buyer's, for a seat) was cleared
 * by the gateway under its current intent. Answers whether a gateway order existed.
 */
async function clearedOrders(
  ctx: EndingContext,
  appointmentId: string | null,
  userId?: string,
): Promise<{ closable: boolean; orderExisted: boolean }> {
  if (!appointmentId) return { closable: true, orderExisted: false };
  const pending = await ctx.tx.payment.findMany({
    where: {
      appointmentId,
      paymentStatus: PaymentStatus.PENDING,
      ...(userId ? { userId } : {}),
    },
    select: { id: true, paymentIntent: true, isMockPayment: true },
  });
  const closable = pending.every(
    (p) => ctx.cleared.get(p.id) === p.paymentIntent,
  );
  for (const p of pending) {
    const clearedIntent = ctx.cleared.get(p.id);
    const changed =
      !ctx.asked.has(p.id) ||
      (clearedIntent !== undefined && clearedIntent !== p.paymentIntent);
    if (changed && !ctx.out.ordersChanged.includes(p.id)) {
      ctx.out.ordersChanged.push(p.id);
    }
  }
  const orderExisted = await ctx.tx.payment.count({
    where: {
      appointmentId,
      ...(userId ? { userId } : {}),
      isMockPayment: false,
      NOT: { paymentIntent: { startsWith: PRE_MINT_INTENT_PREFIX } },
    },
  });
  return { closable, orderExisted: orderExisted > 0 };
}

/** Expires the booking's cleared orders, returning what they consumed, and keeps the real ones for the re-check. */
async function expireOrders(
  ctx: EndingContext,
  appointmentId: string,
  reason: string,
  userId?: string,
): Promise<void> {
  const { gatewayCancels } = await expirePendingPaymentsInTx(ctx.tx, {
    appointmentId,
    reason,
    ...(userId ? { userId } : {}),
  });
  ctx.out.closedOrders.push(...gatewayCancels);
}

/** The expert's 1:1 and subscription bookings matching `where`, each with its kind and plan. */
async function oneOnOneSales(
  ctx: EndingContext,
  consultantProfileId: string,
  where: Prisma.ConsultationWhereInput & Prisma.SubscriptionWhereInput,
) {
  const consultations = await ctx.tx.consultation.findMany({
    where: { ...where, consultationPlan: { consultantProfileId } },
    select: { ...PARTIES, consultationPlan: PLAN },
  });
  const subscriptions = await ctx.tx.subscription.findMany({
    where: { ...where, subscriptionPlan: { consultantProfileId } },
    select: { ...PARTIES, subscriptionPlan: PLAN },
  });
  return [
    ...consultations.map((r) => ({
      kind: "consultation" as const,
      row: r,
      plan: r.consultationPlan,
    })),
    ...subscriptions.map((r) => ({
      kind: "subscription" as const,
      row: r,
      plan: r.subscriptionPlan,
    })),
  ];
}

async function closeApprovedLinks(
  ctx: EndingContext,
  consultantProfileId: string,
): Promise<void> {
  const linked = { status: AppointmentStatus.APPROVED_PENDING_PAYMENT };
  const rows = await oneOnOneSales(ctx, consultantProfileId, linked);
  for (const { kind, row, plan } of rows) {
    const orders = await clearedOrders(ctx, row.appointment?.id ?? null);
    if (!orders.closable) {
      ctx.out.salesKept += 1;
      continue;
    }
    const lapsed = await lapseApprovedRequest(ctx.tx, {
      kind,
      id: row.id,
      reason: EXPERT_UNAVAILABLE_REASON,
      actorUserId: ctx.actorUserId,
    });
    if (lapsed.moved === 0) continue;
    ctx.out.payLinksClosed += 1;
    ctx.out.closedOrders.push(...(lapsed.gatewayCancels ?? []));
    if (lapsed.holdNotices) ctx.out.holdNotices.push(lapsed.holdNotices);
    ctx.out.ended.push(
      saleOf(
        kind,
        NOTICE_TYPE[kind],
        row.id,
        row.requestedBy,
        row.appointment,
        plan,
        orders.orderExisted,
      ),
    );
  }
}

async function declineOpenRequests(
  ctx: EndingContext,
  consultantProfileId: string,
): Promise<void> {
  const open = { status: AppointmentStatus.PENDING, ...UNPAID_REQUEST };
  const rows = await oneOnOneSales(ctx, consultantProfileId, open);
  for (const { kind, row, plan } of rows) {
    const orders = await clearedOrders(ctx, row.appointment?.id ?? null);
    if (!orders.closable) {
      ctx.out.salesKept += 1;
      continue;
    }
    const cas = {
      fromIn: [AppointmentStatus.PENDING],
      to: AppointmentStatus.REJECTED,
      data: { pendingPaymentUrl: null },
      reason: EXPERT_UNAVAILABLE_REASON,
      actorUserId: ctx.actorUserId,
    };
    const where = { id: row.id, ...NOT_BEING_MOVED, ...UNPAID_REQUEST };
    try {
      if (kind === "consultation") {
        await transitionConsultationRequest(ctx.tx, { ...cas, where });
      } else {
        await transitionSubscriptionRequest(ctx.tx, { ...cas, where });
      }
    } catch (error) {
      if (error instanceof IllegalTransitionError) continue;
      throw error;
    }
    if (row.appointment) {
      await expireOrders(
        ctx,
        row.appointment.id,
        "Request closed: the expert is not taking bookings",
      );
    }
    ctx.out.holdNotices.push(
      await releaseDeclinedRequestHold(
        ctx.tx,
        kind === "consultation"
          ? { consultationId: row.id }
          : { subscriptionId: row.id },
        ctx.actorUserId,
      ),
    );
    ctx.out.requestsDeclined += 1;
    ctx.out.ended.push(
      saleOf(
        kind,
        NOTICE_TYPE[kind],
        row.id,
        row.requestedBy,
        row.appointment,
        plan,
        orders.orderExisted,
      ),
    );
  }
}

async function releaseTrialHolds(
  ctx: EndingContext,
  consultantProfileId: string,
): Promise<void> {
  const trials = await ctx.tx.trial.findMany({
    where: {
      consultantProfileId,
      status: TrialStatus.AWAITING_PAYMENT,
      paymentId: null,
    },
    select: {
      id: true,
      consulteeProfile: {
        select: { user: { select: { id: true, name: true } } },
      },
      subscriptionPlan: PLAN,
      appointment: {
        select: { id: true, organizationId: true, occurrences: FIRST_SESSION },
      },
    },
  });
  for (const trial of trials) {
    const appointmentId = trial.appointment?.id ?? null;
    const orders = await clearedOrders(ctx, appointmentId);
    if (!orders.closable) {
      ctx.out.salesKept += 1;
      continue;
    }
    try {
      await transitionTrial(ctx.tx, {
        where: { id: trial.id },
        to: TrialStatus.CANCELLED,
        fromIn: [TrialStatus.AWAITING_PAYMENT],
        // The capture stamps paymentId; the appointment arm catches a late stamp.
        whereAnd: {
          paymentId: null,
          NOT: {
            appointment: {
              is: { payment: { some: { paymentStatus: "SUCCEEDED" } } },
            },
          },
        },
        data: { pendingPaymentUrl: null, paymentDueAt: null },
        reason: EXPERT_UNAVAILABLE_REASON,
        actorUserId: ctx.actorUserId,
      });
    } catch (error) {
      if (error instanceof IllegalTransitionError) continue;
      throw error;
    }
    if (appointmentId) {
      await expireOrders(
        ctx,
        appointmentId,
        "Trial hold released: the expert is not taking bookings",
      );
      await softCancelTrialAppointmentInTx(ctx.tx, appointmentId);
    }
    ctx.out.trialHoldsReleased += 1;
    ctx.out.ended.push(
      saleOf(
        "trial",
        NOTICE_TYPE.trial,
        trial.id,
        trial.consulteeProfile,
        trial.appointment,
        trial.subscriptionPlan,
        orders.orderExisted,
      ),
    );
  }
}

/** A buyer's unpaid seat on the expert's own webinar or class; the event and its paid seats stay. */
async function releaseUnpaidSeats(
  ctx: EndingContext,
  consultantProfileId: string,
): Promise<void> {
  const seats = await ctx.tx.appointmentParticipant.findMany({
    where: {
      role: "CONSULTEE",
      status: "HELD",
      NOT: { payment: { is: { paymentStatus: PaymentStatus.SUCCEEDED } } },
      appointment: {
        deletedAt: null,
        OR: [
          { webinar: { webinarPlan: { consultantProfileId } } },
          { class: { classPlan: { consultantProfileId } } },
        ],
      },
    },
    select: {
      id: true,
      user: { select: { id: true, name: true } },
      appointment: {
        select: {
          id: true,
          organizationId: true,
          occurrences: FIRST_SESSION,
          webinar: { select: { webinarPlan: PLAN } },
          class: { select: { classPlan: PLAN } },
        },
      },
    },
  });
  for (const seat of seats) {
    const plan =
      seat.appointment.webinar?.webinarPlan ??
      seat.appointment.class?.classPlan;
    if (!plan) continue;
    const orders = await clearedOrders(ctx, seat.appointment.id, seat.user.id);
    if (!orders.closable) {
      ctx.out.salesKept += 1;
      continue;
    }
    const released = await releaseParticipant(ctx.tx, {
      id: seat.id,
      status: "HELD",
      NOT: { payment: { is: { paymentStatus: PaymentStatus.SUCCEEDED } } },
    });
    if (released === 0) continue;
    await expireOrders(
      ctx,
      seat.appointment.id,
      "Seat released: the expert is not taking bookings",
      seat.user.id,
    );
    ctx.out.seatsReleased += 1;
    ctx.out.ended.push(
      saleOf(
        "seat",
        seat.appointment.webinar ? "WEBINAR" : "CLASS",
        seat.id,
        { user: seat.user },
        seat.appointment,
        plan,
        orders.orderExisted,
      ),
    );
  }
}

/**
 * Ends every unpaid sale of the expert on the caller's transaction. Each write
 * is a CAS through the existing helpers; a row a capture already moved matches
 * zero rows and stays, and a sale with an order the gateway did not clear stays open.
 */
export async function endUnpaidSalesInTx(
  tx: Tx,
  args: {
    consultantProfileId: string;
    actorUserId: string;
    cleared: ReadonlyMap<string, string>;
    asked: ReadonlySet<string>;
  },
): Promise<EndedUnpaidSales> {
  const out: EndedUnpaidSales = {
    payLinksClosed: 0,
    requestsDeclined: 0,
    trialHoldsReleased: 0,
    seatsReleased: 0,
    salesKept: 0,
    ordersChanged: [],
    skipped: false,
    ended: [],
    closedOrders: [],
    holdNotices: [],
  };
  // Locked first, so a verification approval waits and a re-verified expert's sales stay.
  const standing = await readExpertStandingForShare(
    tx,
    args.consultantProfileId,
  );
  if (standing && isPublicExpertProfile(standing)) {
    out.skipped = true;
    return out;
  }
  const ctx: EndingContext = {
    tx,
    actorUserId: args.actorUserId,
    cleared: args.cleared,
    asked: args.asked,
    out,
  };
  await closeApprovedLinks(ctx, args.consultantProfileId);
  await declineOpenRequests(ctx, args.consultantProfileId);
  await releaseTrialHolds(ctx, args.consultantProfileId);
  await releaseUnpaidSeats(ctx, args.consultantProfileId);
  return out;
}

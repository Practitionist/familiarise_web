/**
 * What a moderation reject ends: an expert who is not verified takes no new
 * sale. Every unpaid approved link, unanswered unpaid request and unpaid trial
 * hold of theirs ends in the reject's own transaction; anything with a
 * successful payment is honoured.
 */

import { AppointmentStatus, PaymentStatus, TrialStatus } from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { lapseApprovedRequest } from "@/lib/booking/lapse-approved-request";
import {
  expirePendingPaymentsInTx,
  type GatewayCancel,
} from "@/lib/booking/pending-payment-expiry";
import {
  NOT_BEING_MOVED,
  releaseDeclinedRequestHold,
} from "@/lib/booking/request-route-guards";
import {
  transitionConsultationRequest,
  transitionSubscriptionRequest,
  transitionTrial,
} from "@/lib/booking/transitions";
import type { StagedBackupInterestNotices } from "@/lib/booking/backup-interest";
import { softCancelTrialAppointmentInTx } from "@/lib/trials/cancellation";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";

/** The history reason every ending below records. */
export const EXPERT_NOT_VERIFIED_REASON = "EXPERT_NOT_VERIFIED";

/** The learner's notice for a request or link the reject closed: neutral, never the reason. */
export function closedRequestNotice(expertName: string): string {
  return `${expertName} isn't taking bookings right now, so your request was closed. No payment was taken.`;
}

/** One booking the reject ended: who to tell, and about what. */
export interface EndedSale {
  kind: "consultation" | "subscription" | "trial";
  outcome: "LINK_CLOSED" | "REQUEST_DECLINED" | "TRIAL_RELEASED";
  id: string;
  appointmentId: string | null;
  organizationId: string | null;
  learnerUserId: string;
  learnerName: string;
  expertName: string;
  planTitle: string;
  startsAt: Date | null;
}

export interface EndedUnpaidSales {
  payLinksClosed: number;
  requestsDeclined: number;
  trialHoldsReleased: number;
  ended: EndedSale[];
  gatewayCancels: GatewayCancel[];
  holdNotices: StagedBackupInterestNotices[];
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

type RequestRow = {
  id: string;
  requestedBy: { user: { id: string; name: string | null } };
  appointment: {
    id: string;
    organizationId: string | null;
    occurrences: { startsAt: Date }[];
  } | null;
};

function saleOf(
  kind: EndedSale["kind"],
  outcome: EndedSale["outcome"],
  row: RequestRow,
  plan: { title: string; consultantProfile: { user: { name: string | null } } },
): EndedSale {
  return {
    kind,
    outcome,
    id: row.id,
    appointmentId: row.appointment?.id ?? null,
    organizationId: row.appointment?.organizationId ?? null,
    learnerUserId: row.requestedBy.user.id,
    learnerName: row.requestedBy.user.name || "User",
    expertName: plan.consultantProfile.user.name || "Consultant",
    planTitle: plan.title,
    startsAt: row.appointment?.occurrences[0]?.startsAt ?? null,
  };
}

/**
 * Ends every unpaid sale of the expert on the caller's transaction: approved
 * links lapse to EXPIRED, unanswered requests are declined, unpaid trial holds
 * are cancelled; each open order is expired by CAS and gives back what its
 * checkout consumed. A row a capture already moved matches zero rows and stays.
 */
export async function endUnpaidSalesInTx(
  tx: Tx,
  args: { consultantProfileId: string; actorUserId: string },
): Promise<EndedUnpaidSales> {
  const out: EndedUnpaidSales = {
    payLinksClosed: 0,
    requestsDeclined: 0,
    trialHoldsReleased: 0,
    ended: [],
    gatewayCancels: [],
    holdNotices: [],
  };
  const { consultantProfileId, actorUserId } = args;
  const reason = EXPERT_NOT_VERIFIED_REASON;

  const linked = {
    status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
  } as const;
  const consultationsLinked = await tx.consultation.findMany({
    where: { ...linked, consultationPlan: { consultantProfileId } },
    select: { ...PARTIES, consultationPlan: PLAN },
  });
  const subscriptionsLinked = await tx.subscription.findMany({
    where: { ...linked, subscriptionPlan: { consultantProfileId } },
    select: { ...PARTIES, subscriptionPlan: PLAN },
  });
  const lapses = [
    ...consultationsLinked.map((r) => ({
      kind: "consultation" as const,
      row: r,
      plan: r.consultationPlan,
    })),
    ...subscriptionsLinked.map((r) => ({
      kind: "subscription" as const,
      row: r,
      plan: r.subscriptionPlan,
    })),
  ];
  for (const { kind, row, plan } of lapses) {
    const lapsed = await lapseApprovedRequest(tx, {
      kind,
      id: row.id,
      reason: "EXPERT_NOT_VERIFIED",
      actorUserId,
    });
    if (lapsed.moved === 0) continue;
    out.payLinksClosed += 1;
    out.gatewayCancels.push(...(lapsed.gatewayCancels ?? []));
    if (lapsed.holdNotices) out.holdNotices.push(lapsed.holdNotices);
    out.ended.push(saleOf(kind, "LINK_CLOSED", row, plan));
  }

  const open = {
    status: AppointmentStatus.PENDING,
    ...UNPAID_REQUEST,
  } as const;
  const consultationsOpen = await tx.consultation.findMany({
    where: { ...open, consultationPlan: { consultantProfileId } },
    select: { ...PARTIES, consultationPlan: PLAN },
  });
  const subscriptionsOpen = await tx.subscription.findMany({
    where: { ...open, subscriptionPlan: { consultantProfileId } },
    select: { ...PARTIES, subscriptionPlan: PLAN },
  });
  const declines = [
    ...consultationsOpen.map((r) => ({
      kind: "consultation" as const,
      row: r,
      plan: r.consultationPlan,
    })),
    ...subscriptionsOpen.map((r) => ({
      kind: "subscription" as const,
      row: r,
      plan: r.subscriptionPlan,
    })),
  ];
  for (const { kind, row, plan } of declines) {
    const cas = {
      fromIn: [AppointmentStatus.PENDING],
      to: AppointmentStatus.REJECTED,
      data: { pendingPaymentUrl: null },
      reason,
      actorUserId,
    };
    try {
      if (kind === "consultation") {
        await transitionConsultationRequest(tx, {
          ...cas,
          where: { id: row.id, ...NOT_BEING_MOVED, ...UNPAID_REQUEST },
        });
      } else {
        await transitionSubscriptionRequest(tx, {
          ...cas,
          where: { id: row.id, ...NOT_BEING_MOVED, ...UNPAID_REQUEST },
        });
      }
    } catch (error) {
      if (error instanceof IllegalTransitionError) continue;
      throw error;
    }
    if (row.appointment) {
      // Claimed here so the orders can be cancelled after commit; the release finds none left.
      const expired = await expirePendingPaymentsInTx(tx, {
        appointmentId: row.appointment.id,
        reason: "Request declined: the expert is no longer verified",
      });
      out.gatewayCancels.push(...expired.gatewayCancels);
    }
    const holdNotices = await releaseDeclinedRequestHold(
      tx,
      kind === "consultation"
        ? { consultationId: row.id }
        : { subscriptionId: row.id },
      actorUserId,
    );
    out.holdNotices.push(holdNotices);
    out.requestsDeclined += 1;
    out.ended.push(saleOf(kind, "REQUEST_DECLINED", row, plan));
  }

  const trials = await tx.trial.findMany({
    where: {
      consultantProfileId,
      status: TrialStatus.AWAITING_PAYMENT,
      paymentId: null,
    },
    select: {
      id: true,
      appointmentId: true,
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
    try {
      await transitionTrial(tx, {
        where: { id: trial.id },
        to: TrialStatus.CANCELLED,
        fromIn: [TrialStatus.AWAITING_PAYMENT],
        whereAnd: { paymentId: null },
        data: { pendingPaymentUrl: null, paymentDueAt: null },
        reason,
        actorUserId,
      });
    } catch (error) {
      if (error instanceof IllegalTransitionError) continue;
      throw error;
    }
    if (trial.appointmentId) {
      const expired = await expirePendingPaymentsInTx(tx, {
        appointmentId: trial.appointmentId,
        reason: "Trial hold released: the expert is no longer verified",
      });
      out.gatewayCancels.push(...expired.gatewayCancels);
      await softCancelTrialAppointmentInTx(tx, trial.appointmentId);
    }
    out.trialHoldsReleased += 1;
    out.ended.push(
      saleOf(
        "trial",
        "TRIAL_RELEASED",
        {
          id: trial.id,
          requestedBy: trial.consulteeProfile,
          appointment: trial.appointment,
        },
        trial.subscriptionPlan,
      ),
    );
  }
  return out;
}

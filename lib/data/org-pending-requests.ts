/**
 * Org-funded bookings that nobody has scheduled yet — the payer's view.
 *
 * #1166 B2B gap 8. Allocation is a delivery act, so the Requests page is gated
 * on holding a consultant profile. That left the org's OWNER and MAINTAINER —
 * the people who answer for the money — with no surface at all for a request
 * their organization funded and no expert has put slots against. This read
 * backs that view. It returns display facts only: there is nothing to act on
 * here, because choosing a session's times is still the delivering expert's
 * call.
 *
 * Two kinds of row, both on bookings the org owns (`orgOwnedAppointmentWhere`):
 * PENDING requests still awaiting the expert's approval, and APPROVED ones with
 * no confirmed live session that the org's own money paid for, which it may
 * allocate. The payer sees every expert's queue in their org.
 */

import prisma from "@/lib/prisma";
import { AppointmentStatus } from "@prisma/client";
import { orgOwnedAppointmentWhere } from "@/lib/api/scope/list-appointments";
import { ORG_FUNDING_PAYMENT_STATUSES } from "@/lib/booking/org-actor";
import { orgFundedPaymentWhere } from "@/lib/data/org-sponsored-seats";
import { liveOccurrenceWhere } from "@/lib/appointments/occurrences";

export interface OrgPendingRequest {
  id: string;
  appointmentId?: string | null;
  kind: "CONSULTATION" | "SUBSCRIPTION";
  planTitle: string;
  learnerName: string | null;
  expertName: string | null;
  /** ISO — this crosses into a Client Component. */
  requestedAt: string;
  /** Only an APPROVED booking can be allocated by the org; anything else waits on the expert. */
  awaitingExpertApproval: boolean;
}

/** A page of this is a queue, not a ledger; the org home links to the full view. */
const PENDING_TAKE = 50;

export async function readOrgPendingRequests(
  orgId: string,
): Promise<OrgPendingRequest[]> {
  const orgPin = orgOwnedAppointmentWhere(orgId);
  const waitingWhere = {
    OR: [
      { status: AppointmentStatus.PENDING, appointment: orgPin },
      // Only an org-funded approved booking is one the org may allocate.
      {
        status: AppointmentStatus.APPROVED,
        appointment: {
          ...orgPin,
          occurrences: { none: { ...liveOccurrenceWhere, isTentative: false } },
          payment: {
            some: {
              ...orgFundedPaymentWhere(orgId),
              paymentStatus: { in: ORG_FUNDING_PAYMENT_STATUSES },
              deletedAt: null,
            },
          },
        },
      },
    ],
  };
  const planSelect = {
    select: {
      title: true,
      consultantProfile: { select: { user: { select: { name: true } } } },
    },
  } as const;
  const learnerSelect = {
    select: { user: { select: { name: true } } },
  } as const;

  const [consultations, subscriptions] = await Promise.all([
    prisma.consultation.findMany({
      where: waitingWhere,
      select: {
        id: true,
        status: true,
        requestedAt: true,
        appointment: { select: { id: true } },
        consultationPlan: planSelect,
        requestedBy: learnerSelect,
      },
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      take: PENDING_TAKE,
    }),
    prisma.subscription.findMany({
      where: waitingWhere,
      select: {
        id: true,
        status: true,
        requestedAt: true,
        appointment: { select: { id: true } },
        subscriptionPlan: planSelect,
        requestedBy: learnerSelect,
      },
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      take: PENDING_TAKE,
    }),
  ]);

  return [
    ...consultations.map((c) => ({
      id: c.id,
      appointmentId: c.appointment?.id ?? null,
      kind: "CONSULTATION" as const,
      planTitle: c.consultationPlan.title,
      learnerName: c.requestedBy.user.name,
      expertName: c.consultationPlan.consultantProfile.user.name,
      requestedAt: c.requestedAt.toISOString(),
      awaitingExpertApproval: c.status !== AppointmentStatus.APPROVED,
    })),
    ...subscriptions.map((s) => ({
      id: s.id,
      appointmentId: s.appointment?.id ?? null,
      kind: "SUBSCRIPTION" as const,
      planTitle: s.subscriptionPlan.title,
      learnerName: s.requestedBy.user.name,
      expertName: s.subscriptionPlan.consultantProfile.user.name,
      requestedAt: s.requestedAt.toISOString(),
      awaitingExpertApproval: s.status !== AppointmentStatus.APPROVED,
    })),
  ]
    .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
    .slice(0, PENDING_TAKE);
}

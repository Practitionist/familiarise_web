/**
 * Shared read for the single-appointment detail hub (consultant + consultee
 * /appointments/[appointmentId] pages). Both the API route
 * (GET /api/appointments/[appointmentId]) and the RSC prefetch call this so
 * SSR hydration and the client useQuery resolve identical payloads.
 *
 * Includes everything the detail page renders: the polymorphic event with
 * plan + people, ordered slots with meeting sessions AND their recordings,
 * payment, sponsoring org — plus sibling appointments of the same
 * subscription/class so the timeline shows the whole program. userId fields
 * on the profile selects exist for the API route's ownership check.
 */

import prisma from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";
import type { AppointmentFeedbackRole, RefundStatus } from "@prisma/client";
import { toPlain } from "@/lib/data/serialize";

const userSelect = {
  select: { id: true, name: true, image: true },
} as const;

const recordingsSelect = {
  select: {
    id: true,
    title: true,
    recordingUrl: true,
    storageUrl: true,
    thumbnailUrl: true,
    status: true,
    durationInMinutes: true,
    recordedAt: true,
  },
} as const;

const slotsInclude = {
  orderBy: { startsAt: "asc" },
  include: {
    meeting: {
      select: {
        id: true,
        endedAt: true,
        endedReason: true,
        recordings: recordingsSelect,
      },
    },
  },
} as const;

const consultantProfileSelect = {
  select: { id: true, userId: true, user: userSelect },
} as const;

const consulteeProfileSelect = {
  select: { id: true, userId: true, user: userSelect },
} as const;

// A mutable array: Prisma's `in` rejects the readonly tuple `as const` makes.
// #1780 — FAILED rides along for the refund timeline; the money sums read status explicitly.
const LIVE_REFUND_STATUSES: RefundStatus[] = ["PENDING", "SUCCEEDED", "FAILED"];

/**
 * What a payer may read of their own row: the amount line, the rail it rode,
 * and the receipt behind it. One Payment per attendee per appointment, so the
 * host needs `userId` to put a status on each seat; attendees only ever
 * receive their own rows (scopeAppointmentDetail).
 */
const paymentDisplaySelect = {
  id: true,
  amount: true,
  // #1675 — the pay-link copy names the base and the GST on top of it.
  taxAmount: true,
  currency: true,
  paymentStatus: true,
  paymentMethod: true,
  paymentGateway: true,
  receiptUrl: true,
  createdAt: true,
  userId: true,
  // #1365 — the buyer's tax invoice is the receipt; a link, not the row.
  // #1527 — its credit notes ride along so a refund can link its note.
  consumerInvoice: {
    select: {
      id: true,
      creditNotes: {
        select: { id: true, creditNoteNumber: true },
        orderBy: { issuedAt: "asc" },
      },
    },
  },
  // `PaymentStatus` never reaches REFUNDED; the shown status is derived from
  // the refunds that went through (lib/appointments/seat-payments.ts). A
  // PENDING one rides along so the money line can say "on its way" (#1675).
  refunds: {
    where: { deletedAt: null, status: { in: LIVE_REFUND_STATUSES } },
    select: {
      amountPaise: true,
      status: true,
      refundId: true,
      createdAt: true,
    },
  },
  disputes: { select: { status: true } },
} as const;

const collaboratorsInclude = {
  where: { status: "ACCEPTED" as const },
  select: {
    role: true,
    consultantProfile: consultantProfileSelect,
  },
} as const;

export async function readAppointmentDetail(appointmentId: string) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: {
        include: {
          consultationPlan: {
            include: { consultantProfile: consultantProfileSelect },
          },
          requestedBy: consulteeProfileSelect,
        },
      },
      subscription: {
        include: {
          subscriptionPlan: {
            include: { consultantProfile: consultantProfileSelect },
          },
          requestedBy: consulteeProfileSelect,
        },
      },
      webinar: {
        include: {
          webinarPlan: {
            include: {
              consultantProfile: consultantProfileSelect,
              collaborators: collaboratorsInclude,
            },
          },
        },
      },
      class: {
        include: {
          classPlan: {
            include: {
              consultantProfile: consultantProfileSelect,
              collaborators: collaboratorsInclude,
            },
          },
        },
      },
      trial: {
        include: {
          consulteeProfile: consulteeProfileSelect,
          subscriptionPlan: {
            include: { consultantProfile: consultantProfileSelect },
          },
        },
      },
      // Display-fields allowlist (#946 pattern) — the counterpart to the
      // booking must not receive gateway ids / tax internals.
      payment: {
        select: {
          ...paymentDisplaySelect,
          // #1428 — the tentative-hold deadline shown on the detail page;
          // without it a held slot has no way to say when it releases.
          expiresAt: true,
          // #1775 C-5 — the 48 h allocate-or-refund clock.
          capturedAt: true,
          // Which rail funded the row (lib/appointments/payment-display.ts):
          // an org-funded booking shows its sponsor and no amount.
          organizationId: true,
          legs: { select: { source: true } },
          // #775 — a CHARGE_MEMBER overage side-charge is the one co-pay a
          // sponsored member pays themselves; it hangs off the booking
          // payment with no appointmentId of its own.
          childPayments: {
            where: { deletedAt: null },
            select: paymentDisplaySelect,
          },
        },
      },
      organization: { select: { id: true, name: true } },
      // #1163 — the live proposal, so the detail page can render it and offer
      // accept / decline / withdraw instead of "Awaiting schedule confirmation".
      rescheduleRequests: {
        where: { status: { in: ["PENDING_REVIEW", "COUNTERED"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          status: true,
          reason: true,
          round: true,
          expiresAt: true,
          initiatorRole: true,
          initiatedById: true,
          proposedTimes: {
            orderBy: { startsAt: "asc" },
            // round: a COUNTERED request carries both rounds; the card must
            // show only the current offer.
            select: { startsAt: true, endsAt: true, round: true },
          },
        },
      },
      occurrences: slotsInclude,
      // #1675 / #1760 — the EXPIRED edge tells a lapsed pay link apart from
      // a request nobody answered (lib/dashboard/money-state.ts).
      statusHistory: {
        where: { toStatus: "EXPIRED" },
        select: { fromStatus: true, toStatus: true },
      },
      // #1554 — the roster: every live seat holder, with display fields.
      participants: {
        where: liveParticipant(),
        select: { userId: true, role: true, user: userSelect },
      },
    },
  });

  if (!appointment) return null;

  // #1554 — the whole programme is this one wrapper's occurrences; there are
  // no sibling appointments to fetch.
  return toPlain({ appointment });
}

export type TAppointmentDetail = NonNullable<
  Awaited<ReturnType<typeof readAppointmentDetail>>
>;

/** Every party to the appointment: the requesting consultee (or trial consultee,
 *  or a slot participant), the plan's consultant, and ACCEPTED collaborators.
 *  Capability-based — participation, not UserRole (#org-appts). Platform
 *  ADMIN/STAFF are handled by the caller via isPrivileged. */
/**
 * #705 — which side of the session this user is on, or null if neither.
 *
 * PROVIDER wins a tie. A consultant who is also somehow on the attendee list
 * must not be counted as an attendee: their CSAT would then feed the org
 * quality average, which is a rating of THEIR OWN work.
 */
export function appointmentRaterRole(
  userId: string,
  detail: TAppointmentDetail,
): AppointmentFeedbackRole | null {
  const { consulteeUserIds, consultantUserIds } = participantUserIds(detail);
  if (consultantUserIds.includes(userId)) return "PROVIDER";
  if (consulteeUserIds.includes(userId)) return "CONSULTEE";
  return null;
}

/** #1527 — which side(s) of this appointment a user is on (`/dashboard/go/auto`). */
export function appointmentViewerSides(
  userId: string,
  detail: TAppointmentDetail,
): { asConsultant: boolean; asConsultee: boolean } {
  const { consulteeUserIds, consultantUserIds } = participantUserIds(detail);
  return {
    asConsultant: consultantUserIds.includes(userId),
    asConsultee: consulteeUserIds.includes(userId),
  };
}

export function canAccessAppointment(
  userId: string,
  detail: TAppointmentDetail,
): boolean {
  const { consulteeUserIds, consultantUserIds } = participantUserIds(detail);
  return [...consulteeUserIds, ...consultantUserIds].includes(userId);
}

/**
 * What a given viewer may see of the money. A webinar's ten attendees each
 * have a Payment on the same appointment, and the read above returns all of
 * them; an attendee must get only their own. The host (plan consultant or
 * accepted collaborator) and platform staff see every seat.
 *
 * Only group kinds are scoped. A 1:1 booking has one payment that belongs to
 * the booking whoever made it — a sponsoring organisation's admin, say — and
 * the attending consultee must still see it (the 2026-09-12 QA pass found a
 * sponsored consultation rendering no payment at all). An org-paid seat on a
 * group event stays attributed to its payer until the AppointmentParticipant
 * reader flip (#1319 A9), which carries the seat→payment edge.
 */
export function scopeAppointmentDetail<T extends TAppointmentDetail>(
  detail: T,
  viewerUserId: string,
  privileged = false,
): T {
  const { webinarId, classId, payment } = detail.appointment;
  const isGroup = !!webinarId || !!classId;
  const everySeat =
    !isGroup ||
    privileged ||
    appointmentRaterRole(viewerUserId, detail) === "PROVIDER";
  const rows = everySeat
    ? payment
    : payment.filter((p) => p.userId === viewerUserId);
  return {
    ...detail,
    appointment: {
      ...detail.appointment,
      // A receipt is the buyer's document. The host may read a seat's status
      // and amount; staff may fetch the invoice for a support case; nobody
      // else carries a pointer to a document they cannot open.
      payment: rows.map((p) =>
        privileged || p.userId === viewerUserId ? p : withoutReceipt(p),
      ),
    },
  };
}

type PaymentDisplayRow = TAppointmentDetail["appointment"]["payment"][number];

function withoutReceipt(p: PaymentDisplayRow): PaymentDisplayRow {
  return {
    ...p,
    receiptUrl: null,
    consumerInvoice: null,
    childPayments: p.childPayments.map((c) => ({
      ...c,
      receiptUrl: null,
      consumerInvoice: null,
    })),
  };
}

function participantUserIds(detail: TAppointmentDetail) {
  const { appointment } = detail;
  const consulteeUserIds = [
    appointment.consultation?.requestedBy?.userId,
    appointment.subscription?.requestedBy?.userId,
    appointment.trial?.consulteeProfile?.userId,
    ...appointment.participants.map((seat) => seat.userId),
  ];
  const consultantUserIds = [
    appointment.consultation?.consultationPlan?.consultantProfile?.userId,
    appointment.subscription?.subscriptionPlan?.consultantProfile?.userId,
    appointment.webinar?.webinarPlan?.consultantProfile?.userId,
    appointment.class?.classPlan?.consultantProfile?.userId,
    appointment.trial?.subscriptionPlan?.consultantProfile?.userId,
    ...(appointment.webinar?.webinarPlan?.collaborators ?? []).map(
      (c) => c.consultantProfile?.userId,
    ),
    ...(appointment.class?.classPlan?.collaborators ?? []).map(
      (c) => c.consultantProfile?.userId,
    ),
  ];
  return { consulteeUserIds, consultantUserIds };
}
export type TDetailAppointment = TAppointmentDetail["appointment"];
export type TDetailRecording =
  TDetailAppointment["occurrences"][number] extends {
    meeting: infer M;
  }
    ? M extends { recordings: Array<infer R> } | null
      ? R
      : never
    : never;

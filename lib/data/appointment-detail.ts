/**
 * Shared read for the single-appointment detail hub (consultant + consultee
 * /appointments/[appointmentId] pages). Both the API route
 * (GET /api/appointments/[appointmentId]) and the RSC prefetch call this so
 * SSR hydration and the client useQuery resolve identical payloads.
 *
 * Includes everything the detail page renders: the polymorphic event with
 * plan + people, ordered slots with their meeting sessions,
 * payment, sponsoring org — plus sibling appointments of the same
 * subscription/class so the timeline shows the whole program. userId fields
 * on the profile selects exist for the API route's ownership check.
 */

import { moveHasLapsed } from "@/lib/appointments/lapsed-move";
import prisma from "@/lib/prisma";
import {
  liveParticipant,
  NOT_COLLABORATOR_ROW,
} from "@/lib/booking/participants";
import { liveReminderPayment } from "@/lib/booking/payment-reminder-eligibility";
import { RESCHEDULE_OPEN_STATUSES } from "@/lib/booking/transitions";
import type {
  AppointmentFeedbackRole,
  BookingHistoryEntity,
  RefundStatus,
} from "@prisma/client";
import { toPlain } from "@/lib/data/serialize";
import {
  bookingAnomalies,
  scheduleAnomalyReport,
} from "@/lib/appointments/report-anomalies";

// `timezone` lets the detail page show the other party's wall clock for the
// next session; it names a zone, never a location.
const userSelect = {
  select: { id: true, name: true, image: true, timezone: true },
} as const;

const slotsInclude = {
  orderBy: { startsAt: "asc" },
  include: {
    meeting: {
      select: {
        id: true,
        endedAt: true,
        endedReason: true,
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

// The 1:1 payer's email feeds the Remind gate only; it is dropped before the payload is built.
const consultationPayerSelect = {
  select: {
    id: true,
    userId: true,
    user: { select: { ...userSelect.select, email: true } },
  },
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
      reason: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  disputes: { select: { status: true } },
} as const;

const collaboratorsInclude = {
  where: { status: "ACCEPTED" as const },
  select: {
    role: true,
    tier: true,
    consultantProfile: consultantProfileSelect,
  },
} as const;

const LIFECYCLE_HISTORY_ENTITIES: BookingHistoryEntity[] = [
  "CONSULTATION",
  "SUBSCRIPTION",
  "TRIAL",
  "WEBINAR",
  "CLASS",
];

/** Which side wrote a history edge; a staff or system actor's id never leaves the server. */
export type HistoryActorSide = "CONSULTANT" | "REQUESTER" | "OTHER" | null;

function historyActorSide(
  actorUserId: string | null,
  sides: { requester: string | null; hosts: (string | undefined)[] },
): HistoryActorSide {
  if (!actorUserId) return null;
  if (actorUserId === sides.requester) return "REQUESTER";
  if (sides.hosts.includes(actorUserId)) return "CONSULTANT";
  return "OTHER";
}

function withoutEmail<U extends { email: string | null }>({
  email: _email,
  ...user
}: U): Omit<U, "email"> {
  return user;
}

/**
 * Every booking page, its API and the authz helper read through here: a move
 * past its deadline is ended first, so the original session is what they see.
 */
export async function readAppointmentDetail(appointmentId: string) {
  const detail = await loadAppointmentDetail(appointmentId);
  const open = detail?.appointment.rescheduleRequests?.[0];
  if (!open || !moveHasLapsed(open.expiresAt)) return detail;
  // Loaded on use: settling takes the booking locks, which plain reads never need.
  const { settleLapsedProposal } =
    await import("@/lib/booking/reschedule-lapse");
  return (await settleLapsedProposal(appointmentId))
    ? loadAppointmentDetail(appointmentId)
    : detail;
}

async function loadAppointmentDetail(appointmentId: string) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      consultation: {
        include: {
          consultationPlan: {
            include: { consultantProfile: consultantProfileSelect },
          },
          requestedBy: consultationPayerSelect,
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
          // The trial's delivering expert, who answers its reschedules.
          consultantProfile: consultantProfileSelect,
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
          deletedAt: true,
          // Which rail funded the row (lib/appointments/payment-display.ts):
          // an org-funded booking shows its sponsor and no amount.
          organizationId: true,
          legs: { select: { source: true, amountPaise: true } },
          // #775 — a CHARGE_MEMBER overage side-charge is the one co-pay a
          // sponsored member pays themselves; it hangs off the booking
          // payment with no appointmentId of its own.
          childPayments: {
            where: { deletedAt: null },
            select: {
              ...paymentDisplaySelect,
              legs: { select: { source: true } },
            },
          },
        },
      },
      organization: { select: { id: true, name: true } },
      // #1163 — the live proposal, so the detail page can render it and offer
      // accept / decline / withdraw instead of "Awaiting schedule confirmation".
      rescheduleRequests: {
        where: { status: { in: RESCHEDULE_OPEN_STATUSES } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          status: true,
          reason: true,
          expiresAt: true,
          initiatorRole: true,
          initiatedById: true,
          proposedTimes: {
            orderBy: { startsAt: "asc" },
            select: { startsAt: true, endsAt: true },
          },
        },
      },
      occurrences: slotsInclude,
      // The booking's own lifecycle edges: who approved, declined, withdrew or
      // cancelled it, and when. The actor id is folded into a side below.
      statusHistory: {
        where: { entity: { in: LIFECYCLE_HISTORY_ENTITIES } },
        orderBy: { createdAt: "asc" },
        select: {
          fromStatus: true,
          toStatus: true,
          reason: true,
          actorUserId: true,
          createdAt: true,
        },
      },
      // #1554 — the roster: every live seat holder, with display fields.
      participants: {
        where: { ...liveParticipant(), ...NOT_COLLABORATOR_ROW },
        select: { userId: true, role: true, status: true, user: userSelect },
      },
    },
    // ~28 relation nodes: one joined statement instead of one per node.
    relationLoadStrategy: "join",
  });

  if (!appointment) return null;

  // #1554 — the whole programme is this one wrapper's occurrences; there are
  // no sibling appointments to fetch.
  const sides = {
    requester:
      appointment.consultation?.requestedBy.userId ??
      appointment.subscription?.requestedBy.userId ??
      appointment.trial?.consulteeProfile.userId ??
      null,
    hosts: [
      appointment.consultation?.consultationPlan.consultantProfile.userId,
      appointment.subscription?.subscriptionPlan.consultantProfile.userId,
      appointment.trial?.subscriptionPlan.consultantProfile.userId,
      appointment.webinar?.webinarPlan.consultantProfile?.userId,
      appointment.class?.classPlan.consultantProfile?.userId,
    ],
  };
  const { consultation } = appointment;
  // The inbox's Remind rule on live rows: the open order's expiry ships, the email never does.
  const reminder =
    consultation && !appointment.deletedAt
      ? liveReminderPayment(
          {
            ...consultation,
            appointment: {
              payment: appointment.payment.filter((p) => !p.deletedAt),
            },
          },
          new Date(),
        )
      : null;
  const detail = toPlain({
    reminderExpiresAt: reminder?.expiresAt.toISOString() ?? null,
    appointment: {
      ...appointment,
      consultation: consultation && {
        ...consultation,
        requestedBy: {
          ...consultation.requestedBy,
          user: withoutEmail(consultation.requestedBy.user),
        },
      },
      statusHistory: appointment.statusHistory.map(
        ({ actorUserId, ...edge }) => ({
          ...edge,
          by: historyActorSide(actorUserId, sides),
        }),
      ),
    },
  });
  // The read carries the live proposal, so a lost session can be judged here.
  scheduleAnomalyReport(
    bookingAnomalies([detail.appointment], {
      openRescheduleIds: new Set(
        detail.appointment.rescheduleRequests.length > 0
          ? [detail.appointment.id]
          : [],
      ),
    }),
    "appointment-detail",
  );
  return detail;
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

/** The plan's own expert of this booking. */
function isPlanExpert(userId: string, detail: TAppointmentDetail): boolean {
  const { appointment } = detail;
  return [
    appointment.consultation?.consultationPlan?.consultantProfile?.userId,
    appointment.subscription?.subscriptionPlan?.consultantProfile?.userId,
    appointment.webinar?.webinarPlan?.consultantProfile?.userId,
    appointment.class?.classPlan?.consultantProfile?.userId,
    appointment.trial?.subscriptionPlan?.consultantProfile?.userId,
  ].includes(userId);
}

/** An accepted presenter on the webinar or class plan. */
function isPresenter(userId: string, detail: TAppointmentDetail): boolean {
  const { appointment } = detail;
  return [
    ...(appointment.webinar?.webinarPlan?.collaborators ?? []),
    ...(appointment.class?.classPlan?.collaborators ?? []),
  ].some(
    (c) => c.tier === "PRESENTER" && c.consultantProfile?.userId === userId,
  );
}

/**
 * What a given viewer may see of a booking's seats and money. A webinar's ten
 * attendees each have a Payment on the same appointment, and the read above
 * returns all of them. The plan's own expert and platform staff see every
 * seat and every payment; a presenter sees every seat and no attendee's
 * payment; crew and attendees see only their own rows.
 *
 * Only group kinds are scoped. A 1:1 booking has one payment that belongs to
 * the booking whoever made it (a sponsoring organisation's admin, say), and
 * the attending consultee must still see it.
 */
export function scopeAppointmentDetail<T extends TAppointmentDetail>(
  detail: T,
  viewerUserId: string,
  privileged = false,
): T {
  const { webinarId, classId, payment, participants } = detail.appointment;
  const isGroup = !!webinarId || !!classId;
  const everyPayment =
    !isGroup || privileged || isPlanExpert(viewerUserId, detail);
  const everySeat = everyPayment || isPresenter(viewerUserId, detail);
  const rows = everyPayment
    ? payment
    : payment.filter((p) => p.userId === viewerUserId);
  const scopedParticipants = everySeat
    ? participants
    : participants.filter((p) => p.userId === viewerUserId);
  return {
    ...detail,
    appointment: {
      ...detail.appointment,
      participants: scopedParticipants,
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

import "server-only";

import type { AppointmentStatus, Prisma, TrialStatus } from "@prisma/client";

import { KNOWN_HISTORY_ENTITIES } from "@/lib/booking/history-entities";
import { subscriptionPlanEnd } from "@/lib/booking/entitlement";
import type { PrismaLike } from "@/lib/prisma";
import { documentDates, type DocumentDates } from "./document-dates";

/**
 * The one answer to "who is this caller on this booking's documents": the
 * learner, the expert, or nobody. Every document route, the viewer page and the
 * workspace page resolve through it, inside a transaction on `tx` when they write.
 */

export type DocumentPartyRole = "learner" | "expert";

export type DocumentBookingKind = "CONSULTATION" | "SUBSCRIPTION" | "TRIAL";

interface PartyPerson {
  userId: string;
  profileId: string;
  name: string;
}

export interface DocumentBooking extends DocumentDates {
  id: string;
  kind: DocumentBookingKind;
  title: string;
  organizationId: string | null;
  organizationName: string | null;
  terminal: boolean;
  terminalAt: Date | null;
  /** Paid and accepted: uploads open only from here. */
  confirmed: boolean;
  learner: PartyPerson;
  expert: PartyPerson;
}

export interface DocumentParty {
  role: DocumentPartyRole;
  userId: string;
  booking: DocumentBooking;
}

const TERMINAL_REQUEST_STATUSES: readonly AppointmentStatus[] = [
  "CANCELLED",
  "REJECTED",
  "EXPIRED",
];
const CONFIRMED_REQUEST_STATUSES: readonly AppointmentStatus[] = [
  "APPROVED",
  "COMPLETED",
];
const TERMINAL_TRIAL_STATUSES: readonly TrialStatus[] = ["CANCELLED"];
const CONFIRMED_TRIAL_STATUSES: readonly TrialStatus[] = [
  "SCHEDULED",
  "COMPLETED",
  "CONVERTED",
];

const personSelect = {
  select: { id: true, userId: true, user: { select: { name: true } } },
} as const;

/** Live sessions: not deleted, cancelled or rescheduled away. */
export const liveDocumentSessionWhere = {
  deletedAt: null,
  completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
} satisfies Prisma.AppointmentOccurrenceWhereInput;

export const documentBookingSelect = {
  id: true,
  organizationId: true,
  organization: { select: { name: true } },
  consultation: {
    select: {
      status: true,
      cancelledAt: true,
      updatedAt: true,
      requestedBy: personSelect,
      consultationPlan: {
        select: { title: true, consultantProfile: personSelect },
      },
    },
  },
  subscription: {
    select: {
      status: true,
      cancelledAt: true,
      updatedAt: true,
      planEndsAt: true,
      schedulingPeriodStartsAt: true,
      schedulingTimezone: true,
      requestedBy: personSelect,
      subscriptionPlan: {
        select: {
          title: true,
          durationInMonths: true,
          consultantProfile: personSelect,
        },
      },
    },
  },
  trial: {
    select: {
      status: true,
      updatedAt: true,
      consulteeProfile: personSelect,
      consultantProfile: personSelect,
      subscriptionPlan: { select: { title: true } },
    },
  },
  occurrences: {
    where: liveDocumentSessionWhere,
    select: { startsAt: true, endsAt: true },
  },
  statusHistory: {
    where: {
      entity: { in: [...KNOWN_HISTORY_ENTITIES] },
      toStatus: { in: [...TERMINAL_REQUEST_STATUSES] },
    },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { createdAt: true },
  },
} satisfies Prisma.AppointmentSelect;

export type DocumentBookingRow = Prisma.AppointmentGetPayload<{
  select: typeof documentBookingSelect;
}>;

function person(
  profile: { id: string; userId: string; user: { name: string } } | null,
): PartyPerson | null {
  return profile
    ? { userId: profile.userId, profileId: profile.id, name: profile.user.name }
    : null;
}

/** Booking facts for a document-capable appointment, or null for webinars and classes. */
export function toDocumentBooking(
  row: DocumentBookingRow,
  now: Date = new Date(),
): DocumentBooking | null {
  const terminalHistoryAt = row.statusHistory[0]?.createdAt ?? null;
  let core: Omit<
    DocumentBooking,
    keyof DocumentDates | "id" | "organizationId" | "organizationName"
  > & { activeUntil: Date | null };

  if (row.consultation) {
    const c = row.consultation;
    const learner = person(c.requestedBy);
    const expert = person(c.consultationPlan.consultantProfile);
    if (!learner || !expert) return null;
    const terminal = TERMINAL_REQUEST_STATUSES.includes(c.status);
    core = {
      kind: "CONSULTATION",
      title: c.consultationPlan.title,
      terminal,
      terminalAt: terminal
        ? (c.cancelledAt ?? terminalHistoryAt ?? c.updatedAt)
        : null,
      confirmed: CONFIRMED_REQUEST_STATUSES.includes(c.status),
      learner,
      expert,
      activeUntil: null,
    };
  } else if (row.subscription) {
    const s = row.subscription;
    const learner = person(s.requestedBy);
    const expert = person(s.subscriptionPlan.consultantProfile);
    if (!learner || !expert) return null;
    const terminal = TERMINAL_REQUEST_STATUSES.includes(s.status);
    core = {
      kind: "SUBSCRIPTION",
      title: s.subscriptionPlan.title,
      terminal,
      terminalAt: terminal
        ? (s.cancelledAt ?? terminalHistoryAt ?? s.updatedAt)
        : null,
      confirmed: CONFIRMED_REQUEST_STATUSES.includes(s.status),
      learner,
      expert,
      activeUntil: subscriptionPlanEnd(s),
    };
  } else if (row.trial) {
    const t = row.trial;
    const learner = person(t.consulteeProfile);
    const expert = person(t.consultantProfile);
    if (!learner || !expert) return null;
    const terminal = TERMINAL_TRIAL_STATUSES.includes(t.status);
    core = {
      kind: "TRIAL",
      title: t.subscriptionPlan.title,
      terminal,
      terminalAt: terminal ? (terminalHistoryAt ?? t.updatedAt) : null,
      confirmed: CONFIRMED_TRIAL_STATUSES.includes(t.status),
      learner,
      expert,
      activeUntil: null,
    };
  } else {
    return null;
  }

  const { activeUntil, ...facts } = core;
  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationName: row.organization?.name ?? null,
    ...facts,
    ...documentDates(
      {
        terminal: facts.terminal,
        terminalAt: facts.terminalAt,
        liveSessionEnds: row.occurrences.map((o) => o.endsAt),
        activeUntil,
      },
      now,
    ),
  };
}

/** Appointments on which `userId` is the learner or the expert of a document-capable booking. */
export function documentPartyWhere(
  userId: string,
): Prisma.AppointmentWhereInput {
  const ownsProfile = { userId };
  return {
    deletedAt: null,
    OR: [
      { consultation: { requestedBy: ownsProfile } },
      {
        consultation: { consultationPlan: { consultantProfile: ownsProfile } },
      },
      { subscription: { requestedBy: ownsProfile } },
      {
        subscription: { subscriptionPlan: { consultantProfile: ownsProfile } },
      },
      { trial: { consulteeProfile: ownsProfile } },
      { trial: { consultantProfile: ownsProfile } },
    ],
  };
}

export function partyRoleOf(
  booking: Pick<DocumentBooking, "learner" | "expert">,
  userId: string,
): DocumentPartyRole | null {
  if (booking.expert.userId === userId) return "expert";
  if (booking.learner.userId === userId) return "learner";
  return null;
}

type PartyDb = Pick<PrismaLike, "appointment">;

export async function resolveDocumentParty(
  db: PartyDb,
  appointmentId: string,
  userId: string,
  now: Date = new Date(),
): Promise<DocumentParty | null> {
  const row = await db.appointment.findFirst({
    where: { id: appointmentId, ...documentPartyWhere(userId) },
    select: documentBookingSelect,
  });
  if (!row) return null;
  const booking = toDocumentBooking(row, now);
  if (!booking) return null;
  const role = partyRoleOf(booking, userId);
  return role ? { role, userId, booking } : null;
}

export type DocumentWriteRefusal =
  "APPOINTMENT_TERMINAL" | "BOOKING_NOT_CONFIRMED" | "UPLOAD_WINDOW_CLOSED";

/** Why the booking refuses new uploads, reviews and replies, or null when it accepts them. */
export function documentWriteRefusal(
  booking: Pick<DocumentBooking, "terminal" | "confirmed" | "uploadWindowOpen">,
): DocumentWriteRefusal | null {
  if (booking.terminal) return "APPOINTMENT_TERMINAL";
  if (!booking.confirmed) return "BOOKING_NOT_CONFIRMED";
  if (!booking.uploadWindowOpen) return "UPLOAD_WINDOW_CLOSED";
  return null;
}

import { CONDUCT_REMOVAL_CATEGORY } from "./case-topic";
import type { SupportCaseStatus } from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { findUserIssues } from "@/lib/observability/sentry-issues";
import type {
  CaseBooking,
  CaseBookingFacts,
  StaffCasePayment,
  CaseWorkspace,
} from "@/types/support-case";
import { listStatusFacts } from "@/lib/appointments/list-status-facts";
import type { OpenRescheduleProposal } from "@/lib/appointments/consultee-affordances";
import { toDate } from "@/lib/appointments/view-model";
import { RESCHEDULE_OPEN_STATUSES } from "@/lib/booking/transitions";
import { withLapsedMoveRestored } from "@/lib/appointments/lapsed-move";
import { caseKeyOf, type CaseRef } from "./case-key";
import { isPresenterAuthoredMessage } from "./case-message-actor";
import { PLAN_TITLE_SELECT, planTitle } from "./case-read";
import { ticketTopic } from "./case-topic";
import { effectiveResolutionDueAt, slaStateOf } from "./sla";
import { readableCaseEvent } from "./case-event-copy";
import { fundingRailForIntent } from "@/lib/payments/funding-rail";
export const TIMELINE_LIMIT = 200;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const BOOKING_SELECT = {
  id: true,
  ...PLAN_TITLE_SELECT,
  consultation: {
    select: {
      status: true,
      bookingSource: true,
      requestedBy: { select: { user: { select: { name: true } } } },
      consultationPlan: {
        select: {
          title: true,
          consultantProfile: { select: { user: { select: { name: true } } } },
        },
      },
    },
  },
  subscription: {
    select: {
      status: true,
      bookingSource: true,
      requestedBy: { select: { user: { select: { name: true } } } },
      subscriptionPlan: {
        select: {
          title: true,
          consultantProfile: { select: { user: { select: { name: true } } } },
        },
      },
    },
  },
  trial: {
    select: {
      status: true,
      consulteeProfile: { select: { user: { select: { name: true } } } },
      subscriptionPlan: {
        select: {
          title: true,
          consultantProfile: { select: { user: { select: { name: true } } } },
        },
      },
    },
  },
  webinar: {
    select: {
      status: true,
      webinarPlan: {
        select: {
          title: true,
          consultantProfile: { select: { user: { select: { name: true } } } },
        },
      },
    },
  },
  class: {
    select: {
      status: true,
      classPlan: {
        select: {
          title: true,
          consultantProfile: { select: { user: { select: { name: true } } } },
        },
      },
    },
  },
  occurrences: {
    orderBy: { startsAt: "asc" },
    // The release flags let a lapsed move read as the original.
    select: {
      startsAt: true,
      isTentative: true,
      completionStatus: true,
      deletedAt: true,
    },
  },
} as const;

/**
 * `requesterName` fills the learner for a class or webinar: those hold no
 * per-seat requester, and the case's requester is the attendee (#1527).
 */
export async function readCaseBooking(
  appointmentId: string,
  requester: { id: string; name: string | null },
  grants: { showPayment: boolean } = { showPayment: true },
): Promise<CaseBooking | null> {
  const requesterName = requester.name;
  const stored = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      ...BOOKING_SELECT,
      // The requester's own seat: a removed or departed attendee's booking is not the event's.
      participants: {
        where: { userId: requester.id, role: "CONSULTEE" },
        select: { status: true },
        take: 1,
      },
      // The requester's own payment on a class or webinar; any payment on a 1:1.
      payment: {
        where: {
          deletedAt: null,
          OR: [
            { userId: requester.id },
            { appointment: { webinarId: null, classId: null } },
          ],
        },
        select: {
          paymentStatus: true,
          expiresAt: true,
          amount: true,
          currency: true,
          // Landed refunds only, as the lists read them.
          refunds: {
            where: { status: "SUCCEEDED", deletedAt: null },
            select: { amountPaise: true, updatedAt: true },
          },
        },
      },
      rescheduleRequests: {
        where: { status: { in: RESCHEDULE_OPEN_STATUSES } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          status: true,
          reason: true,
          expiresAt: true,
          originStatus: true,
          initiatorRole: true,
          initiatedById: true,
          proposedTimes: {
            orderBy: { startsAt: "asc" },
            take: 1,
            select: { startsAt: true, endsAt: true },
          },
        },
      },
    },
  });
  if (!stored) return null;
  // A lapsed open move reads as the original, as the lists restore it.
  const a = withLapsedMoveRestored(stored);
  const expert =
    a.consultation?.consultationPlan.consultantProfile?.user?.name ??
    a.subscription?.subscriptionPlan.consultantProfile?.user?.name ??
    a.trial?.subscriptionPlan.consultantProfile?.user?.name ??
    a.webinar?.webinarPlan.consultantProfile?.user?.name ??
    a.class?.classPlan.consultantProfile?.user?.name ??
    null;
  const learner =
    a.consultation?.requestedBy.user?.name ??
    a.subscription?.requestedBy.user?.name ??
    a.trial?.consulteeProfile.user?.name ??
    (a.class || a.webinar ? requesterName : null);
  return {
    appointmentId: a.id,
    kind: a.appointmentType,
    title: planTitle(a),
    expertName: expert,
    learnerName: learner,
    firstStartsAt: iso(a.occurrences[0]?.startsAt),
    lastStartsAt: iso(a.occurrences.at(-1)?.startsAt),
    status:
      a.consultation?.status ??
      a.subscription?.status ??
      a.trial?.status ??
      a.class?.status ??
      a.webinar?.status ??
      null,
    seatStatus: a.participants[0]?.status ?? null,
    facts: caseStatusFacts(a, grants.showPayment),
  };
}

/** The list-status facts the other screens read, serialised for the drawer. */
function caseStatusFacts(
  a: {
    id: string;
    consultation: { bookingSource: string } | null;
    subscription: { bookingSource: string } | null;
    payment: {
      paymentStatus: string;
      expiresAt: Date | null;
      amount: number;
      currency: string;
      refunds: { amountPaise: number; updatedAt: Date }[];
    }[];
    rescheduleRequests: OpenRescheduleProposal[];
  },
  showPayment: boolean,
): CaseBookingFacts {
  const facts = listStatusFacts(a, []);
  const r = facts.reschedule;
  return {
    source:
      a.consultation?.bookingSource ?? a.subscription?.bookingSource ?? null,
    // Payment state is payments.read only; without it the status derives from the rest.
    ...(showPayment
      ? {
          paid: !!facts.paid,
          payDeadline: facts.payDeadline
            ? iso(toDate(facts.payDeadline))
            : null,
          payLapsed: !!facts.payLapsed,
          refunded: facts.refunded
            ? {
                paise: facts.refunded.paise,
                currency: facts.refunded.currency,
                at: facts.refunded.at ? iso(toDate(facts.refunded.at)) : null,
              }
            : null,
        }
      : {}),
    reschedule: r
      ? {
          by: r.by,
          proposedStartsAt: r.proposedStartsAt
            ? iso(toDate(r.proposedStartsAt))
            : null,
          originalStartsAt: null,
          expiresAt: r.expiresAt ? iso(toDate(r.expiresAt)) : null,
        }
      : null,
  };
}

export async function readPayment(
  paymentId: string | null,
): Promise<StaffCasePayment | null> {
  if (!paymentId) return null;
  const p = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      amount: true,
      currency: true,
      paymentStatus: true,
      createdAt: true,
      paymentIntent: true,
    },
  });
  return p
    ? {
        id: p.id,
        amount: Number(p.amount),
        currency: p.currency,
        status: p.paymentStatus,
        createdAt: p.createdAt.toISOString(),
        rail: fundingRailForIntent(p.paymentIntent),
      }
    : null;
}

/** A removal case's decision deadline, shown only while the case is open and undecided. */
export function removalReviewDueAt(c: {
  category: string | null;
  status: SupportCaseStatus;
  closedAt: Date | null;
  statutoryDueAt: Date | null;
  decisions: { id: string }[];
}): string | null {
  if (c.category !== CONDUCT_REMOVAL_CATEGORY) return null;
  if (c.status === "CLOSED" || c.closedAt || c.decisions.length > 0) {
    return null;
  }
  return iso(c.statutoryDueAt);
}

export interface WorkspaceGrants {
  showContact: boolean;
  showPayment: boolean;
}

export async function readCaseWorkspace(
  ref: CaseRef,
  grants: WorkspaceGrants,
): Promise<CaseWorkspace | null> {
  if (ref.kind !== "case") return null;
  const caseId = ref.id;
  const c = await prisma.supportCase.findFirst({
    where: { id: caseId, deletedAt: null },
    include: {
      requester: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          createdAt: true,
        },
      },
      assignedTo: { select: { id: true, name: true } },
      organization: { select: { id: true, name: true } },
      subjects: true,
      messages: {
        orderBy: { seq: "asc" },
        take: -(TIMELINE_LIMIT + 1),
        include: { authorUser: { select: { name: true } } },
      },
      events: {
        orderBy: { createdAt: "desc" },
        take: 100,
        include: { actor: { select: { name: true } } },
      },
      decisions: { select: { id: true }, take: 1 },
    },
  });
  if (!c) return null;
  const paymentId =
    c.subjects.find((s) => s.subjectType === "PAYMENT")?.subjectId ?? null;
  const [booking, payment, pastCases, sentryIssues, duplicates] =
    await Promise.all([
      c.appointmentId
        ? readCaseBooking(
            c.appointmentId,
            { id: c.requesterUserId, name: c.requester.name },
            { showPayment: grants.showPayment },
          )
        : null,
      grants.showPayment ? readPayment(paymentId) : null,
      prisma.supportCase.findMany({
        where: {
          requesterUserId: c.requesterUserId,
          id: { not: c.id },
          deletedAt: null,
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, title: true, status: true, createdAt: true },
      }),
      findUserIssues({ userId: c.requesterUserId, limit: 5 }),
      c.appointmentId || paymentId
        ? prisma.supportCase.findMany({
            where: {
              deletedAt: null,
              id: { not: c.id },
              requesterUserId: c.requesterUserId,
              status: { notIn: ["RESOLVED", "CLOSED"] },
              OR: [
                ...(c.appointmentId
                  ? [{ appointmentId: c.appointmentId }]
                  : []),
                ...(paymentId
                  ? [
                      {
                        subjects: {
                          some: {
                            subjectType: "PAYMENT" as const,
                            subjectId: paymentId,
                          },
                        },
                      },
                    ]
                  : []),
              ],
            },
            take: 5,
            select: {
              id: true,
              referenceNumber: true,
              title: true,
              status: true,
            },
          })
        : [],
    ]);
  const messages = c.messages.slice(-TIMELINE_LIMIT);
  // An anonymous complainant's case is held by a system user with no phone.
  const accountPhone = c.externalRequesterEmail ? null : c.requester.phone;
  const requesterPhone = c.callbackPhone ?? accountPhone;
  return {
    key: caseKeyOf({ kind: "case", id: c.id }),
    kind: "case",
    caseId: c.id,
    subject: c.title,
    reference: c.referenceNumber,
    topic: ticketTopic(c),
    status: c.status,
    priority: c.priority,
    channel: c.activeChannel,
    effectiveResolutionDueAt: iso(effectiveResolutionDueAt(c)),
    assignee: c.assignedTo,
    sla: slaStateOf(c),
    ackDueAt: iso(c.ackDueAt),
    resolutionDueAt: iso(c.resolutionDueAt),
    reviewDueAt: removalReviewDueAt(c),
    lastMessageAt: iso(c.lastMessageAt),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    handoffSummary: c.description || null,
    duplicateOpenCases: duplicates.map((d) => ({
      id: d.id,
      reference: d.referenceNumber,
      title: d.title,
      status: d.status,
    })),
    events: c.events.reverse().map((e) => ({
      id: e.id,
      kind: e.kind,
      ...readableCaseEvent(e),
      note: e.note,
      actorName: e.actor?.name ?? null,
      createdAt: e.createdAt.toISOString(),
    })),
    botPromises: [
      ...new Set(
        c.messages.flatMap((message) => {
          if (message.sender !== "BOT" && message.sender !== "SYSTEM")
            return [];
          const parsed = z
            .object({ promises: z.array(z.string()) })
            .safeParse(message.metadata);
          return parsed.success ? parsed.data.promises : [];
        }),
      ),
    ],
    person: {
      id: c.requester.id,
      name: c.externalRequesterName ?? c.requester.name,
      role: c.requester.role,
      email: grants.showContact
        ? (c.externalRequesterEmail ?? c.requester.email)
        : null,
      phone: grants.showContact ? requesterPhone : null,
      callbackRequested: Boolean(c.callbackPhone),
      joinedAt: c.requester.createdAt.toISOString(),
    },
    booking,
    payment,
    organization: c.organization,
    pastCases: pastCases.map((p) => ({
      key: caseKeyOf({ kind: "case", id: p.id }),
      subject: p.title,
      status: p.status,
      at: p.createdAt.toISOString(),
    })),
    sentryIssues,
    timeline: messages.map((m) => ({
      id: m.id,
      seq: m.seq,
      author: m.sender,
      authorName: m.authorUser?.name ?? null,
      body: m.body,
      internal: m.isInternal,
      actorKind: isPresenterAuthoredMessage(m.metadata)
        ? ("PRESENTER" as const)
        : undefined,
      at: m.createdAt.toISOString(),
    })),
    hasMore: c.messages.length > TIMELINE_LIMIT,
    nextBeforeSeq: messages[0]?.seq ?? null,
    attachments: [],
  };
}

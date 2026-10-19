import { z } from "zod";
import prisma from "@/lib/prisma";
import { findUserIssues } from "@/lib/observability/sentry-issues";
import type {
  CaseBooking,
  CasePayment,
  CaseWorkspace,
} from "@/types/support-case";
import { caseKeyOf, type CaseRef } from "./case-key";
import { PLAN_TITLE_SELECT, planTitle } from "./case-read";
import { ticketTopic } from "./case-topic";
import { slaStateOf } from "./sla";
export const TIMELINE_LIMIT = 200;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const BOOKING_SELECT = {
  id: true,
  ...PLAN_TITLE_SELECT,
  consultation: {
    select: {
      status: true,
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
    select: { startsAt: true },
  },
} as const;

/**
 * `requesterName` fills the learner for a class or webinar: those hold no
 * per-seat requester, and the case's requester is the attendee (#1527).
 */
async function readBooking(
  appointmentId: string,
  requesterName: string | null,
): Promise<CaseBooking | null> {
  const a = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: BOOKING_SELECT,
  });
  if (!a) return null;
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
  };
}

export async function readPayment(
  paymentId: string | null,
): Promise<CasePayment | null> {
  if (!paymentId) return null;
  const p = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      amount: true,
      currency: true,
      paymentStatus: true,
      createdAt: true,
    },
  });
  return p
    ? {
        id: p.id,
        amount: Number(p.amount),
        currency: p.currency,
        status: p.paymentStatus,
        createdAt: p.createdAt.toISOString(),
      }
    : null;
}

export interface WorkspaceGrants {
  showEmail: boolean;
  showPayment: boolean;
}

/** Old links resolve through the import alias, never through a legacy table. */
export async function resolveSupportCaseId(
  ref: CaseRef,
): Promise<string | null> {
  if (ref.kind === "case") return ref.id;
  if (ref.kind === "booking") return null;
  const alias = await prisma.supportCaseLegacyAlias.findUnique({
    where: { legacyKind_legacyId: { legacyKind: ref.kind, legacyId: ref.id } },
    select: { caseId: true },
  });
  return alias?.caseId ?? null;
}

export async function readCaseWorkspace(
  ref: CaseRef,
  grants: WorkspaceGrants,
): Promise<CaseWorkspace | null> {
  const caseId = await resolveSupportCaseId(ref);
  if (!caseId) return null;
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
    },
  });
  if (!c) return null;
  const paymentId =
    c.subjects.find((s) => s.subjectType === "PAYMENT")?.subjectId ?? null;
  const [booking, payment, pastCases, sentryIssues, duplicates] =
    await Promise.all([
      c.appointmentId ? readBooking(c.appointmentId, c.requester.name) : null,
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
    assignee: c.assignedTo,
    sla: slaStateOf(c),
    ackDueAt: iso(c.ackDueAt),
    resolutionDueAt: iso(c.resolutionDueAt),
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
      fromValue: e.fromValue,
      toValue: e.toValue,
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
      email: grants.showEmail
        ? (c.externalRequesterEmail ?? c.requester.email)
        : null,
      phone:
        c.callbackPhone ??
        (c.externalRequesterEmail ? null : c.requester.phone),
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
      at: m.createdAt.toISOString(),
    })),
    hasMore: c.messages.length > TIMELINE_LIMIT,
    nextBeforeSeq: messages[0]?.seq ?? null,
    attachments: [],
  };
}

import prisma from "@/lib/prisma";
import type {
  CaseAuthor,
  CaseBooking,
  CasePayment,
  CaseWorkspace,
  TimelineItem,
} from "@/types/support-case";

import { caseKeyOf, type CaseRef } from "./case-key";
import { PLAN_TITLE_SELECT, SLA_SELECT, planTitle } from "./case-read";
import { threadTopic, ticketTopic } from "./case-topic";
import { MESSAGE_ORDER } from "./message-seq";
import { slaStateOf } from "./sla";

/**
 * #1527 — one support case's workspace, shaped for the back-office case page:
 * person, booking, payment and org context, past cases, and one timeline over
 * the thread's messages and the ticket's responses. Each source is bounded to
 * TIMELINE_LIMIT rows.
 */

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

const isOperator = (role: string | null | undefined) =>
  role === "STAFF" || role === "ADMIN";

type MessageRow = {
  id: string;
  sender: CaseAuthor;
  body: string;
  createdAt: Date;
  authorUser: { name: string | null } | null;
};

function messageItems(messages: MessageRow[]): TimelineItem[] {
  return messages.map((m) => ({
    id: m.id,
    author: m.sender,
    authorName: m.sender === "AGENT" ? (m.authorUser?.name ?? null) : null,
    body: m.body,
    internal: false,
    at: m.createdAt.toISOString(),
  }));
}

type ResponseRow = {
  id: string;
  message: string;
  isInternal: boolean;
  createdAt: Date;
  user: { name: string | null; role: string | null };
};

export function responseItems(responses: ResponseRow[]): TimelineItem[] {
  return responses.map((r) => ({
    id: r.id,
    author: isOperator(r.user.role) ? "AGENT" : "USER",
    authorName: r.user.name,
    body: r.message,
    internal: r.isInternal,
    at: r.createdAt.toISOString(),
  }));
}

export const byTime = (a: TimelineItem, b: TimelineItem) =>
  a.at.localeCompare(b.at);

const MESSAGE_SELECT = {
  orderBy: MESSAGE_ORDER,
  take: -TIMELINE_LIMIT,
  select: {
    id: true,
    sender: true,
    body: true,
    createdAt: true,
    authorUser: { select: { name: true } },
  },
} as const;

export const RESPONSE_SELECT = {
  select: {
    id: true,
    message: true,
    isInternal: true,
    createdAt: true,
    user: { select: { name: true, role: true } },
  },
} as const;

const PERSON_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  createdAt: true,
} as const;

async function readPastCases(userId: string, exceptKey: string) {
  const [tickets, threads] = await Promise.all([
    prisma.supportTicket.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { id: true, title: true, status: true, createdAt: true },
    }),
    prisma.appointmentSupportThread.findMany({
      where: { userId, supportTicketId: null },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        status: true,
        createdAt: true,
        appointment: { select: PLAN_TITLE_SELECT },
      },
    }),
  ]);
  return [
    ...tickets.map((t) => ({
      key: caseKeyOf({ kind: "ticket", id: t.id }),
      subject: t.title,
      status: t.status,
      at: t.createdAt.toISOString(),
    })),
    ...threads.map((t) => ({
      key: caseKeyOf({ kind: "thread", id: t.id }),
      subject: `Help with ${planTitle(t.appointment)}`,
      status: t.status,
      at: t.createdAt.toISOString(),
    })),
  ]
    .filter((c) => c.key !== exceptKey)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 5);
}

export interface WorkspaceGrants {
  showEmail: boolean;
  showPayment: boolean;
}

export async function readCaseWorkspace(
  ref: CaseRef,
  grants: WorkspaceGrants,
): Promise<CaseWorkspace | null> {
  if (ref.kind === "ticket") return readTicketWorkspace(ref.id, grants);
  if (ref.kind === "thread") return readThreadWorkspace(ref.id, grants);
  return null;
}

async function readTicketWorkspace(
  ticketId: string,
  grants: WorkspaceGrants,
): Promise<CaseWorkspace | null> {
  const t = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      referenceNumber: true,
      title: true,
      description: true,
      priority: true,
      category: true,
      issueType: true,
      createdAt: true,
      paymentId: true,
      consultationId: true,
      ...SLA_SELECT,
      user: { select: PERSON_SELECT },
      assignedTo: { select: { id: true, name: true } },
      organization: { select: { id: true, name: true } },
      attachments: {
        orderBy: { uploadedAt: "desc" },
        select: { id: true, originalName: true, fileUrl: true, fileSize: true },
      },
      responses: {
        orderBy: { createdAt: "desc" },
        take: TIMELINE_LIMIT,
        ...RESPONSE_SELECT,
      },
      appointmentSupportThread: {
        select: { id: true, appointmentId: true, messages: MESSAGE_SELECT },
      },
    },
  });
  if (!t) return null;

  const key = caseKeyOf({ kind: "ticket", id: t.id });
  const thread = t.appointmentSupportThread;
  const opener: TimelineItem = {
    id: `${t.id}-description`,
    author: "USER",
    authorName: t.user.name,
    body: t.description,
    internal: false,
    at: t.createdAt.toISOString(),
  };
  // An escalated case's transcript is the thread: public staff replies are
  // mirrored into it both ways, so only notes and user-side ticket replies
  // are added from the ticket (else every staff reply shows twice).
  const timeline = thread
    ? [
        ...messageItems(thread.messages as MessageRow[]),
        ...responseItems(
          t.responses.filter((r) => r.isInternal || !isOperator(r.user.role)),
        ),
      ]
    : [opener, ...responseItems(t.responses)];

  let appointmentId = thread?.appointmentId ?? null;
  if (!appointmentId && t.consultationId) {
    const c = await prisma.consultation.findUnique({
      where: { id: t.consultationId },
      select: { appointment: { select: { id: true } } },
    });
    appointmentId = c?.appointment?.id ?? null;
  }
  const [booking, payment, pastCases] = await Promise.all([
    appointmentId ? readBooking(appointmentId, t.user.name) : null,
    grants.showPayment ? readPayment(t.paymentId) : null,
    readPastCases(t.user.id, key),
  ]);

  return {
    key,
    kind: "ticket",
    ticketId: t.id,
    threadId: thread?.id ?? null,
    subject: t.title,
    reference: t.referenceNumber,
    topic: ticketTopic(t),
    status: t.status,
    priority: t.priority,
    channel: thread ? "HUMAN" : null,
    assignee: t.assignedTo,
    sla: slaStateOf(t),
    ackDueAt: iso(t.ackDueAt),
    resolutionDueAt: iso(t.resolutionDueAt),
    createdAt: t.createdAt.toISOString(),
    person: {
      id: t.user.id,
      name: t.user.name,
      role: t.user.role,
      email: grants.showEmail ? t.user.email : null,
      joinedAt: t.user.createdAt.toISOString(),
    },
    booking,
    payment,
    organization: t.organization,
    pastCases,
    timeline: timeline.sort(byTime),
    attachments: t.attachments.map((a) => ({
      id: a.id,
      name: a.originalName,
      url: a.fileUrl,
      size: a.fileSize,
    })),
  };
}

async function readThreadWorkspace(
  threadId: string,
  grants: WorkspaceGrants,
): Promise<CaseWorkspace | null> {
  const t = await prisma.appointmentSupportThread.findUnique({
    where: { id: threadId },
    select: {
      id: true,
      appointmentId: true,
      status: true,
      activeChannel: true,
      category: true,
      createdAt: true,
      supportTicketId: true,
      user: { select: PERSON_SELECT },
      organization: { select: { id: true, name: true } },
      messages: MESSAGE_SELECT,
      appointment: {
        select: {
          payment: {
            select: { id: true },
            take: 1,
            orderBy: { createdAt: "desc" },
          },
        },
      },
    },
  });
  if (!t) return null;
  const key = caseKeyOf({ kind: "thread", id: t.id });
  const [booking, payment, pastCases] = await Promise.all([
    readBooking(t.appointmentId, t.user.name),
    grants.showPayment
      ? readPayment(t.appointment.payment[0]?.id ?? null)
      : null,
    readPastCases(t.user.id, key),
  ]);
  return {
    key,
    kind: "thread",
    ticketId: t.supportTicketId,
    threadId: t.id,
    subject: `Help with ${booking?.title ?? "a session"}`,
    reference: null,
    topic: threadTopic(t.category),
    status: t.status,
    priority: null,
    channel: t.activeChannel,
    assignee: null,
    sla: null,
    ackDueAt: null,
    resolutionDueAt: null,
    createdAt: t.createdAt.toISOString(),
    person: {
      id: t.user.id,
      name: t.user.name,
      role: t.user.role,
      email: grants.showEmail ? t.user.email : null,
      joinedAt: t.user.createdAt.toISOString(),
    },
    booking,
    payment,
    organization: t.organization,
    pastCases,
    timeline: messageItems(t.messages as MessageRow[]),
    attachments: [],
  };
}

/**
 * The ticket an escalated conversation became, if any: its case is the
 * ticket (inbox-query.ts), so an `s_` link to it redirects there.
 */
export async function escalatedTicketOf(
  threadId: string,
): Promise<string | null> {
  const t = await prisma.appointmentSupportThread.findUnique({
    where: { id: threadId },
    select: { supportTicketId: true },
  });
  return t?.supportTicketId ?? null;
}

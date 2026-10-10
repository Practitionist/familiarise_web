import prisma from "@/lib/prisma";
import type { OwnTicketCase } from "@/types/support-case";

import { caseKeyOf } from "./case-key";
import { ticketTopic } from "./case-topic";
import {
  RESPONSE_SELECT,
  TIMELINE_LIMIT,
  byTime,
  readPayment,
  responseItems,
} from "./case-workspace";

async function readOwnSupportCase(
  caseId: string,
  userId: string,
): Promise<(OwnTicketCase & { appointmentId: string | null }) | null> {
  const c = await prisma.supportCase.findFirst({
    where: {
      id: caseId,
      deletedAt: null,
      OR: [{ submitterUserId: userId }, { requesterUserId: userId }],
    },
  });
  if (!c) return null;
  const redactTranscript =
    c.requesterUserId !== c.submitterUserId && userId !== c.submitterUserId;
  const paymentSubject = redactTranscript
    ? null
    : await prisma.supportCaseSubject.findFirst({
        where: { caseId: c.id, subjectType: "PAYMENT" },
        select: { subjectId: true },
      });
  const [payment, org, messages] = await Promise.all([
    redactTranscript
      ? Promise.resolve(null)
      : readPayment(paymentSubject?.subjectId ?? null),
    c.organizationId
      ? prisma.organization.findUnique({
          where: { id: c.organizationId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
    redactTranscript
      ? Promise.resolve([])
      : prisma.supportCaseMessage.findMany({
          where: { caseId: c.id, isInternal: false },
          orderBy: { seq: "asc" },
          take: -TIMELINE_LIMIT,
        }),
  ]);
  return {
    key: caseKeyOf({ kind: "case", id: c.id }),
    ticketId: c.id,
    appointmentId: c.appointmentId,
    subject: redactTranscript ? "Organization support request" : c.title,
    reference: c.referenceNumber,
    topic: ticketTopic({ category: c.category ?? "OTHER", issueType: null }),
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    payment,
    organization: org,
    timeline: messages.map((m) => ({
      id: m.id,
      author: m.sender,
      authorName: null,
      body: m.body,
      internal: false,
      at: m.createdAt.toISOString(),
    })),
  };
}

/**
 * The user side of a ticket: owner-scoped in the WHERE, private notes
 * filtered in the query (never fetched, so never serialisable).
 */
export async function readOwnTicket(
  ticketId: string,
  userId: string,
): Promise<(OwnTicketCase & { appointmentId: string | null }) | null> {
  const t = await prisma.supportTicket.findFirst({
    where: { id: ticketId, userId },
    select: {
      id: true,
      referenceNumber: true,
      title: true,
      description: true,
      status: true,
      category: true,
      issueType: true,
      createdAt: true,
      paymentId: true,
      user: { select: { name: true } },
      organization: { select: { id: true, name: true } },
      responses: {
        where: { isInternal: false },
        orderBy: { createdAt: "asc" },
        take: -TIMELINE_LIMIT,
        ...RESPONSE_SELECT,
      },
      appointmentSupportThread: { select: { appointmentId: true } },
    },
  });
  if (!t) return readOwnSupportCase(ticketId, userId);
  const payment = await readPayment(t.paymentId);
  return {
    key: caseKeyOf({ kind: "ticket", id: t.id }),
    ticketId: t.id,
    appointmentId: t.appointmentSupportThread?.appointmentId ?? null,
    subject: t.title,
    reference: t.referenceNumber,
    topic: ticketTopic(t),
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    payment,
    organization: t.organization,
    timeline: [
      {
        id: `${t.id}-description`,
        author: "USER" as const,
        authorName: t.user.name,
        body: t.description,
        internal: false,
        at: t.createdAt.toISOString(),
      },
      ...responseItems(t.responses),
    ].sort(byTime),
  };
}

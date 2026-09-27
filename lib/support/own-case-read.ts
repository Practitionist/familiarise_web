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
        orderBy: { createdAt: "desc" },
        take: TIMELINE_LIMIT,
        ...RESPONSE_SELECT,
      },
      appointmentSupportThread: { select: { appointmentId: true } },
    },
  });
  if (!t) return null;
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

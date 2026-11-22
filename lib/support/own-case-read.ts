import {
  ORG_FILED_CASE_TITLE,
  canCorrespondOnCase,
  isPresenterOnCase,
  projectCaseForViewer,
  visibleCaseWhere,
} from "./case-access";
import prisma from "@/lib/prisma";
import type { OwnTicketCase } from "@/types/support-case";
import { caseKeyOf } from "./case-key";
import { isPresenterAuthoredMessage } from "./case-message-actor";
import { ticketTopic } from "./case-topic";
import { TIMELINE_LIMIT, readPayment } from "./case-workspace";

export async function readOwnSupportCase(
  caseId: string,
  userId: string,
): Promise<OwnTicketCase | null> {
  const visible = await visibleCaseWhere({ userId, role: "CONSULTEE" });
  const c = await prisma.supportCase.findFirst({
    where: { AND: [{ id: caseId }, visible] },
    include: {
      organization: { select: { id: true, name: true } },
      subjects: true,
    },
  });
  if (!c) return null;
  const canReply = await canCorrespondOnCase(c, { userId, role: "CONSULTEE" });
  const isPresenter = !canReply && (await isPresenterOnCase(c, userId));
  const canRead = canReply || isPresenter;
  if (!canRead && c.requesterUserId !== userId) return null;
  const redact =
    !canRead || projectCaseForViewer(c, userId, canRead).summaryOnly;
  const [payment, rows] = await Promise.all([
    redact || !canReply
      ? null
      : readPayment(
          c.subjects.find((s) => s.subjectType === "PAYMENT")?.subjectId ??
            null,
        ),
    redact
      ? []
      : prisma.supportCaseMessage.findMany({
          where: { caseId: c.id, isInternal: false },
          orderBy: { seq: "asc" },
          take: -(TIMELINE_LIMIT + 1),
          include: { authorUser: { select: { name: true } } },
        }),
  ]);
  const messages = rows.slice(-TIMELINE_LIMIT);
  return {
    key: caseKeyOf({ kind: "case", id: c.id }),
    caseId: c.id,
    appointmentId: c.appointmentId,
    subject: redact ? ORG_FILED_CASE_TITLE : c.title,
    reference: c.referenceNumber,
    topic: ticketTopic(c),
    status: c.status,
    ackDueAt: c.ackDueAt?.toISOString() ?? null,
    acknowledgedAt: c.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: c.resolvedAt?.toISOString() ?? null,
    csatRating: redact || !canReply ? null : c.csatRating,
    filedByOrganizationNotice: redact,
    canReply: !redact && canRead,
    viewerIsPresenter: isPresenter,
    createdAt: c.createdAt.toISOString(),
    // The customer view carries the payment without its funding rail.
    payment: payment && {
      id: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      createdAt: payment.createdAt,
    },
    organization: c.organization,
    timeline: messages.map((m) => ({
      id: m.id,
      seq: m.seq,
      author: m.sender,
      authorName: m.authorUser?.name ?? null,
      body: m.body,
      internal: false,
      actorKind: isPresenterAuthoredMessage(m.metadata)
        ? ("PRESENTER" as const)
        : undefined,
      at: m.createdAt.toISOString(),
    })),
    hasMore: rows.length > TIMELINE_LIMIT,
    nextBeforeSeq: messages[0]?.seq ?? null,
  };
}

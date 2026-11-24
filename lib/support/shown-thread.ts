/**
 * Which of a booking's support cases its request page shows. A new intent other than a no-show
 * lands on the booking-wide thread, so that is the default; a session's page shows only that session's report.
 */

import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";

export const SHOWN_THREAD_SELECT = {
  id: true,
  referenceNumber: true,
  status: true,
  activeChannel: true,
  category: true,
  flowKey: true,
  currentNodeId: true,
  appointmentOccurrenceId: true,
  requesterUserId: true,
  ackDueAt: true,
  acknowledgedAt: true,
  resolvedAt: true,
  csatRating: true,
  csatAt: true,
  lastMessageAt: true,
  createdAt: true,
  updatedAt: true,
  messages: {
    where: { isInternal: false },
    orderBy: { seq: "asc" },
    take: -201,
    select: {
      id: true,
      seq: true,
      sender: true,
      body: true,
      metadata: true,
      createdAt: true,
    },
  },
} satisfies Prisma.SupportCaseSelect;

/** What the page names: the case it shows now, or the session it was opened for. */
export interface ShownThreadView {
  caseId?: string;
  occurrenceId?: string;
}

/**
 * A session's page shows that session's report (the case it names there, else its newest no-show case), never
 * another thread. Otherwise: the case named, else the newest booking-wide thread, else the newest session case.
 */
export async function readShownThread(
  appointmentId: string,
  userId: string,
  view: ShownThreadView,
) {
  const newest = (where: Prisma.SupportCaseWhereInput) =>
    prisma.supportCase.findFirst({
      where: {
        appointmentId,
        requesterUserId: userId,
        submitterUserId: userId,
        deletedAt: null,
        ...where,
      },
      orderBy: { createdAt: "desc" },
      select: SHOWN_THREAD_SELECT,
    });
  if (view.occurrenceId) {
    const session = { appointmentOccurrenceId: view.occurrenceId };
    return (
      (view.caseId ? await newest({ ...session, id: view.caseId }) : null) ??
      (await newest({ ...session, category: "NO_SHOW" }))
    );
  }
  return (
    (view.caseId ? await newest({ id: view.caseId }) : null) ??
    (await newest({ appointmentOccurrenceId: null })) ??
    (await newest({}))
  );
}

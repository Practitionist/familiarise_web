/**
 * Which of a booking's support cases its request page shows. A new intent other than a no-show
 * lands on the booking-wide thread, so that is the default; a session's case shows when the page names it.
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

/** The caller's own case the page names, else the named session's newest, else the newest booking-wide one, else the newest session case. */
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
  return (
    (view.caseId ? await newest({ id: view.caseId }) : null) ??
    (view.occurrenceId
      ? await newest({ appointmentOccurrenceId: view.occurrenceId })
      : null) ??
    (await newest({ appointmentOccurrenceId: null })) ??
    (await newest({}))
  );
}

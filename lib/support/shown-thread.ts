/**
 * Which of a booking's support cases its request page shows. A new intent other than a no-show
 * lands on the booking-wide thread, so that is the default; a session's page opens on that session's
 * report and keeps a booking-wide case only when the page names it, never another session's case.
 * With no booking-wide thread the default is a fresh start, never a session's report.
 */

import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { visibleCaseWhere } from "./case-access";

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

/**
 * The case read policy for a customer page: an organisation-owned case is shown only while the
 * viewer still holds that organisation's support permission, whoever filed it.
 */
const readableByCustomer = (userId: string) =>
  visibleCaseWhere({ userId, role: "CONSULTEE" });

/** What the page names: the case it shows now, or the session it was opened for. */
export interface ShownThreadView {
  caseId?: string;
  occurrenceId?: string;
}

/**
 * A session's page shows the case it names when that case is this session's or booking-wide (a page a
 * fresh turn moved there keeps it), else the session's newest no-show case; never another session's case.
 * Otherwise: the case named, else the newest booking-wide thread, else nothing.
 */
export async function readShownThread(
  appointmentId: string,
  userId: string,
  view: ShownThreadView,
) {
  const readable = await readableByCustomer(userId);
  const newest = (where: Prisma.SupportCaseWhereInput) =>
    prisma.supportCase.findFirst({
      where: {
        AND: [readable],
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
    const named = view.caseId
      ? await newest({
          id: view.caseId,
          OR: [session, { appointmentOccurrenceId: null }],
        })
      : null;
    return named ?? (await newest({ ...session, category: "NO_SHOW" }));
  }
  return (
    (view.caseId ? await newest({ id: view.caseId }) : null) ??
    (await newest({ appointmentOccurrenceId: null }))
  );
}

/** The caller's open session reports on this booking, newest first, so the booking's page links each one. */
export async function readOpenSessionReports(
  appointmentId: string,
  userId: string,
) {
  const rows = await prisma.supportCase.findMany({
    where: {
      AND: [await readableByCustomer(userId)],
      appointmentId,
      requesterUserId: userId,
      submitterUserId: userId,
      deletedAt: null,
      category: "NO_SHOW",
      appointmentOccurrenceId: { not: null },
      status: { notIn: ["RESOLVED", "CLOSED"] },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      appointmentOccurrenceId: true,
      occurrence: { select: { startsAt: true } },
    },
  });
  return rows.flatMap((r) =>
    r.appointmentOccurrenceId && r.occurrence
      ? [
          {
            caseId: r.id,
            occurrenceId: r.appointmentOccurrenceId,
            startsAt: r.occurrence.startsAt,
          },
        ]
      : [],
  );
}

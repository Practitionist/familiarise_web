/**
 * Opening a support case from a moderation report. A report alone never
 * unlocks a booking chat; the case it opens (one per report) is what staff
 * later hang any chat access on.
 */

import type { Prisma, ModerationReportType } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import {
  liveParticipant,
  NOT_COLLABORATOR_ROW,
} from "@/lib/booking/participants";
import { resolveCanonicalMeetingChannel } from "@/lib/meetings/mirror-room-chat";
import { reportReasonLabel } from "@/lib/labels/report-reasons";
import { formatReportReference } from "@/lib/moderation/report-reference";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { caseKeyOf } from "@/lib/support/case-key";
import { CAPTURED_PAYMENT_WHERE } from "@/lib/support/evidence-parties";
import { stageSupportCaseIntakeTx } from "@/lib/support/case-service";
import { supportDeadline } from "@/lib/support/deadline-policy";
import { issueTypeForReason, priorityForReason } from "@/lib/support/priority";
import { allocateTicketReference } from "@/lib/support/reference";
import { slaDeadlinesFor } from "@/lib/support/sla";
import type {
  LinkedReportCase,
  ReportCaseCategory,
  ReportCaseOptions,
} from "@/schemas/moderation";

/** How many shared bookings the open-case dialog offers. */
export const REPORT_CASE_CANDIDATE_LIMIT = 20;

/** The neutral case title: no names, no message content. */
export const REPORT_CASE_TITLE = "Report about a booking chat";

/** The priority.ts reason each category triages as. */
const PRIORITY_REASON: Record<ReportCaseCategory, string | null> = {
  SAFETY_CONCERN: "safety_other",
  QUALITY_COMPLAINT: "quality_other",
  OTHER: null,
};

/**
 * Appointments `userId` is a party to: a live seat, a captured payment, the
 * plan's consultant, or an accepted PRESENTER collaborator on a group plan.
 */
export function bookingPartyWhere(
  userId: string,
): Prisma.AppointmentWhereInput {
  const owns = { userId };
  const presenter = {
    status: "ACCEPTED" as const,
    tier: "PRESENTER" as const,
    consultantProfile: owns,
  };
  return {
    OR: [
      {
        participants: {
          some: { ...liveParticipant(userId), ...NOT_COLLABORATOR_ROW },
        },
      },
      {
        payment: {
          some: { userId, ...CAPTURED_PAYMENT_WHERE },
        },
      },
      { consultation: { consultationPlan: { consultantProfile: owns } } },
      { subscription: { subscriptionPlan: { consultantProfile: owns } } },
      {
        webinar: {
          webinarPlan: {
            OR: [
              { consultantProfile: owns },
              { collaborators: { some: presenter } },
            ],
          },
        },
      },
      {
        class: {
          classPlan: {
            OR: [
              { consultantProfile: owns },
              { collaborators: { some: presenter } },
            ],
          },
        },
      },
      { trial: { consultantProfile: owns } },
    ],
  };
}

const sharedBookingWhere = (
  reporterId: string,
  targetId: string,
): Prisma.AppointmentWhereInput => ({
  deletedAt: null,
  AND: [bookingPartyWhere(reporterId), bookingPartyWhere(targetId)],
});

/** What resolveCanonicalMeetingChannel reads off an appointment. */
const CHANNEL_SELECT = {
  id: true,
  appointmentType: true,
  consultation: {
    select: {
      consultationPlan: {
        select: {
          organizationId: true,
          consultantProfile: { select: { userId: true } },
        },
      },
    },
  },
  subscription: {
    select: {
      subscriptionPlan: {
        select: {
          organizationId: true,
          consultantProfile: { select: { userId: true } },
        },
      },
    },
  },
  webinar: { select: { id: true } },
  class: { select: { id: true } },
} satisfies Prisma.AppointmentSelect;

type ChannelAppointment = Prisma.AppointmentGetPayload<{
  select: typeof CHANNEL_SELECT;
}>;

async function canonicalCid(
  appointment: ChannelAppointment,
  db: Pick<Tx, "appointmentParticipant">,
): Promise<string | null> {
  const channel = await resolveCanonicalMeetingChannel(appointment, db);
  return channel ? `${channel.channelType}:${channel.channelId}` : null;
}

const linkedCaseOf = (c: {
  id: string;
  referenceNumber: string;
}): LinkedReportCase & { caseKey: string } => ({
  id: c.id,
  referenceNumber: c.referenceNumber,
  caseKey: caseKeyOf({ kind: "case", id: c.id }),
});

function reportHasCase(c: { id: string; referenceNumber: string }) {
  return new OpsRefusal(
    "REPORT_HAS_CASE",
    `This report already has support case ${c.referenceNumber}.`,
    409,
    { existingCase: linkedCaseOf(c) },
  );
}

/** The reporter's own words only; the reported message text never enters the case. */
export function reportCaseDescription(report: {
  id: string;
  reason: string;
  description: string | null;
}): string {
  const lines = [
    `Opened by support from moderation report ${formatReportReference(report.id)}.`,
    `Reason given: ${reportReasonLabel(report.reason)}`,
  ];
  const own = report.description?.trim();
  if (own) lines.push("", own);
  return lines.join("\n");
}

export interface OpenReportCaseInput {
  reportId: string;
  appointmentId: string;
  category: ReportCaseCategory;
  actorUserId: string;
}

/** Bars a report type whose evidence lives in a chat from a booking without one. */
function assertChatEligible(
  reportType: ModerationReportType,
  appointmentType: string,
) {
  if (reportType === "MESSAGE" && appointmentType === "TRIAL") {
    throw new OpsRefusal(
      "CHAT_DISABLED",
      "Trial bookings have no chat, so a message report cannot be linked to one.",
      409,
    );
  }
}

/** Creates the reporter's case on the chosen booking and links it to the report, on `tx`. */
export async function openReportCaseTx(
  tx: Tx,
  input: OpenReportCaseInput,
  now: Date = new Date(),
) {
  const report = await tx.moderationReport.findUnique({
    where: { id: input.reportId },
    select: {
      id: true,
      type: true,
      reason: true,
      description: true,
      reportedById: true,
      targetUserId: true,
      streamChannelCid: true,
      supportCase: { select: { id: true, referenceNumber: true } },
    },
  });
  if (!report) {
    throw new OpsRefusal("NOT_FOUND", "Report not found.", 404);
  }
  if (report.supportCase) throw reportHasCase(report.supportCase);

  const appointment = await tx.appointment.findFirst({
    where: { id: input.appointmentId, deletedAt: null },
    select: CHANNEL_SELECT,
  });
  if (!appointment) {
    throw new OpsRefusal("APPOINTMENT_NOT_FOUND", "Booking not found.", 404);
  }
  const shared = await tx.appointment.count({
    where: {
      id: appointment.id,
      ...sharedBookingWhere(report.reportedById, report.targetUserId),
    },
  });
  if (shared === 0) {
    throw new OpsRefusal(
      "NOT_BOOKING_PARTIES",
      "The reporter and the reported user are not both on this booking.",
      400,
    );
  }
  assertChatEligible(report.type, appointment.appointmentType);
  if (
    report.streamChannelCid &&
    (await canonicalCid(appointment, tx)) !== report.streamChannelCid
  ) {
    throw new OpsRefusal(
      "CHANNEL_MISMATCH",
      "This booking's chat is not the chat the report was made in.",
      400,
    );
  }

  const scope = {
    ownershipScope: "PERSONAL" as const,
    organizationId: null,
    scopeKey: `APPOINTMENT:${appointment.id}`,
    requesterUserId: report.reportedById,
    submitterUserId: report.reportedById,
    category: input.category,
  };
  const openInScope = await tx.supportCase.findFirst({
    where: { ...scope, closedAt: null, deletedAt: null },
    select: { id: true, referenceNumber: true },
  });
  if (openInScope) {
    throw new OpsRefusal(
      "OPEN_CASE_EXISTS",
      `The reporter already has open case ${openInScope.referenceNumber} about this booking; continue there.`,
      409,
      { existingCase: linkedCaseOf(openInScope) },
    );
  }

  const reason = PRIORITY_REASON[input.category];
  const priority = priorityForReason(reason);
  const description = reportCaseDescription(report);
  const referenceNumber = await allocateTicketReference(tx, now);
  let created;
  try {
    created = await tx.supportCase.create({
      data: {
        ...scope,
        referenceNumber,
        moderationReportId: report.id,
        appointmentId: appointment.id,
        title: REPORT_CASE_TITLE,
        description,
        issueType: issueTypeForReason(reason),
        activeChannel: "HUMAN",
        priority,
        status: "OPEN",
        receivedAt: now,
        ...supportDeadline(input.category, now),
        ...slaDeadlinesFor(priority, now),
        messageSeq: 1,
        lastMessageAt: now,
        subjects: {
          create: [
            {
              subjectType: "APPOINTMENT",
              subjectId: appointment.id,
              isPrimary: true,
            },
          ],
        },
        messages: {
          create: [
            {
              seq: 1,
              sender: "SYSTEM",
              body: description,
              isInternal: false,
              authorUserId: null,
              createdAt: now,
            },
          ],
        },
        events: {
          create: [
            {
              actorId: input.actorUserId,
              kind: "CREATED",
              toValue: "OPEN",
              note: `From moderation report ${formatReportReference(report.id)}`,
              createdAt: now,
            },
          ],
        },
      },
    });
  } catch (err) {
    // The aborted transaction cannot read the winner; the caller refreshes to see it.
    if (isUniqueViolation(err)) {
      throw new OpsRefusal(
        uniqueTargetIncludes(err, "moderationReportId")
          ? "REPORT_HAS_CASE"
          : "OPEN_CASE_EXISTS",
        "A support case for this was opened a moment ago. Refresh to see it.",
        409,
      );
    }
    throw err;
  }

  await stageSupportCaseIntakeTx(tx, created, "SYSTEM");
  return {
    supportCase: created,
    linkedCase: linkedCaseOf(created),
  };
}

function uniqueTargetIncludes(err: unknown, column: string): boolean {
  const meta = (err as { meta?: unknown }).meta;
  return JSON.stringify(meta ?? {}).includes(column);
}

const CANDIDATE_SELECT = {
  ...CHANNEL_SELECT,
  consultation: {
    select: {
      consultationPlan: {
        select: {
          title: true,
          organizationId: true,
          consultantProfile: { select: { userId: true } },
        },
      },
    },
  },
  subscription: {
    select: {
      subscriptionPlan: {
        select: {
          title: true,
          organizationId: true,
          consultantProfile: { select: { userId: true } },
        },
      },
    },
  },
  webinar: { select: { id: true, webinarPlan: { select: { title: true } } } },
  class: { select: { id: true, classPlan: { select: { title: true } } } },
  trial: { select: { subscriptionPlan: { select: { title: true } } } },
  occurrences: {
    where: { deletedAt: null },
    orderBy: { startsAt: "asc" },
    take: 1,
    select: { startsAt: true },
  },
} satisfies Prisma.AppointmentSelect;

type CandidateRow = Prisma.AppointmentGetPayload<{
  select: typeof CANDIDATE_SELECT;
}>;

function candidateTitle(row: CandidateRow): string | null {
  return (
    row.consultation?.consultationPlan?.title ??
    row.subscription?.subscriptionPlan?.title ??
    row.webinar?.webinarPlan?.title ??
    row.class?.classPlan?.title ??
    row.trial?.subscriptionPlan?.title ??
    null
  );
}

/** The open-case dialog's data: the linked case, or the bookings both users share. */
export async function readReportCaseOptions(
  reportId: string,
): Promise<ReportCaseOptions | null> {
  const report = await prisma.moderationReport.findUnique({
    where: { id: reportId },
    select: {
      type: true,
      reportedById: true,
      targetUserId: true,
      streamChannelCid: true,
      supportCase: { select: { id: true, referenceNumber: true } },
    },
  });
  if (!report) return null;
  if (report.supportCase) {
    return {
      linkedCase: {
        id: report.supportCase.id,
        referenceNumber: report.supportCase.referenceNumber,
      },
      candidates: [],
    };
  }
  const rows = await prisma.appointment.findMany({
    where: sharedBookingWhere(report.reportedById, report.targetUserId),
    orderBy: { createdAt: "desc" },
    take: REPORT_CASE_CANDIDATE_LIMIT,
    select: CANDIDATE_SELECT,
  });
  const candidates = [];
  // Sequential: each channel resolve may read the roster on the one pooled connection.
  for (const row of rows) {
    candidates.push({
      id: row.id,
      type: row.appointmentType,
      title: candidateTitle(row),
      startsAt: row.occurrences[0]?.startsAt.toISOString() ?? null,
      chatMatchesReport: await chatMatchesReport(report, row),
    });
  }
  return { linkedCase: null, candidates };
}

/** Whether opening a case on `row` would pass the door's chat checks; null when the report names no chat. */
async function chatMatchesReport(
  report: { type: ModerationReportType; streamChannelCid: string | null },
  row: CandidateRow,
): Promise<boolean | null> {
  if (report.type === "MESSAGE" && row.appointmentType === "TRIAL") {
    return false;
  }
  if (!report.streamChannelCid) return null;
  return (await canonicalCid(row, prisma)) === report.streamChannelCid;
}

/**
 * The two notices an incident sends: one digest per learner, staged in the
 * commit that stamps notifiedAt on all of that learner's rows, and one ops
 * report, staged in the commit that stamps reportedAt. The outbox relay
 * finishes any send a killed run left PENDING.
 */

import { SUPPORT_EMAIL } from "@/lib/company";
import type { IncidentRemedyKind, Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { subscriptionPlanEnd } from "@/lib/booking/entitlement";
import { EMAIL_BUDGET_MS, SENDERS } from "@/lib/email/config";
import { attempt, stage, type RenderedEmail } from "@/lib/email/deliver";
import { attemptStaged } from "@/lib/email/send-to-recipients";
import {
  PLATFORM_INCIDENT_DIGEST,
  stagePlatformIncidentDigest,
  type IncidentDigestItem,
} from "@/lib/email/senders/incident";
import { canaryAlertRecipient } from "@/lib/observability/ingest-alert";
import { postOpsChat } from "@/lib/observability/ops-chat";
import {
  DEAD_LETTER_PREFIX,
  MAX_REMEDY_ATTEMPTS,
  isRebookableParent,
} from "./incident-keys";

const DIGEST_LEARNERS_PER_RUN = 500;
const PLATFORM_INCIDENT_REPORT = "platform-incident-report";

const TITLE = { select: { title: true } } as const;

const EXPERT_NAME = {
  consultantProfile: { select: { user: { select: { name: true } } } },
} as const;

const DIGEST_SELECT = {
  kind: true,
  dueAt: true,
  doneAt: true,
  rebookedOccurrence: { select: { startsAt: true } },
  occurrence: {
    select: {
      startsAt: true,
      appointmentId: true,
      appointment: {
        select: {
          consultation: {
            select: {
              status: true,
              consultationPlan: {
                select: { title: true, ...EXPERT_NAME },
              },
            },
          },
          subscription: {
            select: {
              status: true,
              planEndsAt: true,
              schedulingPeriodStartsAt: true,
              schedulingTimezone: true,
              subscriptionPlan: {
                select: { title: true, durationInMonths: true },
              },
            },
          },
          trial: {
            select: { status: true, subscriptionPlan: TITLE, ...EXPERT_NAME },
          },
          class: { select: { classPlan: TITLE } },
          webinar: { select: { webinarPlan: TITLE } },
        },
      },
    },
  },
} satisfies Prisma.IncidentRemedySelect;

type DigestRow = Prisma.IncidentRemedyGetPayload<{
  select: typeof DIGEST_SELECT;
}>;

function digestItem(row: DigestRow): IncidentDigestItem {
  const appt = row.occurrence.appointment;
  const sub = appt.subscription;
  const planEnd = sub ? subscriptionPlanEnd(sub) : null;
  return {
    kind: row.kind,
    appointmentId: row.occurrence.appointmentId,
    expertName:
      (appt.consultation?.consultationPlan ?? appt.trial)?.consultantProfile
        .user.name ?? null,
    rebookedStartsAt: row.rebookedOccurrence?.startsAt ?? null,
    // Offered only while the remedy is still open, as the rebook door requires.
    rebookable:
      row.kind === "REFUND_AT_DUE" &&
      row.doneAt === null &&
      row.dueAt > new Date() &&
      (appt.trial
        ? isRebookableParent("trial", appt.trial.status)
        : isRebookableParent("consultation", appt.consultation?.status)),
    planTitle:
      appt.consultation?.consultationPlan.title ??
      appt.trial?.subscriptionPlan.title ??
      sub?.subscriptionPlan.title ??
      appt.class?.classPlan.title ??
      appt.webinar?.webinarPlan.title ??
      "Your session",
    startsAt: row.occurrence.startsAt,
    dueAt: row.dueAt,
    planEndsAt:
      sub &&
      planEnd &&
      ["APPROVED", "SCHEDULED"].includes(sub.status) &&
      planEnd > new Date()
        ? planEnd
        : null,
  };
}

/** A remedy that holds the learner's digest: due now and not yet applied or dead-lettered. */
const holdsDigest = (incidentId: string, userId: string) =>
  ({
    incidentId,
    userId,
    doneAt: null,
    attempts: { lt: MAX_REMEDY_ATTEMPTS },
    kind: { not: "REFUND_AT_DUE" },
  }) satisfies Prisma.IncidentRemedyWhereInput;

/**
 * One digest per learner per incident, sent once every remedy due now is
 * applied (a 48 h refund is not waited for); returns how many were staged.
 */
export async function sendIncidentDigests(
  incidentId: string,
  opts: { limit: number; pastDeadline: () => boolean },
): Promise<number> {
  const learners = await prisma.incidentRemedy.findMany({
    where: { incidentId, notifiedAt: null },
    distinct: ["userId"],
    orderBy: { userId: "asc" },
    take: DIGEST_LEARNERS_PER_RUN,
    select: { userId: true },
  });
  let sent = 0;
  for (const { userId } of learners) {
    if (sent >= opts.limit || opts.pastDeadline()) break;
    const staged = await prisma.$transaction(async (tx) => {
      // Judged on every one of the learner's rows, inside the commit that stamps them.
      if (
        (await tx.incidentRemedy.count({
          where: holdsDigest(incidentId, userId),
        })) > 0
      ) {
        return [];
      }
      const { count } = await tx.incidentRemedy.updateMany({
        where: { incidentId, userId, notifiedAt: null },
        data: { notifiedAt: new Date() },
      });
      if (count === 0) return [];
      const items = await tx.incidentRemedy.findMany({
        where: { incidentId, userId },
        orderBy: [{ occurrence: { startsAt: "asc" } }, { id: "asc" }],
        select: DIGEST_SELECT,
      });
      return stagePlatformIncidentDigest(tx, {
        incidentId,
        userId,
        items: items.map(digestItem),
      });
    });
    if (staged.length === 0) continue;
    sent += 1;
    await attemptStaged(staged, PLATFORM_INCIDENT_DIGEST, EMAIL_BUDGET_MS.JOB);
  }
  return sent;
}

interface ReportCounts {
  byKind: Partial<Record<IncidentRemedyKind, number>>;
  deadLettered: number;
  sessions: number;
}

function buildIncidentReport(
  incident: { id: string; startsAt: Date; endsAt: Date; reason: string },
  counts: ReportCounts,
): { subject: string; text: string } {
  const lines = Object.entries(counts.byKind).map(
    ([kind, n]) => `${kind}: ${n}`,
  );
  const subject = `[Familiarise] Platform incident settled: ${counts.sessions} session(s), ${counts.deadLettered} need a human`;
  const text = [
    `Incident ${incident.id}, ${incident.startsAt.toISOString()} to ${incident.endsAt.toISOString()}.`,
    `Reason: ${incident.reason}`,
    `Remedies by kind: ${lines.join(", ") || "none"}.`,
    counts.deadLettered > 0
      ? `${counts.deadLettered} remedy row(s) were dead-lettered ("${DEAD_LETTER_PREFIX}") and must be settled by hand; see Money → Incidents.`
      : "Every remedy was applied.",
  ].join("\n");
  return { subject, text };
}

/** The ops report, exactly once per incident: staged with the reportedAt stamp. */
export async function stageAndSendIncidentReport(
  incidentId: string,
): Promise<number> {
  const committed = await prisma.$transaction(async (tx) => {
    const incident = await tx.platformIncident.findUnique({
      where: { id: incidentId },
      select: { id: true, startsAt: true, endsAt: true, reason: true },
    });
    if (!incident) return null;
    const { count } = await tx.platformIncident.updateMany({
      where: { id: incidentId, reportedAt: null },
      data: { reportedAt: new Date() },
    });
    if (count === 0) return null;
    const groups = await tx.incidentRemedy.groupBy({
      by: ["kind"],
      where: { incidentId },
      _count: { _all: true },
    });
    // Called once every row is terminal, so an undone row is a dead-lettered one.
    const deadLettered = await tx.incidentRemedy.count({
      where: { incidentId, doneAt: null },
    });
    const sessions = await tx.incidentRemedy.groupBy({
      by: ["occurrenceId"],
      where: { incidentId },
    });
    const report = buildIncidentReport(incident, {
      byKind: Object.fromEntries(groups.map((g) => [g.kind, g._count._all])),
      deadLettered,
      sessions: sessions.length,
    });
    const message: RenderedEmail = {
      from: SENDERS.ops,
      to: canaryAlertRecipient(),
      replyTo: SUPPORT_EMAIL,
      subject: report.subject,
      text: report.text,
      html: report.text
        .split("\n")
        .map((l) => `<p>${escapeHtml(l)}</p>`)
        .join(""),
    };
    const staged = await stage(message, PLATFORM_INCIDENT_REPORT, {
      tx,
      entityRef: `incident:${incidentId}`,
    });
    return { staged, message, report };
  });
  if (!committed) return 0;
  await attempt(committed.staged, committed.message, PLATFORM_INCIDENT_REPORT, {
    budgetMs: EMAIL_BUDGET_MS.JOB,
  });
  await postOpsChat(`${committed.report.subject}. ${committed.report.text}`);
  return 1;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

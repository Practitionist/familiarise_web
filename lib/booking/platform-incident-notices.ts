/**
 * The two notices an incident sends: one digest per learner, staged in the
 * commit that stamps notifiedAt on all of that learner's rows, and one ops
 * report, staged in the commit that stamps reportedAt. The outbox relay
 * finishes any send a killed run left PENDING.
 */

import type { IncidentRemedyKind, Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { EMAIL_BUDGET_MS, OPS_EMAIL, SENDERS } from "@/lib/email/config";
import { attempt, stage, type RenderedEmail } from "@/lib/email/deliver";
import { attemptStaged } from "@/lib/email/send-to-recipients";
import {
  PLATFORM_INCIDENT_DIGEST,
  stagePlatformIncidentDigest,
  type IncidentDigestItem,
} from "@/lib/email/senders/incident";
import { canaryAlertRecipient } from "@/lib/observability/ingest-alert";
import { postOpsChat } from "@/lib/observability/ops-chat";
import { DEAD_LETTER_PREFIX, MAX_REMEDY_ATTEMPTS } from "./incident-keys";

const DIGEST_ROWS_PER_RUN = 500;
const PLATFORM_INCIDENT_REPORT = "platform-incident-report";

const TITLE = { select: { title: true } } as const;

const DIGEST_SELECT = {
  kind: true,
  dueAt: true,
  occurrence: {
    select: {
      startsAt: true,
      appointment: {
        select: {
          consultation: { select: { consultationPlan: TITLE } },
          subscription: {
            select: {
              status: true,
              schedulingPeriodEndsAt: true,
              subscriptionPlan: TITLE,
            },
          },
          trial: { select: { subscriptionPlan: TITLE } },
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
  return {
    kind: row.kind,
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
      ["APPROVED", "SCHEDULED"].includes(sub.status) &&
      sub.schedulingPeriodEndsAt > new Date()
        ? sub.schedulingPeriodEndsAt
        : null,
  };
}

/** A learner is ready once every remedy due now is done; a 48 h refund is not waited for. */
function readyLearners(
  rows: readonly {
    userId: string;
    kind: IncidentRemedyKind;
    doneAt: Date | null;
    attempts: number;
  }[],
): string[] {
  const blocked = new Set(
    rows
      .filter(
        (r) =>
          r.kind !== "REFUND_AT_DUE" &&
          r.doneAt === null &&
          r.attempts < MAX_REMEDY_ATTEMPTS,
      )
      .map((r) => r.userId),
  );
  return [...new Set(rows.map((r) => r.userId))].filter(
    (id) => !blocked.has(id),
  );
}

/** One digest per learner per incident; returns how many were staged. */
export async function sendIncidentDigests(
  incidentId: string,
  opts: { limit: number; pastDeadline: () => boolean },
): Promise<number> {
  const rows = await prisma.incidentRemedy.findMany({
    where: { incidentId, notifiedAt: null },
    orderBy: [{ userId: "asc" }, { id: "asc" }],
    take: DIGEST_ROWS_PER_RUN,
    select: { userId: true, kind: true, doneAt: true, attempts: true },
  });
  let sent = 0;
  for (const userId of readyLearners(rows).slice(0, opts.limit)) {
    if (opts.pastDeadline()) break;
    const staged = await prisma.$transaction(async (tx) => {
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
    if (staged.length > 0) sent += 1;
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
      replyTo: OPS_EMAIL,
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

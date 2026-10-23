import { Prisma, UserRole } from "@prisma/client";
import { z } from "zod";
import prisma, { type Tx } from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { BREACH_REPORTING_DEADLINE_HOURS } from "@/lib/backoffice/queue-predicates";
import { stage } from "@/lib/email/deliver";
import { SENDERS, OPS_EMAIL } from "@/lib/email/config";
import { notifyComplianceAlert } from "@/lib/novu/service";
import { postOpsChat } from "@/lib/observability/ops-chat";
import { reportSentryMessage } from "@/lib/observability/report";
import { getAppUrl } from "@/lib/url";

const ACTIVE_PREFIX = "compliance:databreach-deadline:active:";
const COMPLETE_PREFIX = "compliance:databreach-deadline:complete:";
const MAX_ROWS = 50;
const DEFAULT_RECIPIENT_LIMIT = 5;
const START_BUDGET_MS = 16_000;
const recipientSchema = z.array(
  z.object({ id: z.string(), email: z.string().min(1) }),
);

function hourWindow(now: Date): string {
  return new Date(
    Math.floor(now.getTime() / 3_600_000) * 3_600_000,
  ).toISOString();
}

async function pendingRecipients(
  ref: string,
  officer: string | undefined,
  limit: number,
) {
  const rows: unknown = await prisma.$queryRaw(Prisma.sql`
    SELECT u.id, u.email FROM "User" u
    WHERE (u.role = ${UserRole.ADMIN}::"UserRole" OR lower(u.email) = lower(${officer ?? null}))
      AND btrim(u.email) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM "FailedEmail" f
        WHERE f."entityRef" = ${ref} AND f.recipient = u.email
      )
    ORDER BY u.id ASC LIMIT ${limit}
  `);
  return recipientSchema.parse(rows);
}

async function stageRecipient(
  tx: Tx,
  recipient: { id: string; email: string },
  digest: {
    ref: string;
    title: string;
    reason: string;
    dueDate: Date;
    dashboardUrl: string;
    officer: string | undefined;
  },
) {
  const { ref, title, reason, dueDate, dashboardUrl, officer } = digest;
  const current = await tx.user.findFirst({
    where: {
      id: recipient.id,
      email: recipient.email,
      OR: [
        { role: UserRole.ADMIN },
        ...(officer
          ? [{ email: { equals: officer, mode: Prisma.QueryMode.insensitive } }]
          : []),
      ],
    },
    select: { id: true },
  });
  if (!current) return false;
  await notifyComplianceAlert(
    recipient.id,
    {
      title,
      obligationType: "DPDP_DATA_BREACH",
      dueDate: dueDate.toISOString(),
      dashboardUrl,
    },
    `${ref}:${recipient.id}`,
    { tx, deferAttempt: true },
  );
  const staged = await stage(
    {
      from: SENDERS.security,
      to: recipient.email,
      subject: title,
      html: `<p>${reason}</p><p>Earliest deadline: ${dueDate.toISOString()}</p><p><a href="${dashboardUrl}">Open compliance dashboard</a></p>`,
    },
    "COMPLIANCE_ALERT",
    { tx, entityRef: ref },
  );
  if (!staged)
    throw new Error("Compliance email staging did not persist an obligation");
  return true;
}

/** Stages bounded slices of the oldest unfinished hourly alert digest. */
export async function runDataBreachDeadlineAlerts(
  opts: { limit?: number; startedAt?: number } = {},
) {
  const startedAt = opts.startedAt ?? Date.now();
  const limit = Math.min(
    MAX_ROWS,
    Math.max(1, opts.limit ?? DEFAULT_RECIPIENT_LIMIT),
  );
  return withCronLock(
    "databreach-deadline-alerts",
    { failMode: "closed" },
    async () => {
      const errors: string[] = [];
      const result = {
        success: true,
        atRisk: 0,
        overdue: 0,
        recipientsStaged: 0,
        officerStaged: false,
        hasMore: false,
        deadlineReached: false,
        windowStart: "",
        errors,
      };
      const timedOut = () => {
        if (Date.now() - startedAt < START_BUDGET_MS) return false;
        result.success = false;
        result.deadlineReached = true;
        result.hasMore = true;
        return true;
      };
      if (timedOut()) return result;
      const now = new Date();
      const active = await prisma.failedEmail.findFirst({
        where: { entityRef: { startsWith: ACTIVE_PREFIX } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { entityRef: true },
      });
      const ref = active?.entityRef ?? `${ACTIVE_PREFIX}${hourWindow(now)}`;
      const window = z
        .string()
        .datetime()
        .parse(ref.slice(ACTIVE_PREFIX.length));
      result.windowStart = window;
      const completeRef = `${COMPLETE_PREFIX}${window}`;
      if (timedOut()) return result;
      if (
        !active &&
        (await prisma.failedEmail.findFirst({
          where: { entityRef: completeRef },
          select: { id: true },
        }))
      )
        return result;
      if (timedOut()) return result;
      const candidates = await prisma.dataBreach.findMany({
        where: {
          reportedAt: null,
          detectedAt: {
            lte: new Date(
              now.getTime() -
                (BREACH_REPORTING_DEADLINE_HOURS - 12) * 3_600_000,
            ),
          },
        },
        orderBy: [{ detectedAt: "asc" }, { id: "asc" }],
        take: MAX_ROWS + 1,
        select: { id: true, detectedAt: true },
      });
      result.atRisk = candidates.length;
      result.overdue = candidates.filter(
        (row) =>
          row.detectedAt.getTime() <
          now.getTime() - BREACH_REPORTING_DEADLINE_HOURS * 3_600_000,
      ).length;
      if (candidates.length === 0) {
        if (active)
          await prisma.failedEmail.updateMany({
            where: { entityRef: ref },
            data: { entityRef: completeRef },
          });
        return result;
      }
      if (timedOut()) return result;
      const rawOfficer = process.env.DATABREACH_ALERT_EMAIL?.trim();
      const officerResult = rawOfficer
        ? z.string().email().safeParse(rawOfficer)
        : undefined;
      const officer = officerResult?.success ? officerResult.data : undefined;
      if (officerResult && !officerResult.success)
        result.errors.push(
          "DATABREACH_ALERT_EMAIL is not a valid email address",
        );
      const recipients = await pendingRecipients(ref, officer, limit + 1);
      result.hasMore = recipients.length > limit;
      const dueDate = new Date(
        candidates[0].detectedAt.getTime() +
          BREACH_REPORTING_DEADLINE_HOURS * 3_600_000,
      );
      const sampledCount = `${result.atRisk}${candidates.length > MAX_ROWS ? "+" : ""}`;
      const overdueSuffix = result.overdue
        ? ` — ${result.overdue} OVERDUE`
        : "";
      const title = `[DPDP] ${sampledCount} breach(es) approaching 72h deadline${overdueSuffix}`;
      const reason = `${sampledCount} unreported breach(es) approaching or past the configured 72-hour reporting deadline (${result.overdue} overdue).`;
      const dashboardUrl = `${getAppUrl()}/dashboard/admin/compliance?tab=breaches`;
      console.warn("[DataBreach] deadline alert digest", {
        event: "dpdp.databreach.deadline",
        atRisk: result.atRisk,
        overdue: result.overdue,
        windowStart: window,
      });
      for (const recipient of recipients.slice(0, limit)) {
        if (timedOut()) break;
        try {
          if (
            await prisma.$transaction((tx) =>
              stageRecipient(tx, recipient, {
                ref,
                title,
                reason,
                dueDate,
                dashboardUrl,
                officer,
              }),
            )
          )
            result.recipientsStaged++;
        } catch (error) {
          result.errors.push(
            error instanceof Error ? error.message : "Recipient staging failed",
          );
        }
      }
      if (timedOut()) return result;
      if (officer) {
        try {
          const user = await prisma.user.findFirst({
            where: { email: { equals: officer, mode: "insensitive" } },
            select: { id: true },
          });
          if (
            !user &&
            !(await prisma.failedEmail.findFirst({
              where: { entityRef: ref, recipient: officer },
              select: { id: true },
            }))
          ) {
            const staged = await prisma.$transaction((tx) =>
              stage(
                {
                  from: SENDERS.ops,
                  to: officer,
                  replyTo: OPS_EMAIL,
                  subject: title,
                  html: `<p>${reason}</p><p><a href="${dashboardUrl}">Open compliance dashboard</a></p>`,
                },
                "DATABREACH_DEADLINE_ALERT",
                { tx, entityRef: ref },
              ),
            );
            if (!staged)
              throw new Error(
                "Officer email staging did not persist an obligation",
              );
            result.officerStaged = true;
          }
        } catch (error) {
          result.errors.push(
            error instanceof Error ? error.message : "Officer staging failed",
          );
        }
      }
      if (!active && recipients.length === 0 && !officer)
        result.errors.push(
          "No eligible admin email or configured officer mailbox",
        );
      if (result.errors.length > 0) {
        result.success = false;
        result.hasMore = true;
        reportSentryMessage(
          "Data-breach alert staging left unfinished obligations",
          {
            subsystem: "compliance",
            op: "databreach-deadline-alerts",
            level: "error",
            extra: { errors: result.errors, windowStart: window },
          },
        );
      }
      if (!result.hasMore && result.success && !timedOut()) {
        if (Date.now() - startedAt < START_BUDGET_MS - 5_000)
          await postOpsChat(`${title}. ${dashboardUrl}`);
        await prisma.failedEmail.updateMany({
          where: { entityRef: ref },
          data: { entityRef: completeRef },
        });
      }
      return result;
    },
  );
}

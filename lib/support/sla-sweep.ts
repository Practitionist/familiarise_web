import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
} from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { stageBell } from "@/lib/novu/stage-bell";
import { deriveTransactionId } from "@/lib/novu/outbox";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { getAppUrl } from "@/lib/url";
import { DEFAULT_FROM_ADDRESS, deliver, EMAIL_BUDGET_MS } from "@/lib/email";
import { reportSentryError } from "@/lib/observability/report";
import { slaStateOf } from "./sla";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const ACK_WARN_MS = 2 * HOUR_MS;
const RES_WARN_MS = 24 * HOUR_MS;
const AUTO_CLOSE_DAYS_MS = 28 * DAY_MS;

type SlaNoticeKind = "ack" | "res";
type SlaNoticeLevel = "warn" | "breach";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface SupportSlaSweepResult {
  success: boolean;
  scanned: number;
  slaNoticesStaged: number;
  orgEscalationEmailsSent: number;
  autoClosedCount: number;
  disputeNoticesStaged: number;
  errors: string[];
}

function slaNoticeTransitions(
  row: {
    status:
      "OPEN" | "IN_PROGRESS" | "ESCALATED" | "ON_HOLD" | "RESOLVED" | "CLOSED";
    ackDueAt: Date | null;
    acknowledgedAt: Date | null;
    resolutionDueAt: Date | null;
    resolvedAt: Date | null;
    awaitingUserSince: Date | null;
    pausedSeconds: number;
  },
  now: Date,
): Array<{ kind: SlaNoticeKind; level: SlaNoticeLevel }> {
  if (row.awaitingUserSince !== null) return [];
  const state = slaStateOf(row, now);
  if (state.paused) return [];

  const notices: Array<{ kind: SlaNoticeKind; level: SlaNoticeLevel }> = [];

  if (state.ackBreached) {
    notices.push({ kind: "ack", level: "breach" });
  } else if (
    state.msToAckDue !== null &&
    state.msToAckDue > 0 &&
    state.msToAckDue <= ACK_WARN_MS
  ) {
    notices.push({ kind: "ack", level: "warn" });
  }

  if (state.resolutionBreached) {
    notices.push({ kind: "res", level: "breach" });
  } else if (
    state.msToResolutionDue !== null &&
    state.msToResolutionDue > 0 &&
    state.msToResolutionDue <= RES_WARN_MS
  ) {
    notices.push({ kind: "res", level: "warn" });
  }

  return notices;
}

/**
 * Single background sweep for support SLA warnings/breaches, 28-day RESOLVED auto-close,
 * and T-72h / T-24h dispute deadlines. Collects row errors and reports to Sentry at most once.
 */
export async function runSupportSlaSweep(opts?: {
  limit?: number;
  now?: Date;
}): Promise<SupportSlaSweepResult> {
  return withCronLock("support-sla-sweep", { failMode: "open" }, async () => {
    const now = opts?.now ?? new Date();
    const limit = opts?.limit ?? 50;
    const errors: string[] = [];

    let scanned = 0;
    let slaNoticesStaged = 0;
    let orgEscalationEmailsSent = 0;
    let autoClosedCount = 0;
    let disputeNoticesStaged = 0;

    const ackWarnHorizon = new Date(now.getTime() + ACK_WARN_MS);
    const resWarnHorizon = new Date(now.getTime() + RES_WARN_MS);
    const orgInclude = {
      organization: {
        select: { name: true, escalationContactEmail: true },
      },
    } as const;

    const [operators, breachTickets, warnTickets, breachCases, warnCases] =
      await Promise.all([
        prisma.user.findMany({
          where: { role: { in: ["ADMIN", "STAFF"] } },
          select: { id: true, email: true, name: true, role: true },
        }),
        prisma.supportTicket.findMany({
          where: {
            status: { notIn: ["RESOLVED", "CLOSED"] },
            awaitingUserSince: null,
            OR: [
              { acknowledgedAt: null, ackDueAt: { lte: now } },
              { resolvedAt: null, resolutionDueAt: { lte: now } },
            ],
          },
          include: orgInclude,
          orderBy: [{ ackDueAt: "asc" }, { resolutionDueAt: "asc" }],
          take: limit,
        }),
        prisma.supportTicket.findMany({
          where: {
            status: { notIn: ["RESOLVED", "CLOSED"] },
            awaitingUserSince: null,
            OR: [
              {
                acknowledgedAt: null,
                ackDueAt: { gt: now, lte: ackWarnHorizon },
              },
              {
                resolvedAt: null,
                resolutionDueAt: { gt: now, lte: resWarnHorizon },
              },
            ],
          },
          include: orgInclude,
          orderBy: [{ ackDueAt: "asc" }, { resolutionDueAt: "asc" }],
          take: limit,
        }),
        prisma.supportCase.findMany({
          where: {
            status: { notIn: ["RESOLVED", "CLOSED"] },
            deletedAt: null,
            awaitingUserSince: null,
            OR: [
              { acknowledgedAt: null, ackDueAt: { lte: now } },
              { resolvedAt: null, resolutionDueAt: { lte: now } },
            ],
          },
          include: orgInclude,
          orderBy: [{ ackDueAt: "asc" }, { resolutionDueAt: "asc" }],
          take: limit,
        }),
        prisma.supportCase.findMany({
          where: {
            status: { notIn: ["RESOLVED", "CLOSED"] },
            deletedAt: null,
            awaitingUserSince: null,
            OR: [
              {
                acknowledgedAt: null,
                ackDueAt: { gt: now, lte: ackWarnHorizon },
              },
              {
                resolvedAt: null,
                resolutionDueAt: { gt: now, lte: resWarnHorizon },
              },
            ],
          },
          include: orgInclude,
          orderBy: [{ ackDueAt: "asc" }, { resolutionDueAt: "asc" }],
          take: limit,
        }),
      ]);

    const ticketMap = new Map<string, (typeof breachTickets)[number]>();
    for (const t of [...(breachTickets ?? []), ...(warnTickets ?? [])]) {
      if (!ticketMap.has(t.id)) ticketMap.set(t.id, t);
    }
    const caseMap = new Map<string, (typeof breachCases)[number]>();
    for (const c of [...(breachCases ?? []), ...(warnCases ?? [])]) {
      if (!caseMap.has(c.id)) caseMap.set(c.id, c);
    }

    const candidates = [
      ...[...ticketMap.values()].map((t) => ({
        id: t.id,
        referenceNumber: t.referenceNumber ?? t.id,
        title: t.title,
        status: t.status,
        assignedToId: t.assignedToId,
        ackDueAt: t.ackDueAt,
        acknowledgedAt: t.acknowledgedAt,
        resolutionDueAt: t.resolutionDueAt,
        resolvedAt: t.resolvedAt,
        awaitingUserSince: t.awaitingUserSince,
        pausedSeconds: t.pausedSeconds,
        escalationContactEmail: t.organization?.escalationContactEmail ?? null,
      })),
      ...[...caseMap.values()].map((c) => ({
        id: c.id,
        referenceNumber: c.referenceNumber,
        title: c.title,
        status: c.status,
        assignedToId: c.assignedToId,
        ackDueAt: c.ackDueAt,
        acknowledgedAt: c.acknowledgedAt,
        resolutionDueAt: c.resolutionDueAt,
        resolvedAt: c.resolvedAt,
        awaitingUserSince: c.awaitingUserSince,
        pausedSeconds: c.pausedSeconds,
        escalationContactEmail: c.organization?.escalationContactEmail ?? null,
      })),
    ];

    scanned += candidates.length;

    // Arm 1: SLA Warn & Breach Notices
    for (const row of candidates) {
      const notices = slaNoticeTransitions(row, now);
      if (notices.length === 0) continue;

      const targetOps = row.assignedToId
        ? operators.filter((o) => o.id === row.assignedToId)
        : operators;
      const effectiveOps = targetOps.length > 0 ? targetOps : operators;

      for (const notice of notices) {
        const dedupeKey = `sla:${row.id}:${notice.kind}:${notice.level}`;
        const label =
          notice.level === "breach" ? "SLA BREACHED" : "SLA Warning";
        const clockName =
          notice.kind === "ack" ? "Acknowledgement" : "Resolution";
        const subject = `[${label}] ${row.referenceNumber}: ${clockName} clock`;
        const escapedSubject = escapeHtml(subject);
        const escapedRef = escapeHtml(row.referenceNumber);
        const escapedTitle = escapeHtml(row.title);

        try {
          let newlyStaged = true;
          if (effectiveOps.length > 0) {
            const recipients = effectiveOps.map((o) => o.id);
            const payload = {
              ticketId: row.id,
              reference: row.referenceNumber,
              ticketTitle: row.title,
              activity: `sla-${notice.kind}-${notice.level}`,
              dashboardUrl: `${getAppUrl()}/dashboard/staff/support`,
            };
            const transactionId = deriveTransactionId(
              NOVU_WORKFLOWS.SUPPORT_TICKET_ACTIVITY,
              recipients,
              payload,
              dedupeKey,
            );

            newlyStaged = await prisma.$transaction(
              async (tx) => {
                const existing = await tx.notificationOutbox.findUnique({
                  where: { transactionId },
                  select: { id: true },
                });
                await stageBell(tx, {
                  workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_ACTIVITY,
                  recipients,
                  payload,
                  dedupeKey,
                });
                return !existing;
              },
              {
                maxWait: ALLOCATION_TX_MAX_WAIT_MS,
                timeout: ALLOCATION_TX_TIMEOUT_MS,
              },
            );
            if (newlyStaged) {
              slaNoticesStaged++;
            }
          }

          if (newlyStaged) {
            const emailJobs: Promise<unknown>[] = effectiveOps
              .filter((op): op is typeof op & { email: string } =>
                Boolean(op.email),
              )
              .map((op) =>
                deliver(
                  {
                    from: DEFAULT_FROM_ADDRESS,
                    to: op.email,
                    subject,
                    html: `<p>${escapedSubject} for support case <strong>${escapedRef}</strong> (${escapedTitle}).</p>`,
                  },
                  "support-sla-alert",
                  { entityRef: dedupeKey, budgetMs: EMAIL_BUDGET_MS.JOB },
                ),
              );

            if (row.escalationContactEmail) {
              emailJobs.push(
                deliver(
                  {
                    from: DEFAULT_FROM_ADDRESS,
                    to: row.escalationContactEmail,
                    subject,
                    html: `<p>${escapedSubject} for your organization's support request <strong>${escapedRef}</strong>.</p>`,
                  },
                  "support-sla-alert-org",
                  { entityRef: dedupeKey, budgetMs: EMAIL_BUDGET_MS.JOB },
                ).then((res) => {
                  orgEscalationEmailsSent++;
                  return res;
                }),
              );
            }

            const settled = await Promise.allSettled(emailJobs);
            for (const s of settled) {
              if (s.status === "rejected") {
                errors.push(
                  `sla-notice ${row.id} (${dedupeKey}): ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
                );
              }
            }
          }
        } catch (err) {
          errors.push(
            `sla-notice ${row.id} (${dedupeKey}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Arm 2: 28-Day Auto-Close of RESOLVED tickets and cases
    const autoCloseCutoff = new Date(now.getTime() - AUTO_CLOSE_DAYS_MS);
    const [staleResolvedTickets, staleResolvedCases] = await Promise.all([
      prisma.supportTicket.findMany({
        where: {
          status: "RESOLVED",
          resolvedAt: { lte: autoCloseCutoff },
        },
        select: { id: true },
        take: limit,
      }),
      prisma.supportCase.findMany({
        where: {
          status: "RESOLVED",
          resolvedAt: { lte: autoCloseCutoff },
          deletedAt: null,
        },
        select: { id: true },
        take: limit,
      }),
    ]);

    for (const t of staleResolvedTickets ?? []) {
      try {
        const closed = await prisma.$transaction(
          async (tx) => {
            const res = await tx.supportTicket.updateMany({
              where: {
                id: t.id,
                status: "RESOLVED",
                resolvedAt: { lte: autoCloseCutoff },
              },
              data: { status: "CLOSED", closedAt: now },
            });
            if (res.count > 0) {
              await tx.supportCaseEvent.create({
                data: {
                  legacyTicketId: t.id,
                  kind: "AUTO_CLOSED",
                  fromValue: "RESOLVED",
                  toValue: "CLOSED",
                  createdAt: now,
                },
              });
            }
            return res.count;
          },
          {
            maxWait: ALLOCATION_TX_MAX_WAIT_MS,
            timeout: ALLOCATION_TX_TIMEOUT_MS,
          },
        );
        autoClosedCount += closed;
      } catch (err) {
        errors.push(
          `auto-close ticket ${t.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    for (const c of staleResolvedCases ?? []) {
      try {
        const closed = await prisma.$transaction(
          async (tx) => {
            const res = await tx.supportCase.updateMany({
              where: {
                id: c.id,
                status: "RESOLVED",
                resolvedAt: { lte: autoCloseCutoff },
              },
              data: { status: "CLOSED", closedAt: now },
            });
            if (res.count > 0) {
              await tx.supportCaseEvent.create({
                data: {
                  caseId: c.id,
                  kind: "AUTO_CLOSED",
                  fromValue: "RESOLVED",
                  toValue: "CLOSED",
                  createdAt: now,
                },
              });
            }
            return res.count;
          },
          {
            maxWait: ALLOCATION_TX_MAX_WAIT_MS,
            timeout: ALLOCATION_TX_TIMEOUT_MS,
          },
        );
        autoClosedCount += closed;
      } catch (err) {
        errors.push(
          `auto-close case ${c.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Arm 3: Dispute Deadlines at T-72h and T-24h
    const disputeHorizon = new Date(now.getTime() + 72 * HOUR_MS);
    const actionableDisputes = await prisma.dispute.findMany({
      where: {
        status: { in: ["NEEDS_RESPONSE", "WARNING_NEEDS_RESPONSE"] },
        dueBy: { lte: disputeHorizon },
      },
      orderBy: { dueBy: "asc" },
      take: limit,
    });

    const admins = operators.filter((o) => o.role === "ADMIN");
    for (const d of actionableDisputes ?? []) {
      if (!d.dueBy) continue;
      const dueByIso = d.dueBy.toISOString();
      const msLeft = d.dueBy.getTime() - now.getTime();
      const window: "24" | "72" = msLeft <= 24 * HOUR_MS ? "24" : "72";
      const dedupeKey = `dispute-due:${d.id}:${window}`;
      const subject = `[Dispute Due T-${window}h] ${d.disputeId}`;
      const escapedDisputeId = escapeHtml(d.disputeId);

      try {
        if (admins.length > 0) {
          const recipients = admins.map((a) => a.id);
          const payload = {
            disputeId: d.disputeId,
            amount: d.amountPaise,
            currency: d.currency,
            reason: d.reason,
            dueBy: dueByIso,
            windowHours: Number(window),
          };
          const transactionId = deriveTransactionId(
            NOVU_WORKFLOWS.DISPUTE_CREATED,
            recipients,
            payload,
            dedupeKey,
          );

          const newlyStaged = await prisma.$transaction(
            async (tx) => {
              const existing = await tx.notificationOutbox.findUnique({
                where: { transactionId },
                select: { id: true },
              });
              await stageBell(tx, {
                workflowId: NOVU_WORKFLOWS.DISPUTE_CREATED,
                recipients,
                payload,
                dedupeKey,
              });
              return !existing;
            },
            {
              maxWait: ALLOCATION_TX_MAX_WAIT_MS,
              timeout: ALLOCATION_TX_TIMEOUT_MS,
            },
          );

          if (newlyStaged) {
            disputeNoticesStaged++;

            const settled = await Promise.allSettled(
              admins
                .filter((admin): admin is typeof admin & { email: string } =>
                  Boolean(admin.email),
                )
                .map((admin) =>
                  deliver(
                    {
                      from: DEFAULT_FROM_ADDRESS,
                      to: admin.email,
                      subject,
                      html: `<p>Dispute <strong>${escapedDisputeId}</strong> requires a response before ${dueByIso} (${window}h threshold).</p>`,
                    },
                    "dispute-deadline-alert",
                    { entityRef: dedupeKey, budgetMs: EMAIL_BUDGET_MS.JOB },
                  ),
                ),
            );
            for (const s of settled) {
              if (s.status === "rejected") {
                errors.push(
                  `dispute-due ${d.id} (${dedupeKey}): ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
                );
              }
            }
          }
        }
      } catch (err) {
        errors.push(
          `dispute-due ${d.id} (${dedupeKey}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (errors.length > 0) {
      reportSentryError(
        new Error(
          `support-sla-sweep completed with ${errors.length} error(s): ${errors[0]}`,
        ),
        {
          subsystem: "support",
          op: "support-sla-sweep",
          extra: {
            errorCount: errors.length,
            errors: errors.slice(0, 10),
          },
        },
      );
    }

    return {
      success: errors.length === 0,
      scanned,
      slaNoticesStaged,
      orgEscalationEmailsSent,
      autoClosedCount,
      disputeNoticesStaged,
      errors,
    };
  });
}

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

interface OperatorRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

interface SlaSweepCandidate {
  id: string;
  referenceNumber: string;
  title: string;
  status:
    "OPEN" | "IN_PROGRESS" | "ESCALATED" | "ON_HOLD" | "RESOLVED" | "CLOSED";
  assignedToId: string | null;
  ackDueAt: Date | null;
  acknowledgedAt: Date | null;
  resolutionDueAt: Date | null;
  resolvedAt: Date | null;
  awaitingUserSince: Date | null;
  pausedSeconds: number;
  escalationContactEmail: string | null;
}

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

function recordPayloadSlaBreach(
  payload: unknown,
  ackSet: Set<string>,
  resSet: Set<string>,
  stagedKeys: Set<string>,
): void {
  if (typeof payload !== "object" || payload === null) return;
  const ticketId =
    "ticketId" in payload && typeof payload.ticketId === "string"
      ? payload.ticketId
      : null;
  const activity =
    "activity" in payload && typeof payload.activity === "string"
      ? payload.activity
      : null;
  if (!ticketId) return;
  if (activity === "sla-ack-breach") {
    ackSet.add(ticketId);
    stagedKeys.add(`sla:${ticketId}:ack:breach`);
  } else if (activity === "sla-res-breach") {
    resSet.add(ticketId);
    stagedKeys.add(`sla:${ticketId}:res:breach`);
  }
}

function parseStagedSlaOutboxRows(
  rows: Array<{
    transactionId: string;
    entityRef?: string | null;
    payload?: unknown;
  }>,
): {
  ackBreachIds: string[];
  resBreachIds: string[];
  ackWarnIds: string[];
  resWarnIds: string[];
  stagedKeys: Set<string>;
} {
  const ackSet = new Set<string>();
  const resSet = new Set<string>();
  const ackWarnSet = new Set<string>();
  const resWarnSet = new Set<string>();
  const stagedKeys = new Set<string>();

  const recordKeyString = (raw: string | null | undefined) => {
    if (!raw) return;
    stagedKeys.add(raw);
    const match = /^sla:(.+):(ack|res):(warn|breach)$/.exec(raw);
    if (!match) return;
    if (match[3] === "breach") {
      if (match[2] === "ack") ackSet.add(match[1]);
      if (match[2] === "res") resSet.add(match[1]);
    } else if (match[3] === "warn") {
      if (match[2] === "ack") ackWarnSet.add(match[1]);
      if (match[2] === "res") resWarnSet.add(match[1]);
    }
  };

  for (const row of rows) {
    recordKeyString(row.transactionId);
    recordKeyString(row.entityRef);
    recordPayloadSlaBreach(row.payload, ackSet, resSet, stagedKeys);
  }

  return {
    ackBreachIds: [...ackSet],
    resBreachIds: [...resSet],
    ackWarnIds: [...ackWarnSet],
    resWarnIds: [...resWarnSet],
    stagedKeys,
  };
}

async function fetchSlaSweepCandidates(
  now: Date,
  limit: number,
  ackBreachIds: string[],
  resBreachIds: string[],
  ackWarnIds: string[] = [],
  resWarnIds: string[] = [],
): Promise<SlaSweepCandidate[]> {
  const ackWarnHorizon = new Date(now.getTime() + ACK_WARN_MS);
  const resWarnHorizon = new Date(now.getTime() + RES_WARN_MS);
  const orgInclude = {
    organization: {
      select: { name: true, escalationContactEmail: true },
    },
  } as const;

  const breachCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const breachOrFilter = [
    {
      acknowledgedAt: null,
      ackDueAt: { gte: breachCutoff, lte: now },
      ...(ackBreachIds.length > 0 ? { id: { notIn: ackBreachIds } } : {}),
    },
    {
      resolvedAt: null,
      resolutionDueAt: { gte: breachCutoff, lte: now },
      ...(resBreachIds.length > 0 ? { id: { notIn: resBreachIds } } : {}),
    },
  ];

  const warnOrFilter = [
    {
      acknowledgedAt: null,
      ackDueAt: { gt: now, lte: ackWarnHorizon },
      ...(ackWarnIds.length > 0 ? { id: { notIn: ackWarnIds } } : {}),
    },
    {
      resolvedAt: null,
      resolutionDueAt: { gt: now, lte: resWarnHorizon },
      ...(resWarnIds.length > 0 ? { id: { notIn: resWarnIds } } : {}),
    },
  ];

  const [breachTickets, warnTickets, breachCases, warnCases] =
    await Promise.all([
      prisma.supportTicket.findMany({
        where: {
          status: { notIn: ["RESOLVED", "CLOSED"] },
          awaitingUserSince: null,
          OR: breachOrFilter,
        },
        include: orgInclude,
        orderBy: [{ ackDueAt: "asc" }, { resolutionDueAt: "asc" }],
        take: limit,
      }),
      prisma.supportTicket.findMany({
        where: {
          status: { notIn: ["RESOLVED", "CLOSED"] },
          awaitingUserSince: null,
          OR: warnOrFilter,
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
          OR: breachOrFilter,
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
          OR: warnOrFilter,
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

  return [
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
}

async function deliverSlaNoticeEmails(
  row: SlaSweepCandidate,
  level: SlaNoticeLevel,
  effectiveOps: OperatorRow[],
  dedupeKey: string,
  subject: string,
  errors: string[],
): Promise<{ orgEscalationSent: boolean }> {
  const escapedSubject = escapeHtml(subject);
  const escapedRef = escapeHtml(row.referenceNumber);
  const escapedTitle = escapeHtml(row.title);

  let orgEscalationSent = false;
  const emailJobs: Promise<unknown>[] = effectiveOps
    .filter((op): op is OperatorRow & { email: string } => Boolean(op.email))
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

  if (level === "breach" && row.escalationContactEmail) {
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
        orgEscalationSent = true;
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

  return { orgEscalationSent };
}

async function processSingleSlaNotice(
  row: SlaSweepCandidate,
  notice: { kind: SlaNoticeKind; level: SlaNoticeLevel },
  effectiveOps: OperatorRow[],
  stagedKeys: Set<string>,
  errors: string[],
): Promise<{ staged: number; orgEmails: number }> {
  const dedupeKey = `sla:${row.id}:${notice.kind}:${notice.level}`;
  if (stagedKeys.has(dedupeKey)) {
    return { staged: 0, orgEmails: 0 };
  }

  const label = notice.level === "breach" ? "SLA BREACHED" : "SLA Warning";
  const clockName = notice.kind === "ack" ? "Acknowledgement" : "Resolution";
  const subject = `[${label}] ${row.referenceNumber}: ${clockName} clock`;

  try {
    let newlyStaged = true;
    let countedStaged = 0;

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
      if (stagedKeys.has(transactionId)) {
        return { staged: 0, orgEmails: 0 };
      }

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
            entityRef: dedupeKey,
          });
          return !existing;
        },
        {
          maxWait: ALLOCATION_TX_MAX_WAIT_MS,
          timeout: ALLOCATION_TX_TIMEOUT_MS,
        },
      );
      if (newlyStaged) {
        countedStaged = 1;
      }
    }

    if (!newlyStaged) {
      return { staged: 0, orgEmails: 0 };
    }

    const { orgEscalationSent } = await deliverSlaNoticeEmails(
      row,
      notice.level,
      effectiveOps,
      dedupeKey,
      subject,
      errors,
    );
    return {
      staged: countedStaged,
      orgEmails: orgEscalationSent ? 1 : 0,
    };
  } catch (err) {
    errors.push(
      `sla-notice ${row.id} (${dedupeKey}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { staged: 0, orgEmails: 0 };
  }
}

async function runSequential<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  async function step(index: number, acc: R[]): Promise<R[]> {
    if (index >= items.length) return acc;
    acc.push(await fn(items[index]));
    return step(index + 1, acc);
  }
  return step(0, []);
}

async function processCandidateSlaNotices(
  row: SlaSweepCandidate,
  now: Date,
  operators: OperatorRow[],
  stagedKeys: Set<string>,
  errors: string[],
): Promise<{ staged: number; orgEmails: number }> {
  const notices = slaNoticeTransitions(row, now);
  if (notices.length === 0) return { staged: 0, orgEmails: 0 };

  const targetOps = row.assignedToId
    ? operators.filter((o) => o.id === row.assignedToId)
    : operators;
  const effectiveOps = targetOps.length > 0 ? targetOps : operators;

  const outcomes = await runSequential(notices, (notice) =>
    processSingleSlaNotice(row, notice, effectiveOps, stagedKeys, errors),
  );

  return outcomes.reduce(
    (acc, cur) => ({
      staged: acc.staged + cur.staged,
      orgEmails: acc.orgEmails + cur.orgEmails,
    }),
    { staged: 0, orgEmails: 0 },
  );
}

async function autoCloseResolvedRows(
  now: Date,
  limit: number,
  errors: string[],
): Promise<number> {
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

  const ticketResults = await runSequential(
    staleResolvedTickets ?? [],
    async (t) => {
      try {
        return await prisma.$transaction(
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
              await tx.appointmentSupportThread.updateMany({
                where: { supportTicketId: t.id },
                data: { status: "CLOSED", activeChannel: "SELF_SERVE" },
              });
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
      } catch (err) {
        errors.push(
          `auto-close ticket ${t.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return 0;
      }
    },
  );

  const caseResults = await runSequential(
    staleResolvedCases ?? [],
    async (c) => {
      try {
        return await prisma.$transaction(
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
      } catch (err) {
        errors.push(
          `auto-close case ${c.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return 0;
      }
    },
  );

  return [...ticketResults, ...caseResults].reduce((sum, n) => sum + n, 0);
}

async function processDisputeDeadlineAlerts(
  now: Date,
  limit: number,
  admins: OperatorRow[],
  errors: string[],
): Promise<number> {
  const disputeHorizon = new Date(now.getTime() + 72 * HOUR_MS);
  const actionableDisputes = await prisma.dispute.findMany({
    where: {
      status: { in: ["NEEDS_RESPONSE", "WARNING_NEEDS_RESPONSE"] },
      dueBy: { lte: disputeHorizon },
    },
    orderBy: { dueBy: "asc" },
    take: limit,
  });

  if (admins.length === 0) return 0;
  const recipients = admins.map((a) => a.id);

  const stagedFlags = await runSequential(
    actionableDisputes ?? [],
    async (d) => {
      if (!d.dueBy) return 0;
      const dueByIso = d.dueBy.toISOString();
      const msLeft = d.dueBy.getTime() - now.getTime();
      const window: "24" | "72" = msLeft <= 24 * HOUR_MS ? "24" : "72";
      const dedupeKey = `dispute-due:${d.id}:${window}`;
      const subject = `[Dispute Due T-${window}h] ${d.disputeId}`;
      const escapedDisputeId = escapeHtml(d.disputeId);

      try {
        const payload = {
          title: `Dispute response due within ${window}h`,
          disputeId: d.disputeId,
          amount: d.amountPaise,
          currency: d.currency,
          reason: d.reason,
          dueBy: dueByIso,
          windowHours: Number(window),
        };
        const transactionId = deriveTransactionId(
          NOVU_WORKFLOWS.DISPUTE_UPDATED,
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
              workflowId: NOVU_WORKFLOWS.DISPUTE_UPDATED,
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

        if (!newlyStaged) return 0;

        const settled = await Promise.allSettled(
          admins
            .filter((admin): admin is OperatorRow & { email: string } =>
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
        return 1;
      } catch (err) {
        errors.push(
          `dispute-due ${d.id} (${dedupeKey}): ${err instanceof Error ? err.message : String(err)}`,
        );
        return 0;
      }
    },
  );

  return stagedFlags.reduce((sum: number, n: number) => sum + n, 0);
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

    const recentOutboxCutoff = new Date(now.getTime() - 35 * DAY_MS);
    const [operators, outboxRows] = await Promise.all([
      prisma.user.findMany({
        where: { role: { in: ["ADMIN", "STAFF"] } },
        select: { id: true, email: true, name: true, role: true },
      }),
      prisma.notificationOutbox
        .findMany({
          where: {
            workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_ACTIVITY,
            entityRef: { startsWith: "sla:" },
            createdAt: { gte: recentOutboxCutoff },
          },
          select: { transactionId: true, entityRef: true, payload: true },
          orderBy: { createdAt: "desc" },
          take: 5000,
        })
        .catch(() => []),
    ]);

    const { ackBreachIds, resBreachIds, ackWarnIds, resWarnIds, stagedKeys } =
      parseStagedSlaOutboxRows(outboxRows ?? []);

    const candidates = await fetchSlaSweepCandidates(
      now,
      limit,
      ackBreachIds.slice(0, 500),
      resBreachIds.slice(0, 500),
      ackWarnIds.slice(0, 500),
      resWarnIds.slice(0, 500),
    );

    const noticeOutcomes = await runSequential(candidates, (row) =>
      processCandidateSlaNotices(row, now, operators, stagedKeys, errors),
    );

    const slaNoticesStaged = noticeOutcomes.reduce(
      (sum, o) => sum + o.staged,
      0,
    );
    const orgEscalationEmailsSent = noticeOutcomes.reduce(
      (sum, o) => sum + o.orgEmails,
      0,
    );

    const autoClosedCount = await autoCloseResolvedRows(now, limit, errors);
    const admins = operators.filter((o) => o.role === "ADMIN");
    const disputeNoticesStaged = await processDisputeDeadlineAlerts(
      now,
      limit,
      admins,
      errors,
    );

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
      scanned: candidates.length,
      slaNoticesStaged,
      orgEscalationEmailsSent,
      autoClosedCount,
      disputeNoticesStaged,
      errors,
    };
  });
}

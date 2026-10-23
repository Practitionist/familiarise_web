import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
  type Tx,
} from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { stageBell } from "@/lib/novu/stage-bell";
import { deriveTransactionId, type StagedTrigger } from "@/lib/novu/outbox";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import { getAppUrl } from "@/lib/url";
import { DEFAULT_FROM_ADDRESS, deliver, EMAIL_BUDGET_MS } from "@/lib/email";
import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import { reportStandingFinding } from "@/lib/observability/standing-finding";
import { slaStateOf } from "./sla";
import {
  cascadeResolvedProblems,
  HELD_OPEN_SCAN_FACTOR,
} from "./problem-cascade";
import { purgeExpiredSupportEvidence } from "./evidence-retention";
import { sweepSupportChatAccess } from "./chat-sweep";
import { activeHolds, caseHoldEvents, releaseAllCaseHolds } from "./case-holds";
import { endCaseChatAccessTx } from "./chat-access-end";
import {
  moneyDoorsRefusal,
  openRecommendationTx,
  recordLifecycleHoldReleaseTx,
} from "./case-service";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const ACK_WARN_MS = 2 * HOUR_MS;
const RES_WARN_MS = 24 * HOUR_MS;
const AUTO_CLOSE_DAYS_MS = 28 * DAY_MS;
const DISPUTE_HORIZON_MS = 72 * HOUR_MS;
const DISPUTE_CRITICAL_MS = 12 * HOUR_MS;
// Past due by more than a day, earlier sweeps already fired both windows; the bound keeps those rows from filling the batch.
const DISPUTE_LOOKBACK_MS = DAY_MS;
// Open disputes due within the four-day window; far above any real backlog, it only bounds the read.
const DISPUTE_WINDOW_CAP = 500;
// Each cascaded incident stages its notices in its own transaction; keeps the arm inside the tick.
const PROBLEM_CASCADE_CAP = 10;
// Each purged case is a storage round trip plus a transaction.
const EVIDENCE_PURGE_CAP = 5;
// Each chat-access step is a Stream round trip or a short transaction per row.
const CHAT_ACCESS_CAP = 10;

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
  status: "OPEN" | "IN_PROGRESS" | "ESCALATED" | "RESOLVED" | "CLOSED";
  assignedToId: string | null;
  ackDueAt: Date | null;
  acknowledgedAt: Date | null;
  resolutionDueAt: Date | null;
  statutoryDueAt?: Date | null;
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
  incidentsCascaded: number;
  /** Incidents left open because releasing their payout holds was refused. */
  incidentsHeldOpen: number;
  evidenceCasesPurged: number;
  evidenceFilesDeleted: number;
  chatAccessEnded: number;
  chatInterventionsJoined: number;
  chatInterventionsLeft: number;
  /** Channels whose support lock was re-applied or cleared. */
  chatBoundariesSynced: number;
  chatReviewNotices: number;
  disputeNoticesStaged: number;
  errors: string[];
}

const DISPUTE_ALERT_EMAIL_TYPES = ["dispute-deadline-alert"];
const SLA_ALERT_EMAIL_TYPES = ["support-sla-alert", "support-sla-alert-org"];

// Staged alert emails (keyed by entityRef = the alert's dedupe key) outlive a bell the policy dropped.
async function alertEmailStaged(
  db: Pick<typeof prisma, "failedEmail">,
  entityRef: string,
  emailTypes: string[],
): Promise<{ id: string } | null> {
  return db.failedEmail.findFirst({
    where: { entityRef, emailType: { in: emailTypes } },
    select: { id: true },
  });
}

function slaNoticeTransitions(
  row: {
    status: "OPEN" | "IN_PROGRESS" | "ESCALATED" | "RESOLVED" | "CLOSED";
    ackDueAt: Date | null;
    acknowledgedAt: Date | null;
    resolutionDueAt: Date | null;
    statutoryDueAt?: Date | null;
    resolvedAt: Date | null;
    awaitingUserSince: Date | null;
    pausedSeconds: number;
  },
  now: Date,
): Array<{ kind: SlaNoticeKind; level: SlaNoticeLevel }> {
  const state = slaStateOf(row, now);

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

  const cases = await prisma.supportCase.findMany({
    where: {
      status: { notIn: ["RESOLVED", "CLOSED"] },
      deletedAt: null,
      OR: [
        ...breachOrFilter,
        ...warnOrFilter,
        {
          statutoryDueAt: { gte: breachCutoff, lte: now },
          resolvedAt: null,
          ...(resBreachIds.length ? { id: { notIn: resBreachIds } } : {}),
        },
        {
          statutoryDueAt: { gt: now, lte: resWarnHorizon },
          resolvedAt: null,
          ...(resWarnIds.length ? { id: { notIn: resWarnIds } } : {}),
        },
      ],
    },
    include: orgInclude,
    orderBy: [
      { statutoryDueAt: { sort: "asc", nulls: "last" } },
      { ackDueAt: "asc" },
    ],
    take: limit,
  });
  return cases.map((c) => ({
    id: c.id,
    referenceNumber: c.referenceNumber,
    title: c.title,
    status: c.status,
    assignedToId: c.assignedToId,
    ackDueAt: c.ackDueAt,
    acknowledgedAt: c.acknowledgedAt,
    resolutionDueAt: c.resolutionDueAt,
    statutoryDueAt: c.statutoryDueAt,
    resolvedAt: c.resolvedAt,
    awaitingUserSince: c.awaitingUserSince,
    pausedSeconds: c.pausedSeconds,
    escalationContactEmail:
      c.ownershipScope === "PERSONAL"
        ? null
        : (c.organization?.escalationContactEmail ?? null),
  }));
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
  stagedBells: StagedTrigger[],
): Promise<{ staged: number; orgEmails: number }> {
  const dedupeKey = `sla:${row.id}:${notice.kind}:${notice.level}`;
  if (stagedKeys.has(dedupeKey)) {
    return { staged: 0, orgEmails: 0 };
  }

  const label = notice.level === "breach" ? "SLA BREACHED" : "SLA Warning";
  const clockName = notice.kind === "ack" ? "Acknowledgement" : "Resolution";
  const subject = `[${label}] ${row.referenceNumber}: ${clockName} clock`;

  try {
    // The email row is the durable marker when every bell is off and no outbox row exists.
    if (await alertEmailStaged(prisma, dedupeKey, SLA_ALERT_EMAIL_TYPES)) {
      return { staged: 0, orgEmails: 0 };
    }
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

      const txResult = await prisma.$transaction(
        async (tx) => {
          const existing = await tx.notificationOutbox.findUnique({
            where: { transactionId },
            select: { id: true },
          });
          const rowOutbox = await stageBell(tx, {
            workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_ACTIVITY,
            recipients,
            payload,
            dedupeKey,
            entityRef: dedupeKey,
          });
          return { newlyStaged: !existing, rowOutbox };
        },
        {
          maxWait: ALLOCATION_TX_MAX_WAIT_MS,
          timeout: ALLOCATION_TX_TIMEOUT_MS,
        },
      );
      newlyStaged = txResult.newlyStaged;
      if (newlyStaged) {
        countedStaged = 1;
        if (txResult.rowOutbox) {
          stagedBells.push(txResult.rowOutbox);
        }
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
  stagedBells: StagedTrigger[],
): Promise<{ staged: number; orgEmails: number }> {
  const notices = slaNoticeTransitions(row, now);
  if (notices.length === 0) return { staged: 0, orgEmails: 0 };

  const targetOps = row.assignedToId
    ? operators.filter((o) => o.id === row.assignedToId)
    : operators;
  const effectiveOps = targetOps.length > 0 ? targetOps : operators;

  const outcomes = await runSequential(notices, (notice) =>
    processSingleSlaNotice(
      row,
      notice,
      effectiveOps,
      stagedKeys,
      errors,
      stagedBells,
    ),
  );

  return outcomes.reduce(
    (acc, cur) => ({
      staged: acc.staged + cur.staged,
      orgEmails: acc.orgEmails + cur.orgEmails,
    }),
    { staged: 0, orgEmails: 0 },
  );
}

/** No human acts on an auto-close, so the system releases the case's payout holds and ends its chat grants without step-up. */
async function releaseAutoClosedCaseTx(tx: Tx, caseId: string, now: Date) {
  const note = "Released when the case was auto-closed";
  await recordLifecycleHoldReleaseTx(tx, {
    caseId,
    actorId: null,
    actorRole: "SYSTEM",
    status: "CLOSED",
    reason: note,
    released: await releaseAllCaseHolds(tx, { caseId, actorId: null, note }),
  });
  // The chat arm later in this run clears Familiarise Support from any grant still seated.
  await endCaseChatAccessTx(tx, {
    caseId,
    actorId: null,
    reason: "CASE_RESOLVED",
    now,
  });
}

/**
 * Why a case holding payouts may not auto-close yet: an undecided refund
 * recommendation or closed money doors. The doors gate is read lazily.
 */
async function autoCloseRefusalTx(
  tx: Tx,
  caseId: string,
  doors: () => Promise<string | null>,
): Promise<string | null> {
  const held = activeHolds(await caseHoldEvents(tx, [caseId]));
  if (held.length === 0) return null;
  if (await openRecommendationTx(tx, caseId)) return "RECOMMENDATION_OPEN";
  return doors();
}

async function autoCloseResolvedRows(
  now: Date,
  limit: number,
  errors: string[],
): Promise<number> {
  const autoCloseCutoff = new Date(now.getTime() - AUTO_CLOSE_DAYS_MS);
  let gate: Promise<string | null> | undefined;
  const doors = () =>
    (gate ??= moneyDoorsRefusal().then((refusal) => refusal?.code ?? null));
  const staleResolvedCases = await prisma.supportCase.findMany({
    where: {
      status: "RESOLVED",
      resolvedAt: { lte: autoCloseCutoff },
      deletedAt: null,
    },
    orderBy: { resolvedAt: "asc" },
    select: { id: true },
    take: limit * HELD_OPEN_SCAN_FACTOR,
  });

  const closeOne = async (c: { id: string }): Promise<number> => {
    try {
      const closed = await prisma.$transaction(
        async (tx) => {
          const refused = await autoCloseRefusalTx(tx, c.id, doors);
          if (refused) return refused;
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
            await releaseAutoClosedCaseTx(tx, c.id, now);
          }
          return res.count;
        },
        {
          maxWait: ALLOCATION_TX_MAX_WAIT_MS,
          timeout: ALLOCATION_TX_TIMEOUT_MS,
        },
      );
      if (typeof closed === "number") return closed;
      errors.push(`auto-close case ${c.id}: left RESOLVED (${closed})`);
      return 0;
    } catch (err) {
      errors.push(
        `auto-close case ${c.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  };

  // Sequential, and stops at `limit` closes: refused held cases never crowd out closable ones.
  let closedCount = 0;
  for (const c of staleResolvedCases ?? []) {
    if (closedCount >= limit) break;
    closedCount += await closeOne(c);
  }
  return closedCount;
}

/** One page per run for disputes due within 12 h or already past due; new ids re-page, repeats stay quiet for 24 h. */
async function pageCriticalDisputeDeadlines(
  now: Date,
  disputes: { id: string; disputeId: string; dueBy: Date | null }[],
  errors: string[],
): Promise<void> {
  const critical = disputes.filter(
    (d) => d.dueBy && d.dueBy.getTime() - now.getTime() <= DISPUTE_CRITICAL_MS,
  );
  if (critical.length === 0) return;
  const message = `${critical.length} dispute(s) due within 12 h or past due with no response`;
  try {
    await reportStandingFinding(
      {
        key: "dispute-deadline:critical",
        ids: critical.map((d) => d.id),
        message,
      },
      () =>
        reportSentryMessage(message, {
          subsystem: "payments",
          op: "dispute-deadline-critical",
          level: "error",
          extra: {
            disputes: critical.map((d) => ({
              id: d.id,
              disputeId: d.disputeId,
              dueBy: d.dueBy?.toISOString(),
            })),
          },
        }),
    );
  } catch (err) {
    errors.push(
      `dispute-deadline critical page: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

type DisputeAlertPair = {
  d: {
    id: string;
    disputeId: string;
    amountPaise: number;
    currency: string;
    reason: string;
  };
  dueBy: Date;
  window: "24" | "72";
  dedupeKey: string;
};

async function stageDisputeDeadlineAlert(
  { d, dueBy, window, dedupeKey }: DisputeAlertPair,
  admins: OperatorRow[],
  errors: string[],
  stagedBells: StagedTrigger[],
): Promise<number> {
  const recipients = admins.map((admin) => admin.id);

  const dueByIso = dueBy.toISOString();
  const subject = `[Dispute Due T-${window}h] ${d.disputeId}`;
  const escapedDisputeId = escapeHtml(d.disputeId);

  try {
    const payload = {
      title: `Dispute ${d.disputeId} response due within ${window}h (by ${dueByIso})`,
      disputeId: d.disputeId,
      amount: d.amountPaise,
      currency: d.currency,
      reason: d.reason,
      dueBy: dueByIso,
      windowHours: Number(window),
      dashboardUrl: `${getAppUrl()}/dashboard/admin/disputes/${d.id}`,
    };

    const txResult = await prisma.$transaction(
      async (tx) => {
        const existing =
          (await tx.notificationOutbox.findFirst({
            where: {
              workflowId: NOVU_WORKFLOWS.DISPUTE_UPDATED,
              entityRef: dedupeKey,
            },
            select: { id: true },
          })) ??
          (await alertEmailStaged(tx, dedupeKey, DISPUTE_ALERT_EMAIL_TYPES));
        const rowOutbox = await stageBell(tx, {
          workflowId: NOVU_WORKFLOWS.DISPUTE_UPDATED,
          recipients,
          payload,
          dedupeKey,
          entityRef: dedupeKey,
        });
        return { newlyStaged: !existing, rowOutbox };
      },
      {
        maxWait: ALLOCATION_TX_MAX_WAIT_MS,
        timeout: ALLOCATION_TX_TIMEOUT_MS,
      },
    );

    if (!txResult.newlyStaged) return 0;
    if (txResult.rowOutbox) {
      stagedBells.push(txResult.rowOutbox);
    }

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
}

async function processDisputeDeadlineAlerts(
  now: Date,
  limit: number,
  admins: OperatorRow[],
  errors: string[],
  stagedBells: StagedTrigger[],
): Promise<number> {
  // The whole window, so the page and the unsent-pair filter see every dispute; `limit` caps only the sends.
  const actionableDisputes =
    (await prisma.dispute.findMany({
      where: {
        status: { in: ["NEEDS_RESPONSE", "WARNING_NEEDS_RESPONSE"] },
        dueBy: {
          gte: new Date(now.getTime() - DISPUTE_LOOKBACK_MS),
          lte: new Date(now.getTime() + DISPUTE_HORIZON_MS),
        },
      },
      orderBy: { dueBy: "asc" },
      take: DISPUTE_WINDOW_CAP,
    })) ?? [];

  await pageCriticalDisputeDeadlines(now, actionableDisputes, errors);

  if (admins.length === 0) return 0;

  const pairs = actionableDisputes.flatMap((d) => {
    if (!d.dueBy) return [];
    const window: "24" | "72" =
      d.dueBy.getTime() - now.getTime() <= 24 * HOUR_MS ? "24" : "72";
    const dedupeKey = `dispute-due:${d.id}:${window}`;
    return [{ d, dueBy: d.dueBy, window, dedupeKey }];
  });
  // Matched on entityRef, not transactionId: stageBell derives the id from the policy-filtered admins.
  const alreadyStaged = new Set(
    (
      (await prisma.notificationOutbox.findMany({
        where: {
          workflowId: NOVU_WORKFLOWS.DISPUTE_UPDATED,
          entityRef: { in: pairs.map((p) => p.dedupeKey) },
        },
        select: { entityRef: true },
      })) ?? []
    ).map((r) => r.entityRef),
  );
  const emailStaged = new Set(
    (
      (await prisma.failedEmail.findMany({
        where: {
          emailType: { in: DISPUTE_ALERT_EMAIL_TYPES },
          entityRef: { in: pairs.map((p) => p.dedupeKey) },
        },
        select: { entityRef: true },
      })) ?? []
    ).map((r) => r.entityRef),
  );
  const unsent = pairs
    .filter((p) => !alreadyStaged.has(p.dedupeKey))
    .filter((p) => !emailStaged.has(p.dedupeKey))
    .slice(0, limit);

  const stagedFlags = await runSequential(unsent, (pair) =>
    stageDisputeDeadlineAlert(pair, admins, errors, stagedBells),
  );

  return stagedFlags.reduce((sum: number, n: number) => sum + n, 0);
}

function moderationNoticeLevel(dueAt: Date | null, now: Date): SlaNoticeLevel {
  if (dueAt && dueAt <= now) return "breach";
  return "warn";
}

function moderationDeadlineIds(
  notices: { entityRef: string | null }[],
  level: "warn" | "breach",
): string[] {
  return notices.flatMap((notice) =>
    notice.entityRef?.endsWith(`:${level}`)
      ? [
          notice.entityRef.slice(
            "moderation-deadline:".length,
            -`:${level}`.length,
          ),
        ]
      : [],
  );
}

/**
 * Single background sweep for support SLA warnings/breaches, 28-day RESOLVED auto-close,
 * resolved-problem incident cascade, 180-day evidence purge, chat-access expiry,
 * Stream join/leave retries and post-decision review notices,
 * T-72h / T-24h dispute deadlines and one page for disputes due within 12 h or past due.
 * Collects row errors and reports to Sentry at most once.
 */
export async function runSupportSlaSweep(opts?: {
  limit?: number;
  now?: Date;
}): Promise<SupportSlaSweepResult> {
  return withCronLock("support-sla-sweep", { failMode: "open" }, async () => {
    const now = opts?.now ?? new Date();
    const limit = opts?.limit ?? 50;
    const errors: string[] = [];
    const stagedBells: StagedTrigger[] = [];

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
      processCandidateSlaNotices(
        row,
        now,
        operators,
        stagedKeys,
        errors,
        stagedBells,
      ),
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
    const cascade = await cascadeResolvedProblems({
      limit: Math.min(limit, PROBLEM_CASCADE_CAP),
      now,
      errors,
    });
    stagedBells.push(...cascade.bells);
    const evidencePurge = await purgeExpiredSupportEvidence({
      limit: Math.min(limit, EVIDENCE_PURGE_CAP),
      now,
      errors,
    });
    const chatAccess = await sweepSupportChatAccess({
      limit: Math.min(limit, CHAT_ACCESS_CAP),
      now,
      errors,
      stagedBells,
    });
    const admins = operators.filter((o) => o.role === "ADMIN");
    const disputeNoticesStaged = await processDisputeDeadlineAlerts(
      now,
      limit,
      admins,
      errors,
      stagedBells,
    );

    const noticeCutoff = new Date(now.getTime() - 30 * DAY_MS);
    const moderationNotices = await prisma.notificationOutbox.findMany({
      where: {
        entityRef: { startsWith: "moderation-deadline:" },
        createdAt: { gte: noticeCutoff },
      },
      select: { entityRef: true },
    });
    const pendingReports = await prisma.moderationReport.findMany({
      where: {
        status: { in: ["PENDING", "UNDER_REVIEW", "ESCALATED"] },
        OR: [
          {
            resolutionDueAt: { gte: noticeCutoff, lte: now },
            id: { notIn: moderationDeadlineIds(moderationNotices, "breach") },
          },
          {
            resolutionDueAt: {
              gt: now,
              lte: new Date(now.getTime() + RES_WARN_MS),
            },
            id: { notIn: moderationDeadlineIds(moderationNotices, "warn") },
          },
        ],
      },
      orderBy: { resolutionDueAt: "asc" },
      take: limit,
      select: { id: true, assignedToId: true, resolutionDueAt: true },
    });
    // Bound database writes to one leased invocation; each notice commits before the next.
    for (const report of pendingReports) {
      const level = moderationNoticeLevel(report.resolutionDueAt, now);
      try {
        await prisma.$transaction(async (tx) => {
          const notice = await stageBell(tx, {
            workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
            recipients: report.assignedToId
              ? [report.assignedToId]
              : operators.map((operator) => operator.id),
            dedupeKey: `moderation-deadline:${report.id}:${level}`,
            entityRef: `moderation-deadline:${report.id}:${level}`,
            payload: {
              ticketId: report.id,
              ...notificationScope(null),
              ticketTitle: "Moderation deadline",
              status:
                level === "breach"
                  ? "Moderation deadline breached"
                  : "Moderation deadline approaching",
              dashboardUrl: "/dashboard",
            },
          });
          if (notice) stagedBells.push(notice);
        });
      } catch (error) {
        errors.push(
          `moderation-deadline ${report.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const evidenceNotices = await prisma.notificationOutbox.findMany({
      where: {
        entityRef: { startsWith: "evidence-overdue:" },
        createdAt: { gte: noticeCutoff },
      },
      select: { entityRef: true },
    });
    const notifiedEvidenceIds = evidenceNotices.flatMap((notice) =>
      notice.entityRef
        ? [notice.entityRef.slice("evidence-overdue:".length)]
        : [],
    );
    const overdueEvidence = await prisma.supportCaseEvidenceRequest.findMany({
      where: {
        id: { notIn: notifiedEvidenceIds },
        dueAt: { gte: noticeCutoff, lte: now },
        respondedAt: null,
        cancelledAt: null,
        supportCase: { resolvedAt: null, deletedAt: null },
      },
      take: limit,
      orderBy: { dueAt: "asc" },
      select: { id: true, requestedById: true, caseId: true },
    });
    // Keep the single-connection transaction work sequential.
    for (const evidence of overdueEvidence) {
      try {
        await prisma.$transaction(async (tx) => {
          const staged = await stageBell(tx, {
            workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
            recipients: [evidence.requestedById],
            dedupeKey: `evidence-overdue:${evidence.id}`,
            entityRef: `evidence-overdue:${evidence.id}`,
            payload: {
              ticketId: evidence.caseId,
              ...notificationScope(null),
              ticketTitle: "Evidence response overdue",
              status: "Review overdue evidence request",
              dashboardUrl: `/dashboard/support/c_${evidence.caseId}`,
            },
          });
          if (staged) stagedBells.push(staged);
        });
      } catch (error) {
        errors.push(
          `evidence-overdue ${evidence.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await flushNotificationsAfter(
      {
        bells: stagedBells,
        emails: [{ rows: cascade.emails, emailType: "SUPPORT_TICKET_UPDATE" }],
      },
      "support.sla-sweep",
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
      incidentsCascaded: cascade.cascaded,
      incidentsHeldOpen: cascade.heldOpen.length,
      evidenceCasesPurged: evidencePurge.casesPurged,
      evidenceFilesDeleted: evidencePurge.filesDeleted,
      chatAccessEnded: chatAccess.ended,
      chatInterventionsJoined: chatAccess.joined,
      chatInterventionsLeft: chatAccess.left,
      chatBoundariesSynced: chatAccess.boundaries,
      chatReviewNotices: chatAccess.notices,
      disputeNoticesStaged,
      errors,
    };
  });
}

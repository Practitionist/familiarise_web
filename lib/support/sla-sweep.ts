import type { Prisma } from "@prisma/client";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
  type Tx,
  type PrismaLike,
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
  CASCADE_INCIDENT_WHERE,
  cascadeResolvedProblems,
  HELD_OPEN_SCAN_FACTOR,
} from "./problem-cascade";
import {
  LIVE_DISPUTE_WHERE,
  purgeEligibleWhere,
  purgeExpiredSupportEvidence,
} from "./evidence-retention";
import { hasChatAccessWork, sweepSupportChatAccess } from "./chat-sweep";
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
const AUTO_CLOSE_START_BUDGET_MS = 16_000;
const AUTO_CLOSE_HOLD_SAMPLE_LIMIT = 10;
const DISPUTE_HORIZON_MS = 72 * HOUR_MS;
const DISPUTE_CRITICAL_MS = 12 * HOUR_MS;
const DISPUTE_PAGE_WINDOW_MS = 7 * 24 * HOUR_MS;
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
// One run reads at most SLA_SCAN_PAGE_CAP pages of SLA_SCAN_PAGE_SIZE candidates, from the lowest id.
const SLA_SCAN_PAGE_SIZE = 200;
const SLA_SCAN_PAGE_CAP = 10;

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
  reopenedAt: Date | null;
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
  autoCloseHeldOpen: number;
  autoCloseHolds: Array<{ caseId: string; reason: string }>;
  autoCloseHasMore: boolean;
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
    reopenedAt: Date | null;
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

/** Dedupe keys already staged: an outbox row's transaction id and entity ref. */
function stagedSlaKeys(
  rows: Array<{ transactionId: string; entityRef?: string | null }>,
): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    keys.add(row.transactionId);
    if (row.entityRef) keys.add(row.entityRef);
  }
  return keys;
}

/** A notice is keyed by the deadline it was raised for, so a restarted or tightened deadline is noticed again. */
function slaNoticeKey(
  row: Pick<
    SlaSweepCandidate,
    "id" | "ackDueAt" | "resolutionDueAt" | "statutoryDueAt"
  >,
  notice: { kind: SlaNoticeKind; level: SlaNoticeLevel },
): string {
  const due =
    notice.kind === "ack"
      ? row.ackDueAt
      : (row.resolutionDueAt ?? row.statutoryDueAt ?? null);
  return `sla:${row.id}:${notice.kind}:${notice.level}:${due ? due.getTime() : "none"}`;
}

/**
 * Open cases inside an SLA warn or breach window. A case awaiting the user is paused,
 * so only its statutory deadline (which never pauses) can newly fire.
 */
function slaNoticeCaseWhere(now: Date): Prisma.SupportCaseWhereInput {
  const ackWarnHorizon = new Date(now.getTime() + ACK_WARN_MS);
  const resWarnHorizon = new Date(now.getTime() + RES_WARN_MS);
  const breachCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return {
    status: { notIn: ["RESOLVED", "CLOSED"] },
    deletedAt: null,
    OR: [
      {
        acknowledgedAt: null,
        ackDueAt: { gte: breachCutoff, lte: ackWarnHorizon },
      },
      {
        resolvedAt: null,
        awaitingUserSince: null,
        resolutionDueAt: { gte: breachCutoff, lte: resWarnHorizon },
      },
      {
        resolvedAt: null,
        statutoryDueAt: { gte: breachCutoff, lte: resWarnHorizon },
      },
    ],
  };
}

async function fetchSlaSweepCandidates(
  now: Date,
  limit: number,
  afterId: string | null,
): Promise<SlaSweepCandidate[]> {
  const cases = await prisma.supportCase.findMany({
    where: afterId
      ? { AND: [slaNoticeCaseWhere(now), { id: { gt: afterId } }] }
      : slaNoticeCaseWhere(now),
    include: {
      organization: { select: { name: true, escalationContactEmail: true } },
    },
    orderBy: { id: "asc" },
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
    reopenedAt: c.reopenedAt,
    awaitingUserSince: c.awaitingUserSince,
    pausedSeconds: c.pausedSeconds,
    escalationContactEmail:
      c.ownershipScope === "PERSONAL"
        ? null
        : (c.organization?.escalationContactEmail ?? null),
  }));
}

/**
 * Pages candidates by id until `limit` notices are staged, the candidates run out, the
 * start budget is spent or the page cap is reached. Every run starts from the lowest id.
 */
async function stageSlaNotices(
  now: Date,
  limit: number,
  startedAt: number,
  operators: OperatorRow[],
  stagedKeys: Set<string>,
  errors: string[],
  stagedBells: StagedTrigger[],
): Promise<{ scanned: number; staged: number; orgEmails: number }> {
  const out = { scanned: 0, staged: 0, orgEmails: 0 };
  let afterId: string | null = null;
  for (let page = 0; page < SLA_SCAN_PAGE_CAP; page++) {
    if (Date.now() - startedAt >= AUTO_CLOSE_START_BUDGET_MS) break;
    const rows = await fetchSlaSweepCandidates(
      now,
      SLA_SCAN_PAGE_SIZE,
      afterId,
    );
    out.scanned += rows.length;
    for (const row of rows) {
      if (out.staged >= limit) return out;
      const r = await processCandidateSlaNotices(
        row,
        now,
        operators,
        stagedKeys,
        errors,
        stagedBells,
      );
      out.staged += r.staged;
      out.orgEmails += r.orgEmails;
    }
    if (rows.length < SLA_SCAN_PAGE_SIZE) break;
    afterId = rows[rows.length - 1].id;
  }
  return out;
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
          html: `<p>${escapedSubject} for your organization's support case <strong>${escapedRef}</strong>.</p>`,
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
  const dedupeKey = slaNoticeKey(row, notice);
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

type AutoCloseResult = Pick<
  SupportSlaSweepResult,
  | "autoClosedCount"
  | "autoCloseHeldOpen"
  | "autoCloseHolds"
  | "autoCloseHasMore"
>;

async function attemptAutoCloseCase(
  c: {
    id: string;
    autoCloseLastAttemptAt: Date | null;
    updatedAt: Date;
  },
  now: Date,
  autoCloseCutoff: Date,
  doors: () => Promise<string | null>,
): Promise<number | string> {
  // Polling progress must advance without resetting the case's business clocks.
  const attemptedAt = new Date(
    Math.max(Date.now(), (c.autoCloseLastAttemptAt?.getTime() ?? 0) + 1),
  );
  const stamped = await prisma.supportCase.updateMany({
    where: {
      id: c.id,
      status: "RESOLVED",
      resolvedAt: { lte: autoCloseCutoff },
      deletedAt: null,
      autoCloseLastAttemptAt: c.autoCloseLastAttemptAt,
      updatedAt: c.updatedAt,
    },
    data: { autoCloseLastAttemptAt: attemptedAt, updatedAt: c.updatedAt },
  });
  if (stamped.count === 0) return 0;
  return prisma.$transaction(
    async (tx) => {
      const refused = await autoCloseRefusalTx(tx, c.id, doors);
      if (refused) return refused;
      const res = await tx.supportCase.updateMany({
        where: {
          id: c.id,
          status: "RESOLVED",
          resolvedAt: { lte: autoCloseCutoff },
          deletedAt: null,
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
}

function recordAutoCloseRefusal(
  result: AutoCloseResult,
  caseId: string,
  reason: string,
  errors: string[],
) {
  result.autoCloseHasMore = true;
  if (reason !== "RECOMMENDATION_OPEN" && reason !== "MAINTENANCE") {
    errors.push(`auto-close case ${caseId}: left RESOLVED (${reason})`);
    return;
  }
  result.autoCloseHeldOpen++;
  if (result.autoCloseHolds.length < AUTO_CLOSE_HOLD_SAMPLE_LIMIT)
    result.autoCloseHolds.push({ caseId, reason });
}

/** RESOLVED cases past the auto-close window. */
function autoCloseWhere(now: Date): Prisma.SupportCaseWhereInput {
  return {
    status: "RESOLVED",
    resolvedAt: { lte: new Date(now.getTime() - AUTO_CLOSE_DAYS_MS) },
    deletedAt: null,
  };
}

async function autoCloseResolvedRows(
  now: Date,
  limit: number,
  errors: string[],
  startedAt: number,
): Promise<AutoCloseResult> {
  const result: AutoCloseResult = {
    autoClosedCount: 0,
    autoCloseHeldOpen: 0,
    autoCloseHolds: [],
    autoCloseHasMore: false,
  };
  const timedOut = () => Date.now() - startedAt >= AUTO_CLOSE_START_BUDGET_MS;
  if (timedOut()) return { ...result, autoCloseHasMore: true };
  const autoCloseCutoff = new Date(now.getTime() - AUTO_CLOSE_DAYS_MS);
  let gate: Promise<string | null> | undefined;
  const doors = () =>
    (gate ??= moneyDoorsRefusal().then((refusal) => refusal?.code ?? null));
  const readCap = limit * HELD_OPEN_SCAN_FACTOR;
  const staleResolvedCases = await prisma.supportCase.findMany({
    where: autoCloseWhere(now),
    orderBy: [
      { autoCloseLastAttemptAt: { sort: "asc", nulls: "first" } },
      { resolvedAt: "asc" },
      { id: "asc" },
    ],
    select: { id: true, autoCloseLastAttemptAt: true, updatedAt: true },
    take: readCap,
  });
  let examined = 0;
  // Each attempt commits progress before the next budget admission check.
  for (const c of staleResolvedCases ?? []) {
    if (result.autoClosedCount >= limit || timedOut()) break;
    examined++;
    try {
      const closed = await attemptAutoCloseCase(c, now, autoCloseCutoff, doors);
      if (typeof closed === "number") {
        result.autoClosedCount += closed;
        result.autoCloseHasMore ||= closed === 0;
        continue;
      }
      recordAutoCloseRefusal(result, c.id, closed, errors);
    } catch (err) {
      result.autoCloseHasMore = true;
      errors.push(
        `auto-close case ${c.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  result.autoCloseHasMore ||=
    staleResolvedCases.length === readCap ||
    examined < staleResolvedCases.length;
  return result;
}

/**
 * A money exception: one Sentry warning per run that holds a dispute not paged
 * before. The window outlives the sweep's 36 h critical span, so each dispute pages once.
 */
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
        windowMs: DISPUTE_PAGE_WINDOW_MS,
      },
      () =>
        reportSentryMessage(message, {
          subsystem: "payments",
          op: "dispute-deadline-critical",
          level: "warning",
          fingerprint: ["payments", "dispute-deadline-critical"],
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

/** Disputes needing a response whose deadline sits inside the alert window. */
function disputeDeadlineWhere(now: Date): Prisma.DisputeWhereInput {
  return {
    status: { in: ["NEEDS_RESPONSE", "WARNING_NEEDS_RESPONSE"] },
    dueBy: {
      gte: new Date(now.getTime() - DISPUTE_LOOKBACK_MS),
      lte: new Date(now.getTime() + DISPUTE_HORIZON_MS),
    },
  };
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
      where: disputeDeadlineWhere(now),
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

/** Moderation reports in their deadline window, minus reports already noticed at that level. */
function moderationDeadlineWhere(
  now: Date,
  breachNoticedIds: string[] = [],
  warnNoticedIds: string[] = [],
): Prisma.ModerationReportWhereInput {
  return {
    status: { in: ["PENDING", "UNDER_REVIEW", "ESCALATED"] },
    OR: [
      {
        resolutionDueAt: { gte: noticeCutoffOf(now), lte: now },
        id: { notIn: breachNoticedIds },
      },
      {
        resolutionDueAt: {
          gt: now,
          lte: new Date(now.getTime() + RES_WARN_MS),
        },
        id: { notIn: warnNoticedIds },
      },
    ],
  };
}

/** Overdue, unanswered evidence requests on open cases, minus requests already noticed. */
function overdueEvidenceWhere(
  now: Date,
  noticedIds: string[] = [],
): Prisma.SupportCaseEvidenceRequestWhereInput {
  return {
    id: { notIn: noticedIds },
    dueAt: { gte: noticeCutoffOf(now), lte: now },
    respondedAt: null,
    cancelledAt: null,
    supportCase: { resolvedAt: null, deletedAt: null },
  };
}

function noticeCutoffOf(now: Date): Date {
  return new Date(now.getTime() - 30 * DAY_MS);
}

/**
 * Ticker idle probe over every row-driven arm, with already-noticed exclusions
 * dropped; any live dispute counts, since enough of them make the evidence purge report.
 */
export async function hasSupportSlaSweepWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const supportCase = await db.supportCase.findFirst({
    where: {
      OR: [
        slaNoticeCaseWhere(now),
        autoCloseWhere(now),
        CASCADE_INCIDENT_WHERE,
        purgeEligibleWhere(now),
      ],
    },
    select: { id: true },
  });
  if (supportCase) return true;
  if (outOfTime()) return true;
  if (await hasChatAccessWork(db, now)) return true;
  if (outOfTime()) return true;
  const dispute = await db.dispute.findFirst({
    where: { OR: [disputeDeadlineWhere(now), LIVE_DISPUTE_WHERE] },
    select: { id: true },
  });
  if (dispute) return true;
  if (outOfTime()) return true;
  const report = await db.moderationReport.findFirst({
    where: moderationDeadlineWhere(now),
    select: { id: true },
  });
  if (report) return true;
  if (outOfTime()) return true;
  const evidence = await db.supportCaseEvidenceRequest.findFirst({
    where: overdueEvidenceWhere(now),
    select: { id: true },
  });
  return evidence !== null;
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
  startedAt?: number;
}): Promise<SupportSlaSweepResult> {
  const startedAt = opts?.startedAt ?? Date.now();
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
          select: { transactionId: true, entityRef: true },
          orderBy: { createdAt: "desc" },
          take: 5000,
        })
        .catch(() => []),
    ]);

    const sla = await stageSlaNotices(
      now,
      limit,
      startedAt,
      operators,
      stagedSlaKeys(outboxRows ?? []),
      errors,
      stagedBells,
    );

    const autoClose = await autoCloseResolvedRows(
      now,
      limit,
      errors,
      startedAt,
    );
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

    const noticeCutoff = noticeCutoffOf(now);
    const moderationNotices = await prisma.notificationOutbox.findMany({
      where: {
        entityRef: { startsWith: "moderation-deadline:" },
        createdAt: { gte: noticeCutoff },
      },
      select: { entityRef: true },
    });
    const pendingReports = await prisma.moderationReport.findMany({
      where: moderationDeadlineWhere(
        now,
        moderationDeadlineIds(moderationNotices, "breach"),
        moderationDeadlineIds(moderationNotices, "warn"),
      ),
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
      where: overdueEvidenceWhere(now, notifiedEvidenceIds),
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
      scanned: sla.scanned,
      slaNoticesStaged: sla.staged,
      orgEscalationEmailsSent: sla.orgEmails,
      ...autoClose,
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

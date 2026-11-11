/**
 * Settles every declared platform incident: void the sessions it overlaps and
 * write their remedy rows, apply each remedy once its dueAt passes, send one
 * digest per learner and one ops report, then stamp the incident settled.
 * Every step is a CAS or a unique-key upsert, so a killed run converges on the next.
 *
 * Imported by app/api/cleanup/settle-platform-incidents (the ticker twin) and
 * the console's per-incident "Run now" door.
 */

import type { IncidentRemedyKind, Prisma } from "@prisma/client";

import prisma from "../../lib/prisma";
import type { PrismaLike } from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { startDeadline } from "@/lib/cron/run-deadline";
import { withAppointmentLock } from "@/utils/appointmentlock";
import { createRunFailureReporter } from "@/lib/observability/run-failures";
import {
  DEAD_LETTER_PREFIX,
  MAX_REMEDY_ATTEMPTS,
} from "@/lib/booking/incident-keys";
import {
  enumerateIncident,
  extendPlanForIncident,
  freeTrialPair,
  type IncidentRow,
} from "@/lib/booking/platform-incidents";
import { refundIncidentSeat } from "@/lib/payments/operations/incident-refunds";
import {
  sendIncidentDigests,
  stageAndSendIncidentReport,
} from "@/lib/booking/platform-incident-notices";

export interface SettlePlatformIncidentsResult {
  success: boolean;
  incidents: number;
  voided: number;
  remediesCreated: number;
  remediesDone: number;
  remediesRetried: number;
  deadLettered: number;
  digests: number;
  reports: number;
  settled: number;
  errors: number;
  timestamp: string;
}

const runFailures = createRunFailureReporter("bookings");
const DEFAULT_LIMIT = 10;
const INCIDENTS_PER_RUN = 20;
const MONEY_KINDS: IncidentRemedyKind[] = ["REFUND_AT_DUE", "REFUND_NOW"];

const INCIDENT_SELECT = {
  id: true,
  startsAt: true,
  endsAt: true,
  enumeratedAt: true,
  reportedAt: true,
} satisfies Prisma.PlatformIncidentSelect;

type IncidentState = IncidentRow & {
  enumeratedAt: Date | null;
  reportedAt: Date | null;
};

const REMEDY_SELECT = {
  id: true,
  incidentId: true,
  occurrenceId: true,
  userId: true,
  paymentId: true,
  kind: true,
  attempts: true,
  occurrence: {
    select: {
      appointmentId: true,
      completionStatus: true,
      appointment: {
        select: { subscriptionId: true, trial: { select: { id: true } } },
      },
    },
  },
} satisfies Prisma.IncidentRemedySelect;

type DueRemedy = Prisma.IncidentRemedyGetPayload<{
  select: typeof REMEDY_SELECT;
}>;

type Step =
  | { kind: "done"; note?: string }
  /** The effect and its done stamp already committed together. */
  | { kind: "applied"; count: number }
  | { kind: "retry"; error: string; countAttempt: boolean };

// Shared by the run's reads and the ticker's idle probe.
const UNSETTLED_INCIDENT_WHERE = {
  settledAt: null,
} satisfies Prisma.PlatformIncidentWhereInput;

function dueRemedyWhere(now: Date) {
  return {
    doneAt: null,
    dueAt: { lte: now },
    attempts: { lt: MAX_REMEDY_ATTEMPTS },
  } satisfies Prisma.IncidentRemedyWhereInput;
}

export async function hasPlatformIncidentWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const incident = await db.platformIncident.findFirst({
    where: UNSETTLED_INCIDENT_WHERE,
    select: { id: true },
  });
  if (incident) return true;
  if (outOfTime()) return true;
  const remedy = await db.incidentRemedy.findFirst({
    where: dueRemedyWhere(now),
    select: { id: true },
  });
  return remedy !== null;
}

const emptyResult = (now: Date): SettlePlatformIncidentsResult => ({
  success: true,
  incidents: 0,
  voided: 0,
  remediesCreated: 0,
  remediesDone: 0,
  remediesRetried: 0,
  deadLettered: 0,
  digests: 0,
  reports: 0,
  settled: 0,
  errors: 0,
  timestamp: now.toISOString(),
});

export async function settlePlatformIncidents(
  opts: { limit?: number; startedAt?: number } = {},
): Promise<SettlePlatformIncidentsResult> {
  const pastDeadline = startDeadline(opts.startedAt);
  return withCronLock("settle-platform-incidents", { failMode: "closed" }, () =>
    settleUnlocked(opts.limit ?? DEFAULT_LIMIT, pastDeadline, null),
  );
}

/** The console's "Run now": the same lock, keys and steps, scoped to one incident. */
export async function settlePlatformIncidentForOne(
  incidentId: string,
): Promise<SettlePlatformIncidentsResult> {
  const pastDeadline = startDeadline();
  return withCronLock("settle-platform-incidents", { failMode: "closed" }, () =>
    settleUnlocked(DEFAULT_LIMIT, pastDeadline, incidentId),
  );
}

async function settleUnlocked(
  limit: number,
  pastDeadline: () => boolean,
  incidentId: string | null,
): Promise<SettlePlatformIncidentsResult> {
  const now = new Date();
  const result = emptyResult(now);
  try {
    const incidents: IncidentState[] = await prisma.platformIncident.findMany({
      where: {
        ...UNSETTLED_INCIDENT_WHERE,
        ...(incidentId ? { id: incidentId } : {}),
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: INCIDENTS_PER_RUN,
      select: INCIDENT_SELECT,
    });
    result.incidents = incidents.length;
    for (const incident of incidents) {
      if (incident.enumeratedAt || pastDeadline()) continue;
      incident.enumeratedAt = await enumerate(
        incident,
        limit,
        pastDeadline,
        now,
        result,
      );
    }
    await applyDueRemedies(limit, pastDeadline, now, incidentId, result);
    for (const incident of incidents) {
      if (!incident.enumeratedAt || pastDeadline()) continue;
      await noticeAndSettle(incident, limit, pastDeadline, result);
    }
  } finally {
    runFailures.flush();
  }
  result.success = result.errors === 0;
  return result;
}

/** The retroactive pass; stamps enumeratedAt once every overlapping session is decided. */
async function enumerate(
  incident: IncidentState,
  limit: number,
  pastDeadline: () => boolean,
  now: Date,
  result: SettlePlatformIncidentsResult,
): Promise<Date | null> {
  const tally = {
    voided: 0,
    remediesCreated: 0,
    failed: (occurrenceId: string, error: unknown) => {
      result.errors += 1;
      runFailures.add("settle-platform-incidents.void", error, {
        incidentId: incident.id,
        occurrenceId,
      });
    },
  };
  const complete = await enumerateIncident(
    incident,
    { limit, pastDeadline, now },
    tally,
  );
  result.voided += tally.voided;
  result.remediesCreated += tally.remediesCreated;
  if (!complete) return null;
  const stampedAt = new Date();
  await prisma.platformIncident.updateMany({
    where: { id: incident.id, enumeratedAt: null },
    data: { enumeratedAt: stampedAt },
  });
  return stampedAt;
}

/** Due remedies, poison rows rotated to the back by updatedAt; bites until the deadline. */
async function applyDueRemedies(
  limit: number,
  pastDeadline: () => boolean,
  now: Date,
  incidentId: string | null,
  result: SettlePlatformIncidentsResult,
): Promise<void> {
  const seen: string[] = [];
  while (!pastDeadline()) {
    const due: DueRemedy[] = await prisma.incidentRemedy.findMany({
      where: {
        ...dueRemedyWhere(now),
        ...(incidentId ? { incidentId } : {}),
        ...(seen.length > 0 ? { id: { notIn: seen } } : {}),
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: REMEDY_SELECT,
    });
    seen.push(...due.map((r) => r.id));
    for (const remedy of due) {
      if (pastDeadline()) return;
      await applyOne(remedy, result);
    }
    if (due.length < limit) return;
  }
}

async function applyOne(
  remedy: DueRemedy,
  result: SettlePlatformIncidentsResult,
): Promise<void> {
  let step: Step;
  try {
    step = await stepFor(remedy);
  } catch (error) {
    // A lock held elsewhere or a lost CAS: not the row's fault, so no attempt is counted.
    result.errors += 1;
    runFailures.add("settle-platform-incidents.remedy", error, {
      remedyId: remedy.id,
      kind: remedy.kind,
    });
    return;
  }
  if (step.kind === "applied") {
    result.remediesDone += step.count;
    return;
  }
  if (step.kind === "done") {
    result.remediesDone += await markDone(remedy, step.note);
    return;
  }
  result.remediesRetried += 1;
  const dead = await countFailure(remedy, step);
  if (dead) result.deadLettered += 1;
  // A dispute hold is expected and waits quietly; a conflict or failed drive reports once per run.
  if (step.countAttempt) {
    runFailures.add(
      "settle-platform-incidents.retry",
      new Error(step.error),
      { remedyId: remedy.id, kind: remedy.kind, dead },
      { level: "warning" },
    );
  }
}

/** What one due remedy does now; non-money kinds commit their effect with the done stamp. */
async function stepFor(remedy: DueRemedy): Promise<Step> {
  const occ = remedy.occurrence;
  if (occ.completionStatus !== "VOIDED") {
    return { kind: "done", note: "skipped: the session is no longer voided" };
  }
  switch (remedy.kind) {
    case "CLASS_EXISTING":
      return { kind: "done" };
    case "TRIAL_REOFFER":
    case "SUBSCRIPTION_EXTEND":
      return { kind: "applied", count: await applyInTx(remedy) };
    case "REFUND_AT_DUE":
    case "REFUND_NOW":
      return withAppointmentLock(occ.appointmentId, () => refundStep(remedy));
  }
}

/** The trial re-offer or plan extension and its done stamp, in one commit. */
function applyInTx(remedy: DueRemedy): Promise<number> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.incidentRemedy.updateMany({
      where: { id: remedy.id, doneAt: null },
      data: { doneAt: now },
    });
    if (count === 0) return 0;
    const appt = remedy.occurrence.appointment;
    if (remedy.kind === "TRIAL_REOFFER" && appt.trial) {
      await freeTrialPair(tx, appt.trial.id, remedy.incidentId);
    }
    if (remedy.kind === "SUBSCRIPTION_EXTEND" && appt.subscriptionId) {
      await extendPlanForIncident(tx, appt.subscriptionId, now);
    }
    return count;
  });
}

async function refundStep(remedy: DueRemedy): Promise<Step> {
  // Re-read under the lock: a free rebook that committed first wins.
  const current = await prisma.incidentRemedy.findUnique({
    where: { id: remedy.id },
    select: { doneAt: true },
  });
  if (current?.doneAt) return { kind: "applied", count: 0 };
  // An ops un-void that landed first wins too.
  const occ = await prisma.appointmentOccurrence.findUnique({
    where: { id: remedy.occurrenceId },
    select: { completionStatus: true },
  });
  if (occ?.completionStatus !== "VOIDED") {
    return { kind: "done", note: "skipped: the session is no longer voided" };
  }
  if (!remedy.paymentId) return { kind: "done", note: "skipped: no payment" };
  const outcome = await refundIncidentSeat({
    incidentId: remedy.incidentId,
    occurrenceId: remedy.occurrenceId,
    userId: remedy.userId,
    paymentId: remedy.paymentId,
    trialId: remedy.occurrence.appointment.trial?.id ?? null,
  });
  switch (outcome.kind) {
    case "done":
      return { kind: "done" };
    case "nothing":
      return { kind: "done", note: "skipped: nothing left to refund" };
    case "conflict":
      return {
        kind: "retry",
        error: `marker conflict: payment already owes ${outcome.heldKey}`,
        countAttempt: true,
      };
    case "blocked":
      return {
        kind: "retry",
        error: "an open dispute holds the refund",
        countAttempt: false,
      };
    case "failed":
      return {
        kind: "retry",
        error:
          outcome.error instanceof Error
            ? outcome.error.message
            : String(outcome.error),
        countAttempt: true,
      };
  }
}

/** Stamps done by CAS; a money remedy's last seat settles the session for the day-14 sweep. */
async function markDone(remedy: DueRemedy, note?: string): Promise<number> {
  const now = new Date();
  const { count } = await prisma.incidentRemedy.updateMany({
    where: { id: remedy.id, doneAt: null },
    data: { doneAt: now, lastError: note ?? null },
  });
  if (count > 0 && MONEY_KINDS.includes(remedy.kind) && !note) {
    await settleSessionIfLastSeat(remedy.occurrenceId, now);
  }
  return count;
}

async function settleSessionIfLastSeat(
  occurrenceId: string,
  now: Date,
): Promise<void> {
  const left = await prisma.incidentRemedy.count({
    where: { occurrenceId, doneAt: null, kind: { in: MONEY_KINDS } },
  });
  if (left > 0) return;
  await prisma.appointmentOccurrence.updateMany({
    where: {
      id: occurrenceId,
      completionStatus: "VOIDED",
      seatsSettledAt: null,
    },
    data: { seatsSettledAt: now },
  });
}

/** Records the failure and rotates the row; the cap dead-letters it. */
async function countFailure(
  remedy: DueRemedy,
  step: Extract<Step, { kind: "retry" }>,
): Promise<boolean> {
  const attempts = remedy.attempts + (step.countAttempt ? 1 : 0);
  const dead = attempts >= MAX_REMEDY_ATTEMPTS;
  await prisma.incidentRemedy.updateMany({
    where: { id: remedy.id, doneAt: null, attempts: remedy.attempts },
    data: {
      attempts,
      lastError: dead ? `${DEAD_LETTER_PREFIX} ${step.error}` : step.error,
    },
  });
  return dead;
}

/** Digests, then the ops report and the settle stamp once every remedy is terminal. */
async function noticeAndSettle(
  incident: IncidentState,
  limit: number,
  pastDeadline: () => boolean,
  result: SettlePlatformIncidentsResult,
): Promise<void> {
  try {
    result.digests += await sendIncidentDigests(incident.id, {
      limit,
      pastDeadline,
    });
    const open = await prisma.incidentRemedy.count({
      where: {
        incidentId: incident.id,
        OR: [
          { doneAt: null, attempts: { lt: MAX_REMEDY_ATTEMPTS } },
          { notifiedAt: null },
        ],
      },
    });
    if (open > 0) return;
    if (!incident.reportedAt) {
      result.reports += await stageAndSendIncidentReport(incident.id);
    }
    const { count } = await prisma.platformIncident.updateMany({
      where: { id: incident.id, settledAt: null, reportedAt: { not: null } },
      data: { settledAt: new Date() },
    });
    result.settled += count;
  } catch (error) {
    result.errors += 1;
    runFailures.add("settle-platform-incidents.notice", error, {
      incidentId: incident.id,
    });
  }
}

/**
 * A declared platform incident voids every booked session it overlaps and owes
 * each learner a remedy: one IncidentRemedy row per seat and session, applied
 * by the settle-platform-incidents sweep once its dueAt passes.
 */

import {
  IncidentRemedyKind,
  OccurrenceCompletionStatus,
  Prisma,
  TrialStatus,
} from "@prisma/client";
import { z } from "zod";

import prisma, { type Tx } from "@/lib/prisma";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { voidRefundExists } from "@/lib/backoffice/session-outcomes";
import { onClassSessionVoided } from "./class-sessions";
import { LIVE_PARTICIPANT_STATUSES } from "./participants";
import { flushClassVoidNotices } from "./session-outcome-sweep";
import { transitionOccurrenceCompletion, transitionTrial } from "./transitions";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_INCIDENT_HOURS = 24;
const INCIDENT_LOOKBACK_DAYS = 7;
/** A consultation or paid trial is refunded this long after its remedy row is written. */
const INCIDENT_REFUND_DELAY_MS = 48 * HOUR_MS;
/** A subscription voided by an incident gets this much more plan time per session. */
const INCIDENT_PLAN_EXTENSION_MS = 7 * DAY_MS;
/** A session must be this far past its end before the incident pass voids it. */
const RETRO_BUFFER_MS = HOUR_MS;

/** The window an operator may declare: past, within the last 7 days, at most 24 h long. */
export function incidentWindowSchema(now: Date) {
  return z
    .object({ startsAt: z.coerce.date(), endsAt: z.coerce.date() })
    .superRefine((w, ctx) => {
      const issue = (message: string) =>
        ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      if (w.startsAt >= w.endsAt)
        issue("The window must start before it ends.");
      if (w.endsAt > now)
        issue("Only a window that has already ended can be declared.");
      if (
        w.endsAt.getTime() <
        now.getTime() - INCIDENT_LOOKBACK_DAYS * DAY_MS
      ) {
        issue("The window must have ended within the last 7 days.");
      }
      if (
        w.endsAt.getTime() - w.startsAt.getTime() >
        MAX_INCIDENT_HOURS * HOUR_MS
      ) {
        issue("A window can be at most 24 hours long.");
      }
    });
}

type IncidentWindow = z.infer<ReturnType<typeof incidentWindowSchema>>;

/** Records the incident; the same window declared again returns the first row. */
export async function declareIncident(
  tx: Pick<Tx, "platformIncident">,
  args: IncidentWindow & { reason: string; declaredByUserId: string },
): Promise<{ id: string; created: boolean }> {
  const where = {
    startsAt_endsAt: { startsAt: args.startsAt, endsAt: args.endsAt },
  };
  // ON CONFLICT DO NOTHING, so a concurrent duplicate never aborts the transaction.
  const { count } = await tx.platformIncident.createMany({
    data: [
      {
        startsAt: args.startsAt,
        endsAt: args.endsAt,
        reason: args.reason,
        declaredByUserId: args.declaredByUserId,
      },
    ],
    skipDuplicates: true,
  });
  const row = await tx.platformIncident.findUniqueOrThrow({
    where,
    select: { id: true },
  });
  return { id: row.id, created: count === 1 };
}

export interface IncidentRow {
  id: string;
  startsAt: Date;
  endsAt: Date;
}

/** Sessions whose booked interval overlaps the incident window. */
const overlapsIncident = (incident: IncidentRow) =>
  ({
    startsAt: { lt: incident.endsAt },
    endsAt: { gt: incident.startsAt },
    isTentative: false,
    deletedAt: null,
  }) satisfies Prisma.AppointmentOccurrenceWhereInput;

const RETRO_SELECT = {
  id: true,
  appointmentId: true,
  startsAt: true,
  endsAt: true,
  completionStatus: true,
  outcome: true,
  seatsSettledAt: true,
  appointment: {
    select: {
      organizationId: true,
      consultationId: true,
      subscriptionId: true,
      classId: true,
      webinarId: true,
      trial: { select: { id: true, paymentId: true } },
      participants: {
        where: { role: "CONSULTEE", status: { in: LIVE_PARTICIPANT_STATUSES } },
        select: { userId: true, paymentId: true, createdAt: true },
      },
      payment: {
        where: { paymentStatus: "SUCCEEDED", deletedAt: null },
        select: { id: true, userId: true },
      },
    },
  },
} satisfies Prisma.AppointmentOccurrenceSelect;

export type RetroOccurrence = Prisma.AppointmentOccurrenceGetPayload<{
  select: typeof RETRO_SELECT;
}>;

type ClassVoid = Awaited<ReturnType<typeof onClassSessionVoided>> | null;

const VOIDABLE_FROM: ReadonlySet<OccurrenceCompletionStatus> = new Set([
  "SCHEDULED",
  "COMPLETED",
  "UNVERIFIED",
]);

/** The remedy kind a session's product owes, or null when no row is needed. */
function remedyKindFor(
  occ: RetroOccurrence,
  paymentId: string | null,
): IncidentRemedyKind | null {
  const appt = occ.appointment;
  if (appt.trial) {
    return appt.trial.paymentId ? "REFUND_AT_DUE" : "TRIAL_REOFFER";
  }
  if (appt.consultationId) return paymentId ? "REFUND_AT_DUE" : null;
  if (appt.subscriptionId) return "SUBSCRIPTION_EXTEND";
  if (appt.classId) return "CLASS_EXISTING";
  if (appt.webinarId) return paymentId ? "REFUND_NOW" : null;
  return null;
}

/** One row per live seat that held the session; pure. */
export function remedyRowsFor(
  occ: RetroOccurrence,
  incidentId: string,
  now: Date,
): Prisma.IncidentRemedyCreateManyInput[] {
  const appt = occ.appointment;
  return appt.participants
    .filter((seat) => seat.createdAt < occ.startsAt)
    .flatMap((seat) => {
      const paymentId =
        appt.trial?.paymentId ??
        seat.paymentId ??
        appt.payment.find((p) => p.userId === seat.userId)?.id ??
        null;
      const kind = remedyKindFor(occ, paymentId);
      if (!kind) return [];
      return [
        {
          incidentId,
          occurrenceId: occ.id,
          userId: seat.userId,
          paymentId,
          kind,
          dueAt:
            kind === "REFUND_AT_DUE"
              ? new Date(now.getTime() + INCIDENT_REFUND_DELAY_MS)
              : now,
        },
      ];
    });
}

type RetroOutcome = "voided" | "relabelled" | "kept" | "skipped" | "lost";

/**
 * Voids one overlapping session as PLATFORM_OUTAGE (CAS on the status read)
 * and writes its remedy rows in the same commit, so a kill leaves either both or neither.
 */
export async function voidForIncident(
  occ: RetroOccurrence,
  incidentId: string,
  now: Date,
): Promise<{ outcome: RetroOutcome; created: number }> {
  if (
    occ.completionStatus === "VOIDED" &&
    (occ.seatsSettledAt || (await voidRefundExists(prisma, occ.id)))
  ) {
    return { outcome: "skipped", created: 0 };
  }
  const rows = remedyRowsFor(occ, incidentId, now);
  const committed = await prisma.$transaction(
    async (tx) => {
      let outcome: RetroOutcome = "kept";
      let classVoid: ClassVoid = null;
      if (VOIDABLE_FROM.has(occ.completionStatus)) {
        const moved = await transitionOccurrenceCompletion(tx, {
          where: {
            id: occ.id,
            isTentative: false,
            deletedAt: null,
            ...(occ.completionStatus === "SCHEDULED" && { voidedAt: null }),
          },
          to: OccurrenceCompletionStatus.VOIDED,
          fromIn: [occ.completionStatus],
          data: {
            outcome: "PLATFORM_OUTAGE",
            outcomeAt: now,
            voidedAt: now,
            completedAt: null,
          },
          reason: `incident:${incidentId}`,
          organizationId: occ.appointment.organizationId,
          appointmentId: occ.appointmentId,
          allowZero: true,
        });
        if (moved === 0)
          return { outcome: "lost" as const, classVoid, created: 0 };
        outcome = "voided";
        if (occ.appointment.classId) {
          classVoid = await onClassSessionVoided(tx, {
            appointmentId: occ.appointmentId,
            occurrenceId: occ.id,
            startsAt: occ.startsAt,
            voidedAt: now,
            hostAttributed: false,
          });
        }
      } else if (occ.outcome !== "PLATFORM_OUTAGE") {
        // A void blamed on the host before the declaration is the platform's miss after it.
        const { count } = await tx.appointmentOccurrence.updateMany({
          where: {
            id: occ.id,
            completionStatus: "VOIDED",
            outcome: occ.outcome,
          },
          data: { outcome: "PLATFORM_OUTAGE", outcomeAt: now },
        });
        if (count === 0)
          return { outcome: "lost" as const, classVoid, created: 0 };
        outcome = "relabelled";
      }
      const created =
        rows.length > 0
          ? (
              await tx.incidentRemedy.createMany({
                data: rows,
                skipDuplicates: true,
              })
            ).count
          : 0;
      return { outcome, classVoid, created };
    },
    { timeout: 15_000 },
  );
  await flushClassVoidNotices(committed.classVoid);
  return { outcome: committed.outcome, created: committed.created };
}

interface EnumerateTally {
  voided: number;
  remediesCreated: number;
  failed: (occurrenceId: string, error: unknown) => void;
}

/**
 * Walks the incident's overlapping sessions by id; true when every one is
 * decided, so the incident's enumeration is complete and its notices may go.
 */
export async function enumerateIncident(
  incident: IncidentRow,
  opts: { limit: number; pastDeadline: () => boolean; now: Date },
  tally: EnumerateTally,
): Promise<boolean> {
  let cursor: string | null = null;
  let complete = true;
  for (;;) {
    if (opts.pastDeadline()) return false;
    const page: RetroOccurrence[] = await prisma.appointmentOccurrence.findMany(
      {
        where: {
          ...overlapsIncident(incident),
          completionStatus: { in: [...VOIDABLE_FROM, "VOIDED"] },
          // One remedy per session, even where two declared windows overlap it.
          incidentRemedies: { none: {} },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: opts.limit,
        select: RETRO_SELECT,
      },
    );
    const bite = await enumeratePage(page, incident.id, opts, tally);
    if (bite === "deadline") return false;
    if (bite === "pending") complete = false;
    cursor = page.at(-1)?.id ?? cursor;
    if (page.length < opts.limit) return complete;
  }
}

/** One page of the walk: "deadline" stops the run, "pending" leaves work for a later one. */
async function enumeratePage(
  page: RetroOccurrence[],
  incidentId: string,
  opts: { pastDeadline: () => boolean; now: Date },
  tally: EnumerateTally,
): Promise<"done" | "pending" | "deadline"> {
  const bufferCutoff = new Date(opts.now.getTime() - RETRO_BUFFER_MS);
  let result: "done" | "pending" = "done";
  for (const occ of page) {
    if (opts.pastDeadline()) return "deadline";
    if (occ.completionStatus === "SCHEDULED" && occ.endsAt > bufferCutoff) {
      // Still inside the live-overrun buffer; a later run voids it.
      result = "pending";
      continue;
    }
    try {
      const { outcome, created } = await voidForIncident(
        occ,
        incidentId,
        opts.now,
      );
      if (outcome === "voided") tally.voided += 1;
      if (outcome === "lost") result = "pending";
      tally.remediesCreated += created;
    } catch (error) {
      result = "pending";
      tally.failed(occ.id, error);
    }
  }
  return result;
}

/** Cancels a voided trial so the pair is free for a new request; an already-ended trial is left alone. */
export async function freeTrialPair(
  tx: Pick<Tx, "trial" | "bookingStatusHistory">,
  trialId: string,
  incidentId: string,
): Promise<boolean> {
  try {
    // COMPLETED → CANCELLED is this door's own edge; the shared map keeps the route's set.
    await transitionTrial(tx, {
      where: { id: trialId },
      to: TrialStatus.CANCELLED,
      fromIn: [TrialStatus.SCHEDULED, TrialStatus.COMPLETED],
      data: { pendingPaymentUrl: null },
      reason: `incident:${incidentId}`,
    });
    return true;
  } catch (error) {
    if (error instanceof IllegalTransitionError) return false;
    throw error;
  }
}

/** Moves a live plan's end 7 days later, by CAS on the end it read; false when the plan is not live. */
export async function extendPlanForIncident(
  tx: Pick<Tx, "subscription">,
  subscriptionId: string,
  now: Date,
): Promise<boolean> {
  const sub = await tx.subscription.findUnique({
    where: { id: subscriptionId },
    select: { status: true, schedulingPeriodEndsAt: true, deletedAt: true },
  });
  if (
    !sub ||
    sub.deletedAt ||
    !["APPROVED", "SCHEDULED"].includes(sub.status) ||
    sub.schedulingPeriodEndsAt <= now
  ) {
    return false;
  }
  const { count } = await tx.subscription.updateMany({
    where: {
      id: subscriptionId,
      status: sub.status,
      schedulingPeriodEndsAt: sub.schedulingPeriodEndsAt,
    },
    data: {
      schedulingPeriodEndsAt: new Date(
        sub.schedulingPeriodEndsAt.getTime() + INCIDENT_PLAN_EXTENSION_MS,
      ),
    },
  });
  if (count === 0)
    throw new Error(`Subscription ${subscriptionId} moved under the extension`);
  return true;
}

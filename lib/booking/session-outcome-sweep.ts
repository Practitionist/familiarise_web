/**
 * #1569 D2 — the one writer of an occurrence's outcome. The end + 1 h slot pass
 * in `auto-complete-appointments` reads each past SCHEDULED session's presence,
 * asks `classifySessionOutcome`, and writes COMPLETED, VOIDED or UNVERIFIED plus
 * the outcome columns in one CAS. The Stream webhooks and the orphan reconciler
 * only close the room.
 */

import { OccurrenceCompletionStatus, type Prisma } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import {
  stageAppointmentCancelledEmail,
  stageClassExitAvailableEmails,
  stageSessionOutcomeEmails,
  type SessionOutcomeEmailArgs,
} from "@/lib/email/senders/booking";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import {
  formatNotificationDateTime,
  resolveRecipientTimezones,
} from "@/lib/novu/humanize";
import type { StagedTrigger } from "@/lib/novu/outbox";
import { stageBell } from "@/lib/novu/stage-bell";
import { personalHref } from "@/lib/novu/resolve-href";
import {
  getCallParticipantSessionsFromStream,
  getCallPresenceEvidence,
  type CallPresenceEvidence,
  type StreamParticipantSessionInterval,
} from "@/lib/stream/call-presence";
import { getAppUrl } from "@/lib/url";
import { REJOIN_GRACE_MS } from "@/lib/appointments/occurrences";
import { resolveRoomEndsAt } from "@/lib/meetings/duration-cap";
import { isPastNoShowHandoff } from "./attendance";
import {
  classifySessionOutcome,
  type OutageWindow,
  type PresenceInterval,
  type SessionOutcomeVerdict,
} from "./session-outcome";
import { SESSION_HOSTS_SELECT, sessionHostUserIds } from "./session-hosts";
import { transitionOccurrenceCompletion } from "./transitions";
import { liveParticipant, transitionParticipant } from "./participants";
import {
  agedNeedsHumanWhere,
  NEEDS_HUMAN,
  NEEDS_HUMAN_ESCALATE_DAYS,
} from "./misses";
import { reportStandingFinding } from "@/lib/observability/standing-finding";
import { reportSentryMessage } from "@/lib/observability/report";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { onClassSessionVoided } from "./class-sessions";

/** How long past the booked end a one-sided session waits for Stream before it parks UNVERIFIED. */
const STREAM_EVIDENCE_WAIT_MS = 24 * 60 * 60 * 1000;

/** Stream reads one sweep run may spend on attendance evidence; a slot past the budget waits for the next run. */
const STREAM_WITNESS_READS_PER_RUN = 100;

/** Shared by every slot one run decides. */
export interface StreamWitnessBudget {
  remaining: number;
  /** Reads for an unresolved interval that Stream could not answer; the run reports them once. */
  failures: number;
}

export function createStreamWitnessBudget(): StreamWitnessBudget {
  return { remaining: STREAM_WITNESS_READS_PER_RUN, failures: 0 };
}

export const OUTCOME_SLOT_SELECT = {
  id: true,
  appointmentId: true,
  startsAt: true,
  endsAt: true,
  meeting: {
    select: {
      id: true,
      streamCallId: true,
      endedAt: true,
      endedReason: true,
      extendedSeconds: true,
    },
  },
  presences: {
    select: {
      id: true,
      userId: true,
      userSessionId: true,
      streamCallId: true,
      joinedAt: true,
      leftAt: true,
      closedByEnd: true,
    },
  },
  appointment: {
    select: {
      organizationId: true,
      subscriptionId: true,
      consultationId: true,
      classId: true,
      webinarId: true,
      ...SESSION_HOSTS_SELECT,
    },
  },
} satisfies Prisma.AppointmentOccurrenceSelect;

export type OutcomeSlot = Prisma.AppointmentOccurrenceGetPayload<{
  select: typeof OUTCOME_SLOT_SELECT;
}>;

export interface OutcomeContext {
  now: Date;
  outages: OutageWindow[];
  /** Called once per session Stream saw people in while we recorded nobody. */
  onFeedGap?: () => void;
  witness: StreamWitnessBudget;
}

export type SlotDecision =
  | {
      kind: "deferred";
      reason:
        | "live-overrun"
        | "no-show-detector"
        | "stream-budget"
        | "stream-evidence";
    }
  | {
      kind: "written";
      to: OccurrenceCompletionStatus;
      verdict: SessionOutcomeVerdict;
      moved: boolean;
    };

/** Platform-wide DEGRADED/OFFLINE windows and declared incidents that overlap [from, now]. */
export async function readOutageWindows(
  db: Pick<Tx, "maintenanceWindow" | "platformIncident">,
  from: Date,
): Promise<OutageWindow[]> {
  const [rows, incidents] = await Promise.all([
    db.maintenanceWindow.findMany({
      where: {
        organizationId: null,
        startedAt: { not: null },
        // An ended window flips to OFF, so only an open one is read by phase.
        OR: [
          { endedAt: null, phase: { not: "OFF" } },
          { endedAt: { gt: from } },
        ],
      },
      select: { startedAt: true, endedAt: true },
      take: 200,
    }),
    db.platformIncident.findMany({
      where: { endsAt: { gt: from } },
      select: { startsAt: true, endsAt: true },
      orderBy: { startsAt: "asc" },
      take: 200,
    }),
  ]);
  return [
    ...rows
      .filter((r): r is { startedAt: Date; endedAt: Date | null } =>
        Boolean(r.startedAt),
      )
      .map((r) => ({
        startsAt: r.startedAt,
        endsAt: r.endedAt,
        source: "maintenance" as const,
      })),
    ...incidents.map((i) => ({
      startsAt: i.startsAt,
      endsAt: i.endsAt,
      source: "incident" as const,
    })),
  ];
}

type OutcomeMeeting = NonNullable<OutcomeSlot["meeting"]>;

interface StreamEvidence {
  report: CallPresenceEvidence | null;
  /** Participant sessions per call id Stream answered for. */
  sessions: Map<string, StreamParticipantSessionInterval[]>;
}

const EXHAUSTED = Symbol("stream-budget");

async function spendWitnessRead<T>(
  budget: StreamWitnessBudget,
  read: () => Promise<T>,
): Promise<T | typeof EXHAUSTED> {
  if (budget.remaining <= 0) return EXHAUSTED;
  budget.remaining--;
  return read();
}

/** Assumed closes and open rows wait on Stream; a leave Stream reported is final. */
const isUnresolved = (p: OutcomeSlot["presences"][number]) =>
  p.leftAt === null || p.closedByEnd;

/**
 * Reads Stream's report and the participant sessions of every segment with an
 * unresolved interval, plus the current segment whenever our rows may be missing
 * someone (no rows, no report count, or Stream saw more people). Runs before the
 * outcome transaction, so a lost join alone never decides a void.
 */
async function readStreamEvidence(
  slot: OutcomeSlot,
  meeting: OutcomeMeeting,
  budget: StreamWitnessBudget,
): Promise<StreamEvidence | typeof EXHAUSTED> {
  const report = await spendWitnessRead(budget, () =>
    getCallPresenceEvidence(meeting.streamCallId),
  );
  if (report === EXHAUSTED) return EXHAUSTED;

  const unresolvedCallIds = new Set(
    slot.presences
      .filter(isUnresolved)
      .map((p) => p.streamCallId ?? meeting.streamCallId),
  );
  const seenUsers = new Set(slot.presences.map((p) => p.userId));
  const callIds = new Set(unresolvedCallIds);
  if (
    slot.presences.length === 0 ||
    report === null ||
    report.unique > seenUsers.size
  ) {
    callIds.add(meeting.streamCallId);
  }

  const sessions = new Map<string, StreamParticipantSessionInterval[]>();
  for (const callId of callIds) {
    const read = await spendWitnessRead(budget, () =>
      getCallParticipantSessionsFromStream(
        callId,
        callId === meeting.streamCallId ? report?.sessionId : null,
      ),
    );
    if (read === EXHAUSTED) return EXHAUSTED;
    if (read) sessions.set(callId, read);
    else if (unresolvedCallIds.has(callId)) budget.failures++;
  }
  return { report, sessions };
}

interface ResolvedPresence {
  /** What the classifier reads; an unresolved interval stays open (leftAt null). */
  intervals: PresenceInterval[];
  /** Assumed closes Stream answered with a reported leave. */
  leaves: { id: string; leftAt: Date }[];
  /** Device stays Stream saw that we hold no row for. */
  missing: (StreamParticipantSessionInterval & { streamCallId: string })[];
}

/** Pure: replaces each unresolved interval with Stream's leave, or leaves it open. */
function resolvePresencesFromStream(
  presences: OutcomeSlot["presences"],
  currentCallId: string,
  sessions: ReadonlyMap<string, readonly StreamParticipantSessionInterval[]>,
): ResolvedPresence {
  const leaves: ResolvedPresence["leaves"] = [];
  const intervals: PresenceInterval[] = presences.map((p) => {
    if (!isUnresolved(p)) {
      return { userId: p.userId, joinedAt: p.joinedAt, leftAt: p.leftAt };
    }
    const witnessed = sessions
      .get(p.streamCallId ?? currentCallId)
      ?.find((s) => s.userSessionId === p.userSessionId);
    if (witnessed?.leftAt) leaves.push({ id: p.id, leftAt: witnessed.leftAt });
    return {
      userId: p.userId,
      joinedAt: p.joinedAt,
      leftAt: witnessed?.leftAt ?? null,
    };
  });

  const known = new Set(presences.map((p) => p.userSessionId));
  const missing: ResolvedPresence["missing"] = [];
  for (const [streamCallId, rows] of sessions) {
    for (const row of rows) {
      if (known.has(row.userSessionId)) continue;
      known.add(row.userSessionId);
      missing.push({ ...row, streamCallId });
      intervals.push({
        userId: row.userId,
        joinedAt: row.joinedAt,
        leftAt: row.leftAt,
      });
    }
  }
  return { intervals, leaves, missing };
}

/**
 * Persists what Stream answered, outside the outcome transaction: reported leaves
 * replace assumed closes (CAS on the assumption), closed missing stays are
 * inserted, and a still-open row is capped at the room end, marked as assumed.
 */
async function persistStreamResolution(
  slot: OutcomeSlot,
  meeting: OutcomeMeeting,
  resolved: ResolvedPresence,
): Promise<void> {
  for (const leave of resolved.leaves) {
    await prisma.meetingPresence.updateMany({
      where: { id: leave.id, OR: [{ leftAt: null }, { closedByEnd: true }] },
      data: { leftAt: leave.leftAt, closedByEnd: false },
    });
  }
  const closedMissing = resolved.missing.filter((m) => m.leftAt !== null);
  if (closedMissing.length > 0) {
    await prisma.meetingPresence.createMany({
      data: closedMissing.map((m) => ({
        meetingId: meeting.id,
        appointmentOccurrenceId: slot.id,
        userId: m.userId,
        userSessionId: m.userSessionId,
        streamCallId: m.streamCallId,
        joinedAt: m.joinedAt,
        leftAt: m.leftAt,
      })),
      skipDuplicates: true,
    });
  }
  if (slot.presences.some((p) => p.leftAt === null)) {
    await prisma.meetingPresence.updateMany({
      where: { appointmentOccurrenceId: slot.id, leftAt: null },
      data: { leftAt: meeting.endedAt ?? slot.endsAt, closedByEnd: true },
    });
  }
}

async function writeSlotOutcomeTransaction(
  slot: OutcomeSlot,
  presences: readonly PresenceInterval[],
  to: OccurrenceCompletionStatus,
  verdict: SessionOutcomeVerdict,
  now: Date,
): Promise<boolean> {
  const txResult = await prisma.$transaction(
    async (tx) => {
      const count = await transitionOccurrenceCompletion(tx, {
        // voidedAt: null — a re-run never re-stamps a void.
        where: {
          id: slot.id,
          isTentative: false,
          deletedAt: null,
          voidedAt: null,
        },
        to,
        fromIn: [OccurrenceCompletionStatus.SCHEDULED],
        data: {
          outcome: verdict.outcome,
          outcomeAt: now,
          deliveredMinutes: verdict.deliveredMinutes,
          lostMinutes: verdict.lostMinutes,
          ...(to === "VOIDED" && { voidedAt: now }),
          ...(to === "COMPLETED" && { completedAt: now }),
        },
        reason: `session-outcome:${verdict.outcome}`,
        organizationId: slot.appointment.organizationId,
        allowZero: true,
      });
      // A learner seen in a completed session has attended: their seat moves CONFIRMED -> ATTENDED.
      const presentUserIds = [...new Set(presences.map((p) => p.userId))];
      if (count > 0 && to === "COMPLETED" && presentUserIds.length > 0) {
        await transitionParticipant(
          tx,
          {
            appointmentId: slot.appointmentId,
            role: "CONSULTEE",
            userId: { in: presentUserIds },
          },
          "ATTENDED",
          { fromIn: ["CONFIRMED"] },
        );
      }
      const noShow =
        count > 0 && verdict.outcome === "LEARNER_ABSENT"
          ? await stageNoShowBells(tx, slot, "one-to-one")
          : null;
      // Owner decision — a group seat absent from a held session hears only of its recording.
      const isGroup = !!(
        slot.appointment.classId ?? slot.appointment.webinarId
      );
      const missedRecording =
        count > 0 && verdict.outcome === "HELD" && isGroup
          ? await stageNoShowBells(tx, { ...slot, presences }, "group")
          : null;
      // A void is a class miss: bells, and the exit right re-checked in this tx.
      const voided =
        count > 0 && to === "VOIDED" && slot.appointment.classId
          ? await onClassSessionVoided(tx, {
              appointmentId: slot.appointmentId,
              occurrenceId: slot.id,
              startsAt: slot.startsAt,
              voidedAt: now,
              hostAttributed: verdict.hostAttributed,
            })
          : null;
      return { applied: count > 0, noShow, missedRecording, voided };
    },
    { timeout: 15_000 },
  );
  const [noShowEmails, missedRecordingEmails, voidedEmails] = await Promise.all(
    [
      txResult.noShow?.emailArgs
        ? stageSessionOutcomeEmails(prisma, txResult.noShow.emailArgs).catch(
            (err) => {
              console.error(
                "[session-outcome-sweep] Failed to stage NO_SHOW emails:",
                err,
              );
              return [];
            },
          )
        : Promise.resolve([]),
      txResult.missedRecording?.emailArgs
        ? stageSessionOutcomeEmails(
            prisma,
            txResult.missedRecording.emailArgs,
          ).catch((err) => {
            console.error(
              "[session-outcome-sweep] Failed to stage MISSED_RECORDING emails:",
              err,
            );
            return [];
          })
        : Promise.resolve([]),
      stageClassVoidEmails(txResult.voided),
    ],
  );
  await flushNotificationsAfter(
    {
      bells: [
        ...(txResult.noShow?.bells ?? []),
        ...(txResult.missedRecording?.bells ?? []),
        ...(txResult.voided?.bells ?? []),
      ],
      emails: [
        {
          rows: noShowEmails,
          emailType: "CLASS_SESSION_NO_SHOW",
        },
        {
          rows: missedRecordingEmails,
          emailType: "CLASS_SESSION_MISSED_RECORDING",
        },
        ...voidedEmails,
      ],
    },
    "class-sessions.voided",
  );
  return txResult.applied;
}

type ClassVoidNotices = Awaited<ReturnType<typeof onClassSessionVoided>>;

/** Stages a class void's cancel and exit emails after its commit; a failed stage is logged, never thrown. */
async function stageClassVoidEmails(voided: ClassVoidNotices | null) {
  const [cancelRows, exitRows] = await Promise.all([
    voided?.cancelEmailArgs
      ? stageAppointmentCancelledEmail(prisma, voided.cancelEmailArgs).catch(
          (err) => {
            console.error(
              "[session-outcome-sweep] Failed to stage VOIDED cancel emails:",
              err,
            );
            return [];
          },
        )
      : Promise.resolve([]),
    voided?.exitEmailArgs
      ? stageClassExitAvailableEmails(prisma, voided.exitEmailArgs).catch(
          (err) => {
            console.error(
              "[session-outcome-sweep] Failed to stage VOIDED exit emails:",
              err,
            );
            return [];
          },
        )
      : Promise.resolve([]),
  ]);
  return [
    { rows: cancelRows, emailType: "APPOINTMENT_CANCELLED" },
    { rows: exitRows, emailType: "CLASS_SESSION_EXIT_AVAILABLE" },
  ];
}

/** The bells and emails a class void staged in its transaction, sent once it committed. */
export async function flushClassVoidNotices(
  voided: ClassVoidNotices | null,
): Promise<void> {
  if (!voided) return;
  await flushNotificationsAfter(
    { bells: voided.bells, emails: await stageClassVoidEmails(voided) },
    "class-sessions.voided",
  );
}

/** Classify one past session and write its outcome, or defer it. */
export async function decideSlotOutcome(
  slot: OutcomeSlot,
  ctx: OutcomeContext,
): Promise<SlotDecision> {
  const { meeting } = slot;
  // An unended room someone is still in, or still inside its room-time grace, is an overrun, not a verdict.
  if (
    meeting &&
    !meeting.endedAt &&
    (slot.presences.some((p) => !p.leftAt) ||
      ctx.now.getTime() <
        resolveRoomEndsAt(slot.endsAt, meeting.extendedSeconds).getTime() +
          REJOIN_GRACE_MS)
  ) {
    return { kind: "deferred", reason: "live-overrun" };
  }

  let presences: PresenceInterval[] = slot.presences;
  let report: CallPresenceEvidence | null = null;
  let streamAnswered = false;
  if (meeting) {
    const evidence = await readStreamEvidence(slot, meeting, ctx.witness);
    if (evidence === EXHAUSTED) {
      return { kind: "deferred", reason: "stream-budget" };
    }
    report = evidence.report;
    streamAnswered =
      report !== null || evidence.sessions.has(meeting.streamCallId);
    const resolved = resolvePresencesFromStream(
      slot.presences,
      meeting.streamCallId,
      evidence.sessions,
    );
    await persistStreamResolution(slot, meeting, resolved);
    presences = resolved.intervals;
    // Stream saw people while our webhook rows recorded nobody.
    if (
      slot.presences.length === 0 &&
      ((report?.unique ?? 0) > 0 || presences.length > 0)
    ) {
      ctx.onFeedGap?.();
    }
  }

  let verdict = classifySessionOutcome({
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    hostUserIds: sessionHostUserIds(slot.appointment),
    intervals: presences,
    meeting: meeting
      ? { endedAt: meeting.endedAt, endedReason: meeting.endedReason }
      : null,
    report,
    maintenanceWindows: ctx.outages,
  });
  // Webhook rows alone never mark one side absent: wait for Stream, then park for ops.
  if (
    meeting &&
    !streamAnswered &&
    (verdict.outcome === "LEARNER_ABSENT" || verdict.outcome === "HOST_ABSENT")
  ) {
    if (ctx.now.getTime() - slot.endsAt.getTime() < STREAM_EVIDENCE_WAIT_MS) {
      return { kind: "deferred", reason: "stream-evidence" };
    }
    verdict = {
      ...verdict,
      outcome: "INCONCLUSIVE",
      completionStatus: "UNVERIFIED",
      hostAttributed: false,
    };
  }
  let to: OccurrenceCompletionStatus = verdict.completionStatus;
  if (verdict.outcome === "HOST_ABSENT" && slot.appointment.consultationId) {
    // D5 — the detector cancels and refunds a consultation host no-show; one it
    // declined parks UNVERIFIED for ops after the handoff instead of voiding.
    if (!isPastNoShowHandoff(slot.endsAt, ctx.now, ctx.outages)) {
      return { kind: "deferred", reason: "no-show-detector" };
    }
    to = OccurrenceCompletionStatus.UNVERIFIED;
  }

  const moved = await writeSlotOutcomeTransaction(
    slot,
    presences,
    to,
    verdict,
    ctx.now,
  );
  return { kind: "written", to, verdict, moved };
}

const PLAN_BELL = { select: { title: true, recordingEnabled: true } } as const;

function resolveNoShowPlan(
  row: {
    consultation?: {
      consultationPlan: { title: string; recordingEnabled: boolean };
    } | null;
    subscription?: {
      subscriptionPlan: { title: string; recordingEnabled: boolean };
    } | null;
    trial?: {
      subscriptionPlan: { title: string; recordingEnabled: boolean };
    } | null;
    webinar?: {
      webinarPlan: { title: string; recordingEnabled: boolean };
    } | null;
    class?: {
      classPlan: { title: string; recordingEnabled: boolean };
    } | null;
  } | null,
  shape: "one-to-one" | "group",
) {
  if (!row) return null;
  if (shape === "group") {
    return row.class?.classPlan ?? row.webinar?.webinarPlan ?? null;
  }
  return (
    row.consultation?.consultationPlan ??
    row.subscription?.subscriptionPlan ??
    row.trial?.subscriptionPlan ??
    null
  );
}

/** The slot fields a no-show bell reads; `presences` is who was in the call. */
type BellSlot = Pick<OutcomeSlot, "id" | "appointmentId" | "startsAt"> & {
  presences: readonly { userId: string }[];
};

async function buildSeatNoShowBell(
  tx: Tx,
  args: {
    slot: BellSlot;
    seat: { userId: string; user: { consulteeProfileId: string | null } };
    shape: "one-to-one" | "group";
    planTitle: string;
    zone?: string;
    hasRecording: boolean;
  },
): Promise<StagedTrigger | null> {
  const { slot, seat, shape, planTitle, zone, hasRecording } = args;
  const profileId = seat.user.consulteeProfileId;
  const recordingUrl = profileId
    ? personalHref("consultee", profileId, "recordings")
    : `${getAppUrl()}/dashboard`;
  return stageBell(tx, {
    workflowId:
      shape === "group"
        ? NOVU_WORKFLOWS.SESSION_MISSED_RECORDING
        : NOVU_WORKFLOWS.SESSION_NO_SHOW,
    recipients: [seat.userId],
    payload: {
      planTitle,
      dateTime:
        formatNotificationDateTime(slot.startsAt, zone) ??
        slot.startsAt.toISOString(),
      supportUrl: `${getAppUrl()}/support`,
      ...(hasRecording && { recordingUrl }),
    },
    dedupeKey: `no-show:${slot.id}:${seat.userId}`,
  });
}

/**
 * D7 — a 1:1 learner who never joined forfeits the session; one bell says so,
 * links "couldn't get in?" to support, and names the recording when there is
 * one. A group seat with no presence in a held session gets one bell only when
 * a recording exists, and nothing otherwise. No money moves either way.
 */
async function stageNoShowBells(
  tx: Tx,
  slot: BellSlot,
  shape: "one-to-one" | "group",
): Promise<{
  bells: StagedTrigger[];
  emailArgs: SessionOutcomeEmailArgs | null;
}> {
  const row = await tx.appointment.findUnique({
    where: { id: slot.appointmentId },
    select: {
      consultation: { select: { consultationPlan: PLAN_BELL } },
      subscription: { select: { subscriptionPlan: PLAN_BELL } },
      trial: { select: { subscriptionPlan: PLAN_BELL } },
      webinar: { select: { webinarPlan: PLAN_BELL } },
      class: { select: { classPlan: PLAN_BELL } },
      participants: {
        where: { role: "CONSULTEE", ...liveParticipant() },
        select: {
          userId: true,
          user: { select: { consulteeProfileId: true } },
        },
      },
    },
  });
  const plan = resolveNoShowPlan(row, shape);
  if (!row || !plan) return { bells: [], emailArgs: null };
  const recording = plan.recordingEnabled
    ? await tx.recording.findFirst({
        where: {
          meeting: { appointmentOccurrenceId: slot.id },
          status: { in: ["READY", "AVAILABLE"] },
        },
        select: { id: true },
      })
    : null;
  if (shape === "group" && !recording) return { bells: [], emailArgs: null };
  const present = new Set(slot.presences.map((p) => p.userId));
  const absent =
    shape === "group"
      ? row.participants.filter((seat) => !present.has(seat.userId))
      : row.participants;
  const zones = await resolveRecipientTimezones(
    absent.map((seat) => seat.userId),
    tx,
  );
  const bells: StagedTrigger[] = [];
  for (const seat of absent) {
    const bell = await buildSeatNoShowBell(tx, {
      slot,
      seat,
      shape,
      planTitle: plan.title,
      zone: zones.get(seat.userId),
      hasRecording: Boolean(recording),
    });
    if (bell) bells.push(bell);
  }
  const absentUserIds = absent.map((seat) => seat.userId);
  const emailArgs =
    absentUserIds.length > 0
      ? {
          appointmentId: slot.appointmentId,
          userIds: absentUserIds,
          outcome:
            shape === "group"
              ? ("MISSED_RECORDING" as const)
              : ("NO_SHOW" as const),
          planTitle: plan.title,
          startsAt: slot.startsAt,
          supportUrl: `${getAppUrl()}/support`,
          dashboardUrl: `${getAppUrl()}/dashboard`,
        }
      : null;
  return { bells, emailArgs };
}

/** Owner decision — a needs-human item older than this raises a Sentry warning. */
export const NEEDS_HUMAN_ALERT_HOURS = 72;

/** Shared by the alert and auto-complete's idle probe. */
export function staleNeedsHumanWhere(
  now: Date,
): Prisma.AppointmentOccurrenceWhereInput {
  const cutoff = new Date(now.getTime() - NEEDS_HUMAN_ALERT_HOURS * 3_600_000);
  return {
    AND: [
      NEEDS_HUMAN,
      // Queued since the verdict, or since the call ended when none was written.
      {
        OR: [
          { outcomeAt: { lt: cutoff } },
          { outcomeAt: null, endsAt: { lt: cutoff } },
        ],
      },
    ],
  };
}

/**
 * Escalates every session parked for ops longer than 7 days, once per new id
 * per day (`reportStandingFinding`), with a Sentry warning naming how many hold
 * an ended plan's settlement. No money moves; the hold stays until ops decides.
 */
export async function escalateAgedNeedsHuman(
  db: Pick<Tx, "appointmentOccurrence">,
  now: Date,
): Promise<number> {
  const where = agedNeedsHumanWhere(now);
  const aged = await db.appointmentOccurrence.count({ where });
  if (aged === 0) return 0;
  const rows = await db.appointmentOccurrence.findMany({
    where,
    select: { id: true },
    orderBy: [{ endsAt: "asc" }, { id: "asc" }],
    take: 200,
  });
  // Plan-end settlement waits while any of these sits on an ended plan.
  const blockingPlanEnd = await db.appointmentOccurrence.count({
    where: {
      AND: [
        where,
        { appointment: { subscription: { planEndsAt: { lte: now } } } },
      ],
    },
  });
  const message = `${aged} session(s) waited over ${NEEDS_HUMAN_ESCALATE_DAYS} days for an ops decision; ${blockingPlanEnd} hold an ended plan's settlement`;
  await reportStandingFinding(
    {
      key: "session-outcome-sweep:needs-human-escalation",
      ids: [...rows.map((r) => r.id), `count:${aged}`],
      message,
    },
    () =>
      reportSentryMessage(message, {
        subsystem: "bookings",
        op: "needs-human-escalation",
        level: "warning",
        extra: { aged, blockingPlanEnd, sample: rows.slice(0, 10) },
      }),
  );
  return aged;
}

/**
 * Warn when a session newly passes 72 hours in the ops needs-human queue; the
 * same queue is not re-reported inside the window. The hold on its money stays.
 */
export async function alertStaleNeedsHuman(
  db: Pick<Tx, "appointmentOccurrence">,
  now: Date,
): Promise<number> {
  const where = staleNeedsHumanWhere(now);
  const stale = await db.appointmentOccurrence.count({ where });
  if (stale > 0) {
    const rows = await db.appointmentOccurrence.findMany({
      where,
      select: { id: true },
      orderBy: [{ endsAt: "asc" }, { id: "asc" }],
      take: 200,
    });
    // A business finding for the console, not Sentry.
    await reportStandingFinding({
      key: "session-outcome-sweep:needs-human-age",
      // The count joins the ids so growth past the sampled rows still re-records.
      ids: [...rows.map((r) => r.id), `count:${stale}`],
      message: `${stale} session(s) waited over 72 h for an ops decision`,
    });
  }
  return stale;
}

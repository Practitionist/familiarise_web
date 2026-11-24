/**
 * The one writer of an occurrence's outcome. The end + 1 h slot pass in
 * `auto-complete-appointments` settles each past SCHEDULED session's attendance
 * from Stream's own record (`settleOccurrenceAttendance`), asks
 * `classifySessionOutcome`, and writes COMPLETED, VOIDED or UNVERIFIED plus the
 * outcome columns in one CAS. The Stream webhooks and the orphan reconciler only close the room.
 */

import { OccurrenceCompletionStatus, type Prisma } from "@prisma/client";
import { z } from "zod";

import { readJobCheckpoint } from "@/lib/cron/with-cron-lock";

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
import { getAppUrl } from "@/lib/url";
import { REJOIN_GRACE_MS } from "@/lib/appointments/occurrences";
import { resolveRoomEndsAt } from "@/lib/meetings/duration-cap";
import {
  ATTENDANCE_SETTLE_WAIT_MS,
  SETTLE_MEETING_SELECT,
  settleOccurrenceAttendance,
} from "@/lib/meetings/settle-attendance";
import type { RunFailureReporter } from "@/lib/observability/run-failures";
import { isPastNoShowHandoff, NO_SHOW_GRACE_MINUTES } from "./attendance";
import {
  classifySessionOutcome,
  COMPLETION_FOR_OUTCOME,
  overlapsDeclaredIncident,
  type OutageWindow,
  type PresenceInterval,
  type SessionOutcomeVerdict,
} from "./session-outcome";
import { SESSION_HOSTS_SELECT, sessionHostUserIds } from "./session-hosts";
import { transitionOccurrenceCompletion } from "./transitions";
import { liveParticipant, transitionParticipant } from "./participants";
import {
  agedNeedsHumanWhere,
  isNegativeMoneyOutcome,
  needsHumanWhere,
  NEEDS_HUMAN_ESCALATE_DAYS,
  unconfirmedClosedVerdictWhere,
  type NegativeMoneyOutcome,
} from "./misses";
import { judgeOutcomeEvidence } from "./outcome-evidence";
import { reportStandingFinding } from "@/lib/observability/standing-finding";
import { reportSentryMessage } from "@/lib/observability/report";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { onClassSessionVoided } from "./class-sessions";
import {
  prepareProposedOutcomeNotices,
  stageOutcomeNotices,
  type PreparedOutcomeNotices,
} from "./outcome-notices";

export const OUTCOME_SLOT_SELECT = {
  id: true,
  appointmentId: true,
  startsAt: true,
  endsAt: true,
  meeting: {
    select: { ...SETTLE_MEETING_SELECT, endedAt: true, endedReason: true },
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
  /** Called once per session parked because Stream's record could not be read in time. */
  onUnreadable?: (occurrenceId: string) => void;
  /** The run's Stream failure reporter, flushed once per run. */
  failures?: RunFailureReporter;
  /** Epoch ms by which every Stream request of a settle must answer, so in-flight work fits the run. */
  settleDeadlineAt?: number;
}

export type SlotDecision =
  | {
      kind: "deferred";
      reason:
        | "live-overrun"
        | "no-show-detector"
        | "attendance-unsettled"
        | "notices-unprepared";
    }
  | {
      kind: "written";
      to: OccurrenceCompletionStatus;
      verdict: SessionOutcomeVerdict;
      moved: boolean;
    };

/** Rows read per outage source; a read that returns this many may be incomplete. */
export const OUTAGE_READ_CAP = 200;

/** True when either outage source filled its cap, so an overlapping window may be missing. */
export function outageReadCapped(outages: readonly OutageWindow[]): boolean {
  const count = (source: OutageWindow["source"]) =>
    outages.filter((o) => o.source === source).length;
  return (
    count("maintenance") >= OUTAGE_READ_CAP ||
    count("incident") >= OUTAGE_READ_CAP
  );
}

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
      take: OUTAGE_READ_CAP,
    }),
    db.platformIncident.findMany({
      where: { endsAt: { gt: from } },
      select: { startsAt: true, endsAt: true },
      orderBy: { startsAt: "asc" },
      take: OUTAGE_READ_CAP,
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

type RoomEnd = {
  endedAt: Date | null;
  endedReason: string | null;
  attendanceSettledAt: Date | null;
};

/** The room's end as classified (read after the settle) and the call id the settle read (loaded before it). */
type RoomFence = { end: RoomEnd; settledCallId: string };

/** The room's end as it stands now: read after a settle, so an end that committed during the Stream reads is the one judged. */
export const readRoomEnd = (meetingId: string): Promise<RoomEnd | null> =>
  prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { endedAt: true, endedReason: true, attendanceSettledAt: true },
  });

/**
 * When the detector's handoff clock starts: the booked end, or, for a record
 * stored later than the detector's grace allows, that much before the stamp,
 * so the detector always gets its runs on the settled record.
 */
function noShowHandoffAnchor(endsAt: Date, settledAt: Date | null): Date {
  if (!settledAt) return endsAt;
  const fromStamp = new Date(
    settledAt.getTime() - NO_SHOW_GRACE_MINUTES * 60_000,
  );
  return fromStamp > endsAt ? fromStamp : endsAt;
}

/** A session no one could read: no host attribution and no money moves. */
const UNREADABLE_VERDICT: SessionOutcomeVerdict = {
  outcome: "INCONCLUSIVE",
  completionStatus: COMPLETION_FOR_OUTCOME.INCONCLUSIVE,
  deliveredMinutes: null,
  lostMinutes: null,
  hostAttributed: false,
};

type SlotEvidence =
  | { kind: "intervals"; intervals: PresenceInterval[] }
  | { kind: "unreadable" }
  | { kind: "wait" };

/** A declared incident needs no read; otherwise the stored snapshot, settled now if it can be. */
async function slotEvidence(
  slot: OutcomeSlot,
  ctx: OutcomeContext,
): Promise<SlotEvidence> {
  const { meeting } = slot;
  if (
    !meeting ||
    overlapsDeclaredIncident(slot.startsAt, slot.endsAt, ctx.outages)
  ) {
    return { kind: "intervals", intervals: [] };
  }
  const settled = await settleOccurrenceAttendance(
    { occurrenceId: slot.id, endsAt: slot.endsAt, meeting },
    { now: ctx.now, failures: ctx.failures, deadlineAt: ctx.settleDeadlineAt },
  );
  if (settled.kind === "settled") {
    return { kind: "intervals", intervals: settled.intervals };
  }
  // A read cut short by this run's deadline says nothing about Stream: always try again.
  if (settled.kind === "out-of-time") return { kind: "wait" };
  // Past Stream's retention nothing will come back; anything else is retried until the wait ends.
  const waited =
    ctx.now.getTime() - slot.endsAt.getTime() >= ATTENDANCE_SETTLE_WAIT_MS;
  return settled.kind === "expired" || waited
    ? { kind: "unreadable" }
    : { kind: "wait" };
}

/**
 * Takes the occurrence row, then the room row, and re-reads the room: an end
 * since the classification, a rotation since the settle loaded the room, or (for
 * an unreadable park) a snapshot wins. NO KEY UPDATE leaves the presence inserts' FK checks free.
 */
async function roomChangedSinceRead(
  tx: Tx,
  occurrenceId: string,
  { end, settledCallId }: RoomFence,
  requireUnsettled: boolean,
): Promise<boolean> {
  await tx.$executeRaw`SELECT 1 FROM "AppointmentOccurrence" WHERE id = ${occurrenceId} FOR NO KEY UPDATE`;
  const rows = await tx.$queryRaw<
    {
      endedAt: Date | null;
      endedReason: string | null;
      streamCallId: string;
      settledAt: Date | null;
    }[]
  >`
    SELECT "endedAt", "endedReason", "streamCallId", "attendanceSettledAt" AS "settledAt"
    FROM "Meeting" WHERE "appointmentOccurrenceId" = ${occurrenceId} FOR NO KEY UPDATE`;
  const current = rows[0];
  if (!current) return true;
  return (
    (current.endedAt?.getTime() ?? null) !== (end.endedAt?.getTime() ?? null) ||
    current.endedReason !== end.endedReason ||
    current.streamCallId !== settledCallId ||
    (requireUnsettled && current.settledAt !== null)
  );
}

async function writeSlotOutcomeTransaction(
  slot: OutcomeSlot,
  presences: readonly PresenceInterval[],
  to: OccurrenceCompletionStatus,
  verdict: SessionOutcomeVerdict,
  now: Date,
  /** The room's end as classified (re-checked under lock), and whether an unreadable verdict needs the room still unsettled. */
  fence: { room: RoomFence | null; requireUnsettled: boolean },
  /** A negative verdict's notices, rendered before the transaction and staged only if this write moves the row. */
  proposal: PreparedOutcomeNotices | null,
): Promise<boolean> {
  const { requireUnsettled } = fence;
  const txResult = await prisma.$transaction(
    async (tx) => {
      if (
        fence.room &&
        (await roomChangedSinceRead(tx, slot.id, fence.room, requireUnsettled))
      ) {
        return {
          applied: false,
          proposed: null,
          missedRecording: null,
          voided: null,
        };
      }
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
          // A negative verdict is proposed; the window-close pass or ops confirm it.
          outcomeConfirmedAt: null,
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
      // Both sides hear of a proposed negative verdict, once, with the write that made it.
      const proposed =
        count > 0 && proposal ? await stageOutcomeNotices(tx, proposal) : null;
      // A group seat absent from a held session hears only of its recording.
      const isGroup = !!(
        slot.appointment.classId ?? slot.appointment.webinarId
      );
      const missedRecording =
        count > 0 && verdict.outcome === "HELD" && isGroup
          ? await stageMissedRecordingBells(tx, { ...slot, presences })
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
      return { applied: count > 0, proposed, missedRecording, voided };
    },
    { timeout: 15_000 },
  );
  const [missedRecordingEmails, voidedEmails] = await Promise.all([
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
  ]);
  await flushNotificationsAfter(
    {
      bells: [
        ...(txResult.proposed?.bells ?? []),
        ...(txResult.missedRecording?.bells ?? []),
        ...(txResult.voided?.bells ?? []),
      ],
      emails: [
        {
          rows: txResult.proposed?.emails ?? [],
          emailType: "SESSION_OUTCOME_PROPOSED",
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
  // An unended room still inside its room-time grace is an overrun, not a verdict.
  if (
    meeting &&
    !meeting.endedAt &&
    ctx.now.getTime() <
      resolveRoomEndsAt(slot.endsAt, meeting.extendedSeconds).getTime() +
        REJOIN_GRACE_MS
  ) {
    return { kind: "deferred", reason: "live-overrun" };
  }

  const evidence = await slotEvidence(slot, ctx);
  if (evidence.kind === "wait") {
    return { kind: "deferred", reason: "attendance-unsettled" };
  }
  const presences = evidence.kind === "intervals" ? evidence.intervals : [];
  // The end fields are read after the settle, so an end that committed during the Stream reads is the one judged.
  const room = meeting ? await readRoomEnd(meeting.id) : null;
  const verdict =
    evidence.kind === "unreadable"
      ? UNREADABLE_VERDICT
      : classifySessionOutcome({
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          hostUserIds: sessionHostUserIds(slot.appointment),
          intervals: presences,
          meeting: room
            ? { endedAt: room.endedAt, endedReason: room.endedReason }
            : null,
          maintenanceWindows: ctx.outages,
        });
  let to: OccurrenceCompletionStatus = verdict.completionStatus;
  if (verdict.outcome === "HOST_ABSENT" && slot.appointment.consultationId) {
    // D5 — the detector cancels and refunds a consultation host no-show; one it
    // declined parks UNVERIFIED for ops after the handoff instead of voiding.
    if (
      !isPastNoShowHandoff(
        noShowHandoffAnchor(slot.endsAt, room?.attendanceSettledAt ?? null),
        ctx.now,
        ctx.outages,
      )
    ) {
      return { kind: "deferred", reason: "no-show-detector" };
    }
    to = OccurrenceCompletionStatus.UNVERIFIED;
  }

  // A negative verdict is written only with its notices, so its window never starts unannounced.
  let proposal: PreparedOutcomeNotices | null = null;
  if (isNegativeMoneyOutcome(verdict.outcome)) {
    try {
      proposal = await prepareProposedOutcomeNotices({
        occurrenceId: slot.id,
        appointmentId: slot.appointmentId,
        startsAt: slot.startsAt,
        outcome: verdict.outcome,
        outcomeAt: ctx.now,
      });
    } catch (error) {
      ctx.failures?.add("session-outcome-sweep.notices-unprepared", error, {
        occurrenceId: slot.id,
      });
      return { kind: "deferred", reason: "notices-unprepared" };
    }
  }
  const moved = await writeSlotOutcomeTransaction(
    slot,
    presences,
    to,
    verdict,
    ctx.now,
    {
      room:
        meeting && room
          ? { end: room, settledCallId: meeting.streamCallId }
          : null,
      requireUnsettled: evidence.kind === "unreadable",
    },
    proposal,
  );
  if (moved && evidence.kind === "unreadable") ctx.onUnreadable?.(slot.id);
  return { kind: "written", to, verdict, moved };
}

const PLAN_BELL = { select: { title: true, recordingEnabled: true } } as const;

/** The slot fields a missed-recording bell reads; `presences` is who was in the call. */
type BellSlot = Pick<OutcomeSlot, "id" | "appointmentId" | "startsAt"> & {
  presences: readonly { userId: string }[];
};

async function buildSeatMissedRecordingBell(
  tx: Tx,
  args: {
    slot: BellSlot;
    seat: { userId: string; user: { consulteeProfileId: string | null } };
    planTitle: string;
    zone?: string;
  },
): Promise<StagedTrigger | null> {
  const { slot, seat, planTitle, zone } = args;
  const profileId = seat.user.consulteeProfileId;
  const recordingUrl = profileId
    ? personalHref("consultee", profileId, "recordings")
    : `${getAppUrl()}/dashboard`;
  return stageBell(tx, {
    workflowId: NOVU_WORKFLOWS.SESSION_MISSED_RECORDING,
    recipients: [seat.userId],
    payload: {
      planTitle,
      dateTime:
        formatNotificationDateTime(slot.startsAt, zone) ??
        slot.startsAt.toISOString(),
      supportUrl: `${getAppUrl()}/support`,
      recordingUrl,
    },
    dedupeKey: `no-show:${slot.id}:${seat.userId}`,
  });
}

/**
 * A class or webinar seat with no presence in a held, recorded session gets one
 * bell and one email naming the recording, and nothing otherwise. No money moves.
 */
async function stageMissedRecordingBells(
  tx: Tx,
  slot: BellSlot,
): Promise<{
  bells: StagedTrigger[];
  emailArgs: SessionOutcomeEmailArgs | null;
}> {
  const row = await tx.appointment.findUnique({
    where: { id: slot.appointmentId },
    select: {
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
  const plan = row?.class?.classPlan ?? row?.webinar?.webinarPlan ?? null;
  if (!row || !plan?.recordingEnabled) return { bells: [], emailArgs: null };
  const recording = await tx.recording.findFirst({
    where: {
      meeting: { appointmentOccurrenceId: slot.id },
      status: { in: ["READY", "AVAILABLE"] },
    },
    select: { id: true },
  });
  if (!recording) return { bells: [], emailArgs: null };
  const present = new Set(slot.presences.map((p) => p.userId));
  const absent = row.participants.filter((seat) => !present.has(seat.userId));
  const zones = await resolveRecipientTimezones(
    absent.map((seat) => seat.userId),
    tx,
  );
  const bells: StagedTrigger[] = [];
  for (const seat of absent) {
    const bell = await buildSeatMissedRecordingBell(tx, {
      slot,
      seat,
      planTitle: plan.title,
      zone: zones.get(seat.userId),
    });
    if (bell) bells.push(bell);
  }
  const absentUserIds = absent.map((seat) => seat.userId);
  const emailArgs =
    absentUserIds.length > 0
      ? {
          appointmentId: slot.appointmentId,
          userIds: absentUserIds,
          outcome: "MISSED_RECORDING" as const,
          planTitle: plan.title,
          startsAt: slot.startsAt,
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
      needsHumanWhere(now),
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

/** Closed unconfirmed verdicts judged per page; the pass pages by keyset until its deadline, so weak rows cannot hide older ones. */
const OUTCOME_CONFIRM_PAGE = 100;

const CONFIRM_SELECT = {
  id: true,
  startsAt: true,
  endsAt: true,
  outcome: true,
  outcomeAt: true,
  meeting: {
    select: {
      endedAt: true,
      endedReason: true,
      attendanceSettledAt: true,
      attendanceCorroboratedSessionIds: true,
      presences: { select: { userId: true, joinedAt: true, leftAt: true } },
    },
  },
  appointment: { select: SESSION_HOSTS_SELECT },
} satisfies Prisma.AppointmentOccurrenceSelect;

type ConfirmRow = Prisma.AppointmentOccurrenceGetPayload<{
  select: typeof CONFIRM_SELECT;
}>;

/** Strong evidence on the stored snapshot; a room never settled has no announcement record, so it is weak. */
function isStrongVerdict(
  row: ConfirmRow,
  outcome: NegativeMoneyOutcome,
  outages: OutageWindow[],
): boolean {
  const { meeting } = row;
  const evidence = judgeOutcomeEvidence(
    {
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      hostUserIds: sessionHostUserIds(row.appointment),
      intervals: meeting?.presences ?? [],
      meeting: meeting
        ? { endedAt: meeting.endedAt, endedReason: meeting.endedReason }
        : null,
      maintenanceWindows: outages,
      everySessionAnnounced:
        !!meeting?.attendanceSettledAt &&
        meeting.attendanceCorroboratedSessionIds.length === 0,
    },
    outcome,
  );
  return evidence?.strong === true;
}

export interface OutcomeConfirmRun {
  confirmed: number;
  /** Judged weak this run: left unconfirmed on the needs-human list for ops. */
  weak: number;
  errors: string[];
  /** Where the next run resumes, null once the scan reached the end and wraps, or absent when the pass was skipped and the stored cursor stands. */
  checkpoint?: string | null;
}

/** The job whose run trail keeps the pass's cursor between runs. */
const CONFIRM_CHECKPOINT_JOB = "auto-complete-appointments";

const confirmCursorSchema = z
  .string()
  .regex(/^[^|]+\|[^|]+$/)
  .transform((raw) => {
    const [at, id] = raw.split("|");
    return { outcomeAt: new Date(at), id };
  })
  .refine((k) => !Number.isNaN(k.outcomeAt.getTime()));

const encodeCursor = (k: Keyset) => `${k.outcomeAt.toISOString()}|${k.id}`;

/** A stored cursor the trail kept, or null to start from the newest verdict. */
function decodeCursor(raw: string | null): Keyset | null {
  const parsed = confirmCursorSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

type Keyset = { outcomeAt: Date; id: string };

/** The pass's filter past the last row of the previous page, in its (outcomeAt desc, id asc) order. */
function afterKeyset(
  where: Prisma.AppointmentOccurrenceWhereInput,
  after: Keyset | null,
): Prisma.AppointmentOccurrenceWhereInput {
  if (!after) return where;
  return {
    AND: [
      where,
      {
        OR: [
          { outcomeAt: { lt: after.outcomeAt } },
          { outcomeAt: after.outcomeAt, id: { gt: after.id } },
        ],
      },
    ],
  };
}

/** Judges one page and stamps its strong verdicts; false when the page's outage read was capped. */
async function confirmPage(
  rows: ConfirmRow[],
  where: Prisma.AppointmentOccurrenceWhereInput,
  now: Date,
  run: OutcomeConfirmRun,
): Promise<boolean> {
  const outages = await readOutageWindows(
    prisma,
    new Date(Math.min(...rows.map((r) => r.startsAt.getTime()))),
  );
  // A capped outage read may have dropped an overlapping window, so nothing is confirmed on it.
  if (outageReadCapped(outages)) {
    run.weak += rows.length;
    run.errors.push(
      `Outage read hit its ${OUTAGE_READ_CAP}-row cap; closed verdicts left unconfirmed`,
    );
    return false;
  }
  const strong = new Map<NegativeMoneyOutcome, string[]>();
  for (const row of rows) {
    if (!isNegativeMoneyOutcome(row.outcome)) continue;
    if (isStrongVerdict(row, row.outcome, outages)) {
      strong.set(row.outcome, [...(strong.get(row.outcome) ?? []), row.id]);
    } else {
      run.weak++;
    }
  }
  // A relabel or confirm since the read changes the outcome or the stamp, so the CAS skips it.
  const counts = await Promise.all(
    [...strong].map(([outcome, ids]) =>
      prisma.appointmentOccurrence.updateMany({
        where: { AND: [where, { id: { in: ids }, outcome }] },
        data: { outcomeConfirmedAt: now },
      }),
    ),
  );
  run.confirmed += counts.reduce((sum, c) => sum + c.count, 0);
  return true;
}

/**
 * Confirms each negative verdict whose report window closed on strong evidence,
 * newest first, by CAS from an unconfirmed stamp; a weak one stays for ops.
 */
export async function confirmClosedOutcomes(
  now: Date,
  pastDeadline: () => boolean,
): Promise<OutcomeConfirmRun> {
  const run: OutcomeConfirmRun = { confirmed: 0, weak: 0, errors: [] };
  // Past its share before it starts, the pass reads nothing and leaves the stored cursor in place.
  if (pastDeadline()) return run;
  const where = unconfirmedClosedVerdictWhere(now);
  // Resumes where the last run stopped, so a weak backlog cannot hide older verdicts run after run.
  let after: Keyset | null;
  try {
    after = decodeCursor(await readJobCheckpoint(CONFIRM_CHECKPOINT_JOB));
  } catch (error) {
    // Without the stored cursor nothing is read, and the stored one stands for the next run.
    run.errors.push(
      `Failed to read the closed-verdict cursor: ${error instanceof Error ? error.message : String(error)}`,
    );
    return run;
  }
  try {
    while (!pastDeadline()) {
      // "query", not a join: a join reads nested timestamps in the session zone.
      const rows: ConfirmRow[] = await prisma.appointmentOccurrence.findMany({
        relationLoadStrategy: "query",
        where: afterKeyset(where, after),
        select: CONFIRM_SELECT,
        orderBy: [{ outcomeAt: "desc" }, { id: "asc" }],
        take: OUTCOME_CONFIRM_PAGE,
      });
      const last = rows.at(-1);
      if (!last?.outcomeAt) {
        after = null;
        break;
      }
      const judged = await confirmPage(rows, where, now, run);
      // A capped page stays unconfirmed, but the cursor moves past it so it cannot stall the scan.
      after =
        rows.length < OUTCOME_CONFIRM_PAGE
          ? null
          : { outcomeAt: last.outcomeAt, id: last.id };
      if (!judged || !after) break;
    }
  } catch (error) {
    run.errors.push(
      `Failed to confirm closed session outcomes: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  run.checkpoint = after ? encodeCursor(after) : null;
  return run;
}

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
  attendanceReadableAt,
  SETTLE_MEETING_SELECT,
  settleOccurrenceAttendance,
} from "@/lib/meetings/settle-attendance";
import {
  createRunFailureReporter,
  type RunFailureReporter,
} from "@/lib/observability/run-failures";
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
import {
  liveLearnerSeat,
  liveParticipant,
  transitionParticipant,
} from "./participants";
import {
  AGREED_VERDICT,
  agedNeedsHumanWhere,
  confirmableNoShowWhere,
  isNegativeMoneyOutcome,
  needsHumanWhere,
  NEEDS_HUMAN_ESCALATE_DAYS,
  OUTCOME_REPORT_WINDOW_HOURS,
  reportWindowClosesAt,
  unconfirmedClosedVerdictWhere,
  type NegativeMoneyOutcome,
} from "./misses";
import { judgeOutcomeEvidence } from "./outcome-evidence";
import {
  CLASSIFIED_REPORT_REASONS,
  judgeReports,
  REPORT_EFFECT,
} from "./outcome-reports";
import { reportStandingFinding } from "@/lib/observability/standing-finding";
import { reportSentryMessage } from "@/lib/observability/report";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { onClassSessionVoided, onClassVoidConfirmed } from "./class-sessions";
import {
  OUTAGE_SELECTS,
  readOverlappingOutages,
  toOutageWindows,
} from "./outage-windows";
import { confirmConsultantNoShow } from "./consultant-no-show";
import {
  AppointmentBusyError,
  BookingLockUnavailableError,
  SWEEP_LOCK_RETRY_CONFIG,
  withAppointmentLock,
} from "@/utils/appointmentlock";

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

/** One run's Stream reads: once a read is throttled, no later session asks Stream in that run. */
export interface StreamReadBudget {
  throttled: boolean;
  /** Sessions left for a later run because of the throttle, the throttled read's own included. */
  deferred: number;
}

export interface OutcomeContext {
  now: Date;
  outages: OutageWindow[];
  /** Shared by every session of the run; absent, each session reads Stream on its own. */
  stream?: StreamReadBudget;
  /** Called once per session parked because Stream's record could not be read in time. */
  onUnreadable?: (occurrenceId: string) => void;
  /** The run's Stream failure reporter, flushed once per run. */
  failures?: RunFailureReporter;
  /** Epoch ms by which every Stream request of a settle, and every lock call of a void's write, must answer, so in-flight work fits the run. */
  settleDeadlineAt?: number;
}

export type SlotDecision =
  | {
      kind: "deferred";
      reason:
        | "live-overrun"
        | "no-show-detector"
        | "attendance-unsettled"
        /** A void whose booking's lock could not be had in the run's time left. */
        | "appointment-busy";
    }
  | {
      kind: "written";
      to: OccurrenceCompletionStatus;
      verdict: SessionOutcomeVerdict;
      moved: boolean;
    };

/** Rows read per outage source by the recent-window read. */
const OUTAGE_READ_CAP = 200;

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
      select: OUTAGE_SELECTS.maintenance,
      take: OUTAGE_READ_CAP,
    }),
    db.platformIncident.findMany({
      where: { endsAt: { gt: from } },
      select: OUTAGE_SELECTS.incident,
      orderBy: { startsAt: "asc" },
      take: OUTAGE_READ_CAP,
    }),
  ]);
  return toOutageWindows(rows, incidents);
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
  const target = { occurrenceId: slot.id, endsAt: slot.endsAt, meeting };
  // A stored record needs no read, and a room too fresh to read is not asked either.
  const wouldReadStream =
    !meeting.attendanceSettledAt && ctx.now >= attendanceReadableAt(target);
  if (ctx.stream?.throttled && wouldReadStream) {
    ctx.stream.deferred++;
    return { kind: "wait" };
  }
  const settled = await settleOccurrenceAttendance(target, {
    now: ctx.now,
    failures: ctx.failures,
    deadlineAt: ctx.settleDeadlineAt,
  });
  if (settled.kind === "settled") {
    if (settled.throttled && ctx.stream) ctx.stream.throttled = true;
    return { kind: "intervals", intervals: settled.intervals };
  }
  // A room too fresh to read was never asked, so it says nothing either.
  if (settled.kind === "too-early" && !wouldReadStream) return { kind: "wait" };
  // A failed request, or a read cut short by this run's deadline, says nothing about the session: always try again.
  if (settled.kind === "unavailable") {
    if (settled.throttled && ctx.stream) {
      ctx.stream.throttled = true;
      ctx.stream.deferred++;
    }
    return { kind: "wait" };
  }
  if (settled.kind === "out-of-time") return { kind: "wait" };
  // Past Stream's retention nothing will come back; an answer that is not final is retried until the wait ends.
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
          noShow: null,
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
      const noShow =
        count > 0 && verdict.outcome === "LEARNER_ABSENT"
          ? await stageNoShowBells(tx, { ...slot, presences }, "one-to-one")
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
    // D5 — the detector proposes a consultation host no-show; past the handoff
    // this pass parks the same proposal, UNVERIFIED, instead of voiding.
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

  const write = () =>
    writeSlotOutcomeTransaction(slot, presences, to, verdict, ctx.now, {
      room:
        meeting && room
          ? { end: room, settledCallId: meeting.streamCallId }
          : null,
      requireUnsettled: evidence.kind === "unreadable",
    });
  // A void is a miss the booking's doors price or wait on, so it takes turns with them.
  const written =
    to === OccurrenceCompletionStatus.VOIDED
      ? await underAppointmentLock(
          slot.appointmentId,
          ctx.settleDeadlineAt,
          write,
        )
      : { moved: await write() };
  if (!written) return { kind: "deferred", reason: "appointment-busy" };
  const { moved } = written;
  if (moved && evidence.kind === "unreadable") ctx.onUnreadable?.(slot.id);
  return { kind: "written", to, verdict, moved };
}

/**
 * Runs the void's write under the appointment lock the cancel, leave and ops doors hold, so a
 * door's check for a pending void and its refund never straddle the write. Each lock call gets
 * the smaller of its own bound and the run's time left; null when the lock is busy, stalled or
 * unreachable, and the session waits for the next run.
 */
async function underAppointmentLock(
  appointmentId: string,
  deadlineAt: number | undefined,
  write: () => Promise<boolean>,
): Promise<{ moved: boolean } | null> {
  const left = (deadlineAt ?? Infinity) - Date.now();
  const callTimeoutMs = Math.min(SWEEP_LOCK_RETRY_CONFIG.callTimeoutMs, left);
  if (callTimeoutMs <= 0) return null;
  try {
    return {
      moved: await withAppointmentLock(appointmentId, write, {
        ...SWEEP_LOCK_RETRY_CONFIG,
        callTimeoutMs,
        deadlineAt,
      }),
    };
  } catch (error) {
    if (
      error instanceof AppointmentBusyError ||
      error instanceof BookingLockUnavailableError
    ) {
      return null;
    }
    throw error;
  }
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

export interface OutcomeQueueAge {
  /** Minutes since the booked end of the oldest session still without an outcome; null when none waits. */
  oldestUndecidedMinutes: number | null;
  /** Sessions on the needs-human list. */
  needsHuman: number;
  /** Minutes the oldest of them has waited, from its verdict or else its booked end; null when the list is empty. */
  oldestNeedsHumanMinutes: number | null;
}

const minutesSince = (from: Date | null | undefined, now: Date) =>
  from
    ? Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000))
    : null;

/** The outcome queue's age for the run summary; `undecided` is the slot pass's own cohort. */
export async function readOutcomeQueueAge(
  db: Pick<Tx, "appointmentOccurrence">,
  now: Date,
  undecided: Prisma.AppointmentOccurrenceWhereInput,
): Promise<OutcomeQueueAge> {
  const waiting = needsHumanWhere(now);
  const [oldestUndecided, needsHuman, oldestVerdict, oldestUnjudged] =
    await Promise.all([
      db.appointmentOccurrence.findFirst({
        where: undecided,
        orderBy: { endsAt: "asc" },
        select: { endsAt: true },
      }),
      db.appointmentOccurrence.count({ where: waiting }),
      db.appointmentOccurrence.findFirst({
        where: { AND: [waiting, { outcomeAt: { not: null } }] },
        orderBy: { outcomeAt: "asc" },
        select: { outcomeAt: true },
      }),
      db.appointmentOccurrence.findFirst({
        where: { AND: [waiting, { outcomeAt: null }] },
        orderBy: { endsAt: "asc" },
        select: { endsAt: true },
      }),
    ]);
  // A waiting session ages from its verdict, or from its booked end when none was written.
  const waits = [
    minutesSince(oldestVerdict?.outcomeAt, now),
    minutesSince(oldestUnjudged?.endsAt, now),
  ].filter((m): m is number => m !== null);
  return {
    oldestUndecidedMinutes: minutesSince(oldestUndecided?.endsAt, now),
    needsHuman,
    oldestNeedsHumanMinutes: waits.length > 0 ? Math.max(...waits) : null,
  };
}

/** Closed unconfirmed verdicts judged per page; the pass pages by keyset until its deadline, so weak rows cannot hide older ones. */
const OUTCOME_CONFIRM_PAGE = 100;

/** The window-close pass's candidates: a closed unconfirmed verdict, or one an agreeing report may apply early. */
export function confirmableVerdictWhere(
  now: Date,
): Prisma.AppointmentOccurrenceWhereInput {
  return {
    OR: [
      unconfirmedClosedVerdictWhere(now),
      AGREED_VERDICT,
      confirmableNoShowWhere(now),
    ],
  };
}

/** Select on `Appointment`: who may report on each side of its sessions. */
export const REPORT_PARTIES_SELECT = {
  ...SESSION_HOSTS_SELECT,
  participants: { where: liveLearnerSeat(), select: { userId: true } },
} satisfies Prisma.AppointmentSelect;

type ReportPartiesRow = Prisma.AppointmentGetPayload<{
  select: typeof REPORT_PARTIES_SELECT;
}>;

/** The host side, and the learner seat holders who are not hosts. */
export function reportParties(row: ReportPartiesRow) {
  const hostUserIds = sessionHostUserIds(row);
  return {
    hostUserIds,
    learnerUserIds: row.participants
      .map((p) => p.userId)
      .filter((id) => !hostUserIds.includes(id)),
  };
}

/** The fields of a linked support case that `judgeReports` reads. */
export const OUTCOME_REPORT_FIELDS = {
  id: true,
  flowReason: true,
  requesterUserId: true,
  ownershipScope: true,
  flowReasonAt: true,
  deletedAt: true,
} satisfies Prisma.SupportCaseSelect;

const CONFIRM_SELECT = {
  id: true,
  appointmentId: true,
  startsAt: true,
  endsAt: true,
  completionStatus: true,
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
  supportCases: {
    where: { deletedAt: null, flowReason: { in: CLASSIFIED_REPORT_REASONS } },
    select: OUTCOME_REPORT_FIELDS,
  },
  appointment: {
    select: { ...REPORT_PARTIES_SELECT, consultationId: true, classId: true },
  },
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
  /** Stamped confirmed this run, the consultant no-shows claimed among them. */
  confirmed: number;
  /** Consultant no-shows confirmed and claimed: cancelled, refund owed and driven, strike written. */
  claimed: number;
  /** Strong no-show proposals whose booking no longer meets the detector's rules: left for ops. */
  declined: number;
  /** Judged weak this run: left unconfirmed on the needs-human list for ops. */
  weak: number;
  /** Disputed by the accused party: left unconfirmed on the needs-human list for ops. */
  disputed: number;
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

/** Whether the participants' reports block this verdict, apply it now, or leave it to the window. */
function judgeRowReports(
  row: ConfirmRow,
  outcome: NegativeMoneyOutcome,
  outcomeAt: Date,
) {
  return judgeReports(row.supportCases, {
    outcome,
    endsAt: row.endsAt,
    windowClosesAt: reportWindowClosesAt(outcomeAt),
    ...reportParties(row.appointment),
  });
}

/**
 * A dispute that may count against this verdict: its outcome's reason, outside an org operator's case, answered in its window.
 * Whether the reporter is on the reason's side stays with the per-row judgement, so the recheck only errs toward ops.
 */
function disputeSinceReadWhere(
  outcome: NegativeMoneyOutcome,
  row: { endsAt: Date; outcomeAt: Date },
): Prisma.SupportCaseWhereInput {
  return {
    deletedAt: null,
    ownershipScope: { not: "ORG_OPERATIONS" },
    flowReason: { in: [...REPORT_EFFECT[outcome].dispute] },
    flowReasonAt: { gte: row.endsAt, lte: reportWindowClosesAt(row.outcomeAt) },
  };
}

/** The CAS that confirms one judged row: still a candidate, the same outcome, and no dispute in its own window. */
function confirmGuard(
  where: Prisma.AppointmentOccurrenceWhereInput,
  row: {
    id: string;
    outcome: NegativeMoneyOutcome;
    endsAt: Date;
    outcomeAt: Date;
  },
): Prisma.AppointmentOccurrenceWhereInput {
  return {
    AND: [
      where,
      { id: row.id, outcome: row.outcome },
      { supportCases: { none: disputeSinceReadWhere(row.outcome, row) } },
    ],
  };
}

/** A consultation's proposed host no-show: confirming it runs the no-show claim, not a bare stamp. */
const isNoShowProposal = (row: ConfirmRow) =>
  row.completionStatus === "UNVERIFIED" &&
  row.outcome === "HOST_ABSENT" &&
  !!row.appointment.consultationId;

/** A class void: confirming it lets the miss count toward the exit right and the reliability flag. */
const isClassVoid = (row: ConfirmRow) =>
  row.completionStatus === "VOIDED" && !!row.appointment.classId;

/** Stamps a class void and re-checks its series in the same transaction; the notices go after the commit. */
async function confirmClassVoid(
  where: Prisma.AppointmentOccurrenceWhereInput,
  row: Parameters<typeof confirmGuard>[1] & { appointmentId: string },
  now: Date,
): Promise<boolean> {
  const voided = await prisma.$transaction(async (tx) => {
    const { count } = await tx.appointmentOccurrence.updateMany({
      where: confirmGuard(where, row),
      data: { outcomeConfirmedAt: now },
    });
    if (count === 0) return null;
    return onClassVoidConfirmed(tx, {
      appointmentId: row.appointmentId,
      occurrenceId: row.id,
      confirmedAt: now,
    });
  });
  if (!voided) return false;
  await flushClassVoidNotices(voided);
  return true;
}

/** A page judged to its end, or cut by the deadline: `resumeAfter` is the last row before the first one not tried (null when that is the page's first row). */
type PageResult = "judged" | { resumeAfter: Keyset | null };

/** The keyset of the row just before `id` on the page. */
function keysetBefore(rows: ConfirmRow[], id: string): Keyset | null {
  const prior = rows[rows.findIndex((r) => r.id === id) - 1];
  return prior?.outcomeAt ? { outcomeAt: prior.outcomeAt, id: prior.id } : null;
}

/** Judges one page and confirms its strong verdicts that are closed or agreed and not disputed. */
async function confirmPage(
  rows: ConfirmRow[],
  where: Prisma.AppointmentOccurrenceWhereInput,
  now: Date,
  run: OutcomeConfirmRun,
  ctx: {
    pastDeadline: () => boolean;
    failures: RunFailureReporter;
    /** Rows whose confirmation threw this run, reported once when the run ends. */
    failed: string[];
  },
): Promise<PageResult> {
  // Every window overlapping a row's booked time, however many the history holds.
  const outages = await readOverlappingOutages(prisma, rows);
  const closedBefore = now.getTime() - OUTCOME_REPORT_WINDOW_HOURS * 3_600_000;
  const strong: {
    id: string;
    appointmentId: string;
    outcome: NegativeMoneyOutcome;
    endsAt: Date;
    outcomeAt: Date;
    claim: boolean;
    classVoid: boolean;
  }[] = [];
  for (const row of rows) {
    if (!isNegativeMoneyOutcome(row.outcome) || !row.outcomeAt) continue;
    const reports = judgeRowReports(row, row.outcome, row.outcomeAt);
    if (reports === "disputed") {
      run.disputed++;
      continue;
    }
    // An open window applies early only on an agreeing report.
    if (row.outcomeAt.getTime() >= closedBefore && reports !== "agreed") {
      continue;
    }
    if (isStrongVerdict(row, row.outcome, outages)) {
      strong.push({
        id: row.id,
        appointmentId: row.appointmentId,
        outcome: row.outcome,
        endsAt: row.endsAt,
        outcomeAt: row.outcomeAt,
        claim: isNoShowProposal(row),
        classVoid: isClassVoid(row),
      });
    } else {
      run.weak++;
    }
  }
  // One CAS per row, so each is held only by a dispute in its own window; a relabel or confirm since the read skips it too.
  const counts = await Promise.all(
    strong
      .filter((row) => !row.claim && !row.classVoid)
      .map((row) =>
        prisma.appointmentOccurrence.updateMany({
          where: confirmGuard(where, row),
          data: { outcomeConfirmedAt: now },
        }),
      ),
  );
  run.confirmed += counts.reduce((sum, c) => sum + c.count, 0);
  // A class void (its own transaction, with notices) and a no-show claim (it drives a refund) run one
  // at a time inside the pass's share, in page order, so a cut names how far the page got.
  for (const row of strong.filter((r) => r.classVoid || r.claim)) {
    if (ctx.pastDeadline()) return { resumeAfter: keysetBefore(rows, row.id) };
    try {
      if (row.classVoid) {
        if (await confirmClassVoid(where, row, now)) run.confirmed++;
        continue;
      }
      const result = await confirmConsultantNoShow(row.id, {
        now,
        guard: confirmGuard(where, row),
        // Another proposed session of the booking is cancelled with this one only when this page judged it strong, closed or agreed, and undisputed too.
        siblingGuard: (id) => {
          const sibling = strong.find((r) => r.id === id);
          return sibling ? confirmGuard(where, sibling) : null;
        },
        errors: run.errors,
        failures: ctx.failures,
      });
      if (result.kind === "claimed") {
        run.confirmed++;
        run.claimed++;
      } else if (result.kind === "declined") {
        run.declined++;
      } else if (result.kind === "outage") {
        // An outage declared since this page's read; the next pass reads it and leaves the row weak.
        run.weak++;
      }
    } catch (error) {
      ctx.failed.push(row.id);
      run.errors.push(
        `Failed to ${row.classVoid ? "confirm the class void" : "claim the consultant no-show"} on ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return "judged";
}

/**
 * Confirms each negative verdict on strong evidence once its report window
 * closed or the harmed party agreed, newest first, by CAS from an unconfirmed
 * stamp; a weak or disputed one stays for ops.
 */
export async function confirmClosedOutcomes(
  now: Date,
  pastDeadline: () => boolean,
): Promise<OutcomeConfirmRun> {
  const run: OutcomeConfirmRun = {
    confirmed: 0,
    claimed: 0,
    declined: 0,
    weak: 0,
    disputed: 0,
    errors: [],
  };
  // Past its share before it starts, the pass reads nothing and leaves the stored cursor in place.
  if (pastDeadline()) return run;
  const where = confirmableVerdictWhere(now);
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
  const failures = createRunFailureReporter("bookings");
  const failed: string[] = [];
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
      const page = await confirmPage(rows, where, now, run, {
        pastDeadline,
        failures,
        failed,
      });
      // A page the deadline cut resumes at its first row not tried, so a row that fails slowly on every run is passed, not retried first.
      if (page !== "judged") {
        after = page.resumeAfter ?? after;
        break;
      }
      after =
        rows.length < OUTCOME_CONFIRM_PAGE
          ? null
          : { outcomeAt: last.outcomeAt, id: last.id };
      if (!after) break;
    }
  } catch (error) {
    run.errors.push(
      `Failed to confirm closed session outcomes: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    failures.flush();
  }
  // One console finding per run for the rows whose confirmation threw; the pass tries them again when the scan wraps.
  await reportStandingFinding({
    key: "session-outcome-sweep:confirm-failed",
    ids: failed,
    message: `${failed.length} negative verdict(s) could not be confirmed this run and were passed over until the scan wraps`,
  }).catch((error: unknown) => {
    run.errors.push(
      `Failed to report unconfirmed verdicts: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  run.checkpoint = after ? encodeCursor(after) : null;
  return run;
}

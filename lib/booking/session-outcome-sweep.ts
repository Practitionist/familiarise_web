/**
 * The one writer of an occurrence's outcome. The end + 1 h slot pass in
 * `auto-complete-appointments` settles each past SCHEDULED session's attendance
 * from Stream's own record (`settleOccurrenceAttendance`), asks
 * `classifySessionOutcome`, and writes COMPLETED, VOIDED or UNVERIFIED plus the
 * outcome columns in one CAS. The Stream webhooks and the orphan reconciler only close the room.
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
  NEEDS_HUMAN,
  NEEDS_HUMAN_ESCALATE_DAYS,
} from "./misses";
import { reportStandingFinding } from "@/lib/observability/standing-finding";
import { reportSentryMessage } from "@/lib/observability/report";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { onClassSessionVoided } from "./class-sessions";

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
      reason: "live-overrun" | "no-show-detector" | "attendance-unsettled";
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

type RoomEnd = {
  endedAt: Date | null;
  endedReason: string | null;
  streamCallId: string;
  attendanceSettledAt: Date | null;
};

const readRoomEnd = (meetingId: string): Promise<RoomEnd | null> =>
  prisma.meeting.findUnique({
    where: { id: meetingId },
    select: {
      endedAt: true,
      endedReason: true,
      streamCallId: true,
      attendanceSettledAt: true,
    },
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
    {
      occurrenceId: slot.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      meeting,
    },
    { now: ctx.now, failures: ctx.failures, deadlineAt: ctx.settleDeadlineAt },
  );
  if (settled.kind === "settled") {
    return { kind: "intervals", intervals: settled.intervals };
  }
  // Past Stream's retention nothing will come back; anything else is retried until the wait ends.
  const waited =
    ctx.now.getTime() - slot.endsAt.getTime() >= ATTENDANCE_SETTLE_WAIT_MS;
  return settled.kind === "expired" || waited
    ? { kind: "unreadable" }
    : { kind: "wait" };
}

/**
 * Takes the occurrence row, then the room row, and re-reads the room's end: an
 * end, a rotation or (for an unreadable park) a snapshot that committed since
 * the classification wins. NO KEY UPDATE leaves the presence inserts' FK checks free.
 */
async function roomChangedSinceRead(
  tx: Tx,
  occurrenceId: string,
  room: RoomEnd,
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
    (current.endedAt?.getTime() ?? null) !==
      (room.endedAt?.getTime() ?? null) ||
    current.endedReason !== room.endedReason ||
    current.streamCallId !== room.streamCallId ||
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
  fence: { room: RoomEnd | null; requireUnsettled: boolean },
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

  const moved = await writeSlotOutcomeTransaction(
    slot,
    presences,
    to,
    verdict,
    ctx.now,
    { room, requireUnsettled: evidence.kind === "unreadable" },
  );
  if (moved && evidence.kind === "unreadable") ctx.onUnreadable?.(slot.id);
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

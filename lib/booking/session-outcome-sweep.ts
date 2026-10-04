/**
 * #1569 D2 — the one writer of an occurrence's outcome. The end + 1 h slot pass
 * in `auto-complete-appointments` reads each past SCHEDULED session's presence,
 * asks `classifySessionOutcome`, and writes COMPLETED, VOIDED or UNVERIFIED plus
 * the outcome columns in one CAS. The Stream webhooks and the orphan reconciler
 * only close the room.
 */

import { OccurrenceCompletionStatus, type Prisma } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import {
  formatNotificationDateTime,
  resolveRecipientTimezones,
} from "@/lib/novu/humanize";
import { stageBell } from "@/lib/novu/stage-bell";
import { personalHref } from "@/lib/novu/resolve-href";
import {
  getCallParticipantSessionsFromStream,
  getCallPresenceEvidence,
} from "@/lib/stream/call-presence";
import { getAppUrl } from "@/lib/url";
import { isPastNoShowHandoff } from "./attendance";
import {
  classifySessionOutcome,
  type OutageWindow,
  type SessionOutcomeVerdict,
} from "./session-outcome";
import { SESSION_HOSTS_SELECT, sessionHostUserIds } from "./session-hosts";
import { transitionOccurrenceCompletion } from "./transitions";
import { liveParticipant, transitionParticipant } from "./participants";
import { NEEDS_HUMAN } from "./misses";
import { captureThrottled } from "@/lib/observability/throttled-capture";
import { onClassSessionVoided } from "./class-sessions";

/** Ends after which Stream must have sent participant events (#1543 watchdog). */
const FEED_EXPECTED_REASONS = new Set(["call_ended", "session_timeout"]);

export const OUTCOME_SLOT_SELECT = {
  id: true,
  appointmentId: true,
  startsAt: true,
  endsAt: true,
  meeting: {
    select: { streamCallId: true, endedAt: true, endedReason: true },
  },
  presences: { select: { userId: true, joinedAt: true, leftAt: true } },
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
}

export type SlotDecision =
  | { kind: "deferred"; reason: "live-overrun" | "no-show-detector" }
  | {
      kind: "written";
      to: OccurrenceCompletionStatus;
      verdict: SessionOutcomeVerdict;
      moved: boolean;
    };

/** Platform-wide DEGRADED/OFFLINE windows that overlap [from, now]. */
export async function readOutageWindows(
  db: Pick<Tx, "maintenanceWindow">,
  from: Date,
): Promise<OutageWindow[]> {
  const rows = await db.maintenanceWindow.findMany({
    where: {
      organizationId: null,
      startedAt: { not: null },
      // An ended window flips to OFF, so only an open one is read by phase.
      OR: [{ endedAt: null, phase: { not: "OFF" } }, { endedAt: { gt: from } }],
    },
    select: { startedAt: true, endedAt: true },
  });
  return rows
    .filter((r): r is { startedAt: Date; endedAt: Date | null } =>
      Boolean(r.startedAt),
    )
    .map((r) => ({ startsAt: r.startedAt, endsAt: r.endedAt }));
}

async function capOpenSlotPresences(
  slot: OutcomeSlot,
): Promise<OutcomeSlot["presences"]> {
  const { meeting } = slot;
  if (!slot.presences.some((p) => p.leftAt === null)) {
    return slot.presences;
  }
  const capAt = meeting?.endedAt ?? slot.endsAt;
  await prisma.meetingPresence?.updateMany?.({
    where: { appointmentOccurrenceId: slot.id, leftAt: null },
    data: { leftAt: capAt },
  });
  return slot.presences.map((p) =>
    p.leftAt === null ? { ...p, leftAt: capAt } : p,
  );
}

async function backfillMissingPresencesFromStream(
  slot: OutcomeSlot,
  presences: OutcomeSlot["presences"],
  report: Awaited<ReturnType<typeof getCallPresenceEvidence>>,
): Promise<OutcomeSlot["presences"]> {
  const { meeting } = slot;
  const seen = new Set(presences.map((p) => p.userId));
  if (!meeting || !report || report.unique <= seen.size) {
    return presences;
  }

  const backfilled =
    report.intervals ??
    (await getCallParticipantSessionsFromStream?.(
      meeting.streamCallId,
      report.sessionId,
    )) ??
    [];
  if (backfilled.length === 0) {
    return presences;
  }

  const seenSessionIds = new Set<string>();
  const resolved = backfilled
    .filter((b) => {
      if (seenSessionIds.has(b.userSessionId)) return false;
      seenSessionIds.add(b.userSessionId);
      return true;
    })
    .map((b) => ({
      userId: b.userId,
      userSessionId: b.userSessionId,
      joinedAt: b.joinedAt,
      leftAt: b.leftAt,
    }));

  const closedRows = resolved.filter((r) => r.leftAt !== null);
  const meetingRow =
    closedRows.length > 0
      ? await prisma.meeting?.findUnique?.({
          where: { streamCallId: meeting.streamCallId },
          select: { id: true },
        })
      : null;
  if (meetingRow?.id) {
    await prisma.meetingPresence?.createMany?.({
      data: closedRows.map((r) => ({
        meetingId: meetingRow.id,
        appointmentOccurrenceId: slot.id,
        userId: r.userId,
        userSessionId: r.userSessionId,
        joinedAt: r.joinedAt,
        leftAt: r.leftAt,
      })),
      skipDuplicates: true,
    });
  }

  const additionalPresences = resolved
    .filter(
      (r) =>
        !presences.some(
          (p) =>
            p.userId === r.userId &&
            p.joinedAt.getTime() === r.joinedAt.getTime(),
        ),
    )
    .map((r) => ({
      userId: r.userId,
      joinedAt: r.joinedAt,
      leftAt: r.leftAt,
    }));

  return [...presences, ...additionalPresences];
}

function writeSlotOutcomeTransaction(
  slot: OutcomeSlot,
  presences: OutcomeSlot["presences"],
  to: OccurrenceCompletionStatus,
  verdict: SessionOutcomeVerdict,
  now: Date,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
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
    if (count > 0 && verdict.outcome === "LEARNER_ABSENT") {
      await stageNoShowBells(tx, slot, "one-to-one");
    }
    // Owner decision — a group seat absent from a held session hears only of its recording.
    const isGroup = !!(slot.appointment.classId ?? slot.appointment.webinarId);
    if (count > 0 && verdict.outcome === "HELD" && isGroup) {
      await stageNoShowBells(tx, { ...slot, presences }, "group");
    }
    // A void is a class miss: bells, and the exit right re-checked in this tx.
    if (count > 0 && to === "VOIDED" && slot.appointment.classId) {
      await onClassSessionVoided(tx, {
        appointmentId: slot.appointmentId,
        occurrenceId: slot.id,
        startsAt: slot.startsAt,
        voidedAt: now,
        hostAttributed: verdict.hostAttributed,
      });
    }
    return count > 0;
  });
}

/** Classify one past session and write its outcome, or defer it. */
export async function decideSlotOutcome(
  slot: OutcomeSlot,
  ctx: OutcomeContext,
): Promise<SlotDecision> {
  const { meeting } = slot;
  // #1607 item 4 — a call still running past end + 1 h is an overrun, not a verdict.
  if (meeting && !meeting.endedAt && slot.presences.some((p) => !p.leftAt)) {
    return { kind: "deferred", reason: "live-overrun" };
  }

  let presences = await capOpenSlotPresences(slot);

  const feedGap =
    !!meeting?.endedAt &&
    FEED_EXPECTED_REASONS.has(meeting.endedReason ?? "") &&
    presences.length === 0;
  const report =
    meeting && (presences.length > 0 || feedGap)
      ? await getCallPresenceEvidence(meeting.streamCallId)
      : null;
  if (feedGap && (report?.unique ?? 0) > 0) ctx.onFeedGap?.();

  presences = await backfillMissingPresencesFromStream(slot, presences, report);

  const verdict = classifySessionOutcome({
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

/**
 * D7 — a 1:1 learner who never joined forfeits the session; one bell says so,
 * links "couldn't get in?" to support, and names the recording when there is
 * one. A group seat with no presence in a held session gets one bell only when
 * a recording exists, and nothing otherwise. No money moves either way.
 */
async function stageNoShowBells(
  tx: Tx,
  slot: OutcomeSlot,
  shape: "one-to-one" | "group",
) {
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
  const plan =
    shape === "group"
      ? (row?.class?.classPlan ?? row?.webinar?.webinarPlan)
      : (row?.consultation?.consultationPlan ??
        row?.subscription?.subscriptionPlan ??
        row?.trial?.subscriptionPlan);
  if (!row || !plan) return;
  const recording = plan.recordingEnabled
    ? await tx.recording.findFirst({
        where: {
          meeting: { appointmentOccurrenceId: slot.id },
          status: { in: ["READY", "AVAILABLE"] },
        },
        select: { id: true },
      })
    : null;
  if (shape === "group" && !recording) return;
  const present = new Set(slot.presences.map((p) => p.userId));
  const absent =
    shape === "group"
      ? row.participants.filter((seat) => !present.has(seat.userId))
      : row.participants;
  // One bell per seat, each in its own zone (the house format, like the
  // class-session bells) — a single UTC stamp was wrong for everyone
  // outside the platform zone.
  const zones = await resolveRecipientTimezones(
    absent.map((seat) => seat.userId),
    tx,
  );
  for (const seat of absent) {
    const profileId = seat.user.consulteeProfileId;
    const recordingUrl = profileId
      ? personalHref("consultee", profileId, "recordings")
      : `${getAppUrl()}/dashboard`;
    await stageBell(tx, {
      workflowId:
        shape === "group"
          ? NOVU_WORKFLOWS.SESSION_MISSED_RECORDING
          : NOVU_WORKFLOWS.SESSION_NO_SHOW,
      recipients: [seat.userId],
      payload: {
        planTitle: plan.title,
        dateTime:
          formatNotificationDateTime(slot.startsAt, zones.get(seat.userId)) ??
          slot.startsAt.toISOString(),
        supportUrl: `${getAppUrl()}/support`,
        ...(recording && { recordingUrl }),
      },
      dedupeKey: `no-show:${slot.id}:${seat.userId}`,
    });
  }
}

/** Owner decision — a needs-human item older than this raises a Sentry warning. */
export const NEEDS_HUMAN_ALERT_HOURS = 72;

/**
 * Warn once per 15 minutes while any session has waited in the ops
 * needs-human queue for more than 72 hours; the hold on its money stays.
 */
export async function alertStaleNeedsHuman(
  db: Pick<Tx, "appointmentOccurrence">,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - NEEDS_HUMAN_ALERT_HOURS * 3_600_000);
  const stale = await db.appointmentOccurrence.count({
    where: {
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
    },
  });
  if (stale > 0) {
    captureThrottled(
      "needs-human-age",
      new Error(`${stale} session(s) waited over 72 h for an ops decision`),
      {
        subsystem: "bookings",
        op: "needs-human-age",
        level: "warning",
        extra: { stale },
      },
      15 * 60_000,
    );
  }
  return stale;
}

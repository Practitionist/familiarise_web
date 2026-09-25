/**
 * #1569 D2 — the one writer of an occurrence's outcome. The end + 1 h slot pass
 * in `auto-complete-appointments` reads each past SCHEDULED session's presence,
 * asks `classifySessionOutcome`, and writes COMPLETED, VOIDED or UNVERIFIED plus
 * the outcome columns in one CAS. The Stream webhooks and the orphan reconciler
 * only close the room.
 */

import { OccurrenceCompletionStatus, type Prisma } from "@prisma/client";
import { format } from "date-fns";

import prisma, { type Tx } from "@/lib/prisma";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { stageBell } from "@/lib/novu/stage-bell";
import { personalHref } from "@/lib/novu/resolve-href";
import { getCallPresenceEvidence } from "@/lib/stream/call-presence";
import { getAppUrl } from "@/lib/url";
import { isPastNoShowHandoff } from "./attendance";
import {
  classifySessionOutcome,
  type OutageWindow,
  type SessionOutcomeVerdict,
} from "./session-outcome";
import { SESSION_HOSTS_SELECT, sessionHostUserIds } from "./session-hosts";
import { transitionOccurrenceCompletion } from "./transitions";
import { liveParticipant } from "./participants";

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
  const feedGap =
    !!meeting?.endedAt &&
    FEED_EXPECTED_REASONS.has(meeting.endedReason ?? "") &&
    slot.presences.length === 0;
  const report =
    meeting && (slot.presences.length > 0 || feedGap)
      ? await getCallPresenceEvidence(meeting.streamCallId)
      : null;
  if (feedGap && (report?.unique ?? 0) > 0) ctx.onFeedGap?.();

  const verdict = classifySessionOutcome({
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    hostUserIds: sessionHostUserIds(slot.appointment),
    intervals: slot.presences,
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
    if (!isPastNoShowHandoff(slot.endsAt, ctx.now)) {
      return { kind: "deferred", reason: "no-show-detector" };
    }
    to = OccurrenceCompletionStatus.UNVERIFIED;
  }

  const moved = await prisma.$transaction(async (tx) => {
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
        outcomeAt: ctx.now,
        deliveredMinutes: verdict.deliveredMinutes,
        lostMinutes: verdict.lostMinutes,
        ...(to === "VOIDED" && { voidedAt: ctx.now }),
        ...(to === "COMPLETED" && { completedAt: ctx.now }),
      },
      reason: `session-outcome:${verdict.outcome}`,
      organizationId: slot.appointment.organizationId,
      allowZero: true,
    });
    if (count > 0 && verdict.outcome === "LEARNER_ABSENT") {
      await stageLearnerNoShowBells(tx, slot);
    }
    return count > 0;
  });
  return { kind: "written", to, verdict, moved };
}

const PLAN_BELL = { select: { title: true, recordingEnabled: true } } as const;

/**
 * D7 — a 1:1 learner who never joined forfeits the session; one bell says so,
 * links "couldn't get in?" to support, and names the recording when there is one.
 */
async function stageLearnerNoShowBells(tx: Tx, slot: OutcomeSlot) {
  const row = await tx.appointment.findUnique({
    where: { id: slot.appointmentId },
    select: {
      consultation: { select: { consultationPlan: PLAN_BELL } },
      subscription: { select: { subscriptionPlan: PLAN_BELL } },
      trial: { select: { subscriptionPlan: PLAN_BELL } },
      participants: {
        where: { role: "CONSULTEE", ...liveParticipant() },
        select: {
          userId: true,
          user: { select: { consulteeProfileId: true } },
        },
      },
    },
  });
  // Group shapes write nothing per seat (design §3.6); only 1:1 plans reach here.
  const plan =
    row?.consultation?.consultationPlan ??
    row?.subscription?.subscriptionPlan ??
    row?.trial?.subscriptionPlan;
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
  for (const seat of row.participants) {
    const profileId = seat.user.consulteeProfileId;
    await stageBell(tx, {
      workflowId: NOVU_WORKFLOWS.SESSION_NO_SHOW,
      recipients: [seat.userId],
      payload: {
        planTitle: plan.title,
        // Same wording as the class-session bells (class-sessions.ts `when`).
        dateTime: format(slot.startsAt, "EEE d MMM yyyy, HH:mm 'UTC'"),
        supportUrl: `${getAppUrl()}/support`,
        ...(recording &&
          profileId && {
            recordingUrl: personalHref("consultee", profileId, "recordings"),
          }),
      },
      dedupeKey: `no-show:${slot.id}:${seat.userId}`,
    });
  }
}

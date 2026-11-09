/**
 * Moving a sold class's upcoming sessions to a new weekly pattern in one step:
 * the series twin of the webinar re-time. Every session that is still at
 * least 24 hours away moves in place (its ordinal, Meeting and recordings stay
 * attached) and is stamped `movedAt`; sessions inside 24 hours keep their
 * time. The host and ACCEPTED co-hosts must be free at every new time;
 * attendees busy then are flagged, never blocking; every seat may leave with
 * a full refund until `retimeBy`. A move is not a cancel, so it is never a
 * host miss and never counts toward a learner's exit right.
 *
 * Lock order: event checkout → appointment → host + co-host slot batch.
 */
import type { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { isExclusionViolation } from "@/lib/db/pg-errors";
import { recomputeEarningsHold } from "@/lib/payments/payouts/earnings-hold";
import {
  withAppointmentLock,
  withEventCheckoutLock,
} from "@/utils/appointmentlock";
import { notifyAppointmentRescheduled } from "@/lib/novu/service";
import type { StagedTrigger } from "@/lib/novu/outbox";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { stageAppointmentRescheduledEmail } from "@/lib/email/senders/booking";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { planTitleOrSessionLabel } from "@/lib/novu/humanize";
import { seatHoldingParticipant } from "@/utils/scheduling-engine/occupancyPolicy";
import { BookingRuleError } from "./booking-rule-error";
import { eventTimeRefusal } from "./event-time-rules";
import { RESCHEDULE_LEAD_TIME_MS } from "./lead-time";
import {
  acceptedCohostProfileIds,
  hostBatchEntries,
  withHostSlotBatch,
} from "./host-slot-batch";
import {
  verifyCohostsFreeForMove,
  verifyHostFreeForMove,
  type HostedClass,
} from "./class-sessions";
import {
  attendeeClashes,
  extendRetimeLeave,
  RETIME_TX_OPTIONS,
  retimeLeaveUntil,
  splitByClash,
} from "./retime-leave";

export type ClassSeriesRetimeResult = {
  moved: number;
  retimeBy: Date;
  attendeesWithClash: number;
};

/** The live, confirmed sessions a series move may touch: at least 24 hours away. */
const MOVABLE_SESSION_WHERE = {
  deletedAt: null,
  completionStatus: "SCHEDULED",
  isTentative: false,
} satisfies Prisma.AppointmentOccurrenceWhereInput;

function refuse(message: string): BookingRuleError {
  return new BookingRuleError("RETIME_NOT_ALLOWED", message);
}

/**
 * Moves the class's movable sessions to `starts` (one per movable session, in
 * order), keeping each session's length. Refuses with RETIME_NOT_ALLOWED when
 * the count differs or the class changed meanwhile, EVENT_TIME_INVALID for an
 * off-grid or too-soon start, SCHEDULE_CONFLICT when the host's calendar is
 * taken.
 */
export async function retimeClassSeries(args: {
  hosted: HostedClass;
  starts: Date[];
  actorUserId: string;
}): Promise<ClassSeriesRetimeResult> {
  const { hosted, actorUserId } = args;
  const appointmentId = hosted.appointment.id;
  const plan = hosted.cls.classPlan;
  const now = new Date();
  const starts = [...args.starts].sort((a, b) => a.getTime() - b.getTime());

  for (const start of starts) {
    const refusal = eventTimeRefusal(start, "retime", now);
    if (refusal) throw new BookingRuleError(refusal.code, refusal.message, 400);
  }

  const cls = await prisma.class.findUnique({
    where: { id: hosted.cls.id },
    select: { status: true },
  });
  if (cls?.status !== "SCHEDULED") {
    throw refuse("Only a published class with upcoming sessions can be moved.");
  }
  const movable = await prisma.appointmentOccurrence.findMany({
    where: {
      appointmentId,
      ...MOVABLE_SESSION_WHERE,
      startsAt: { gte: new Date(now.getTime() + RESCHEDULE_LEAD_TIME_MS) },
    },
    orderBy: { startsAt: "asc" },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      consultantProfileId: true,
    },
  });
  if (movable.length === 0) {
    throw refuse(
      "No session is at least 24 hours away, so there is nothing to move. Cancel a session and schedule a make-up instead.",
    );
  }
  if (starts.length !== movable.length) {
    throw refuse(
      `Pick ${movable.length} new times, one for each session at least 24 hours away.`,
    );
  }

  const windows = movable.map((session, index) => ({
    session,
    startsAt: starts[index],
    endsAt: new Date(
      starts[index].getTime() +
        (session.endsAt.getTime() - session.startsAt.getTime()),
    ),
  }));
  for (let i = 1; i < windows.length; i += 1) {
    if (windows[i].startsAt < windows[i - 1].endsAt) {
      throw new BookingRuleError(
        "EVENT_TIME_INVALID",
        "Two of the new times overlap. Space the sessions apart.",
        400,
      );
    }
  }

  const hostProfileId =
    movable[0].consultantProfileId ?? plan.consultantProfileId;
  const profiles = [
    ...(hostProfileId ? [hostProfileId] : []),
    ...(await acceptedCohostProfileIds("CLASS", plan.id)),
  ];
  const dashboardUrl = notificationHref(
    hosted.appointment.organizationId,
    "appointments",
  );
  const firstOld = movable[0].startsAt;
  const firstNew = windows[0].startsAt;

  const result = await withEventCheckoutLock(
    { appointmentType: "CLASS", eventId: hosted.cls.id },
    () =>
      withAppointmentLock(appointmentId, () =>
        withHostSlotBatch(
          hostBatchEntries(
            profiles,
            windows.map(({ startsAt, endsAt }) => ({ startsAt, endsAt })),
          ),
          () =>
            prisma.$transaction(async (tx) => {
              for (const { startsAt, endsAt } of windows) {
                await verifyCohostsFreeForMove(
                  tx,
                  "CLASS",
                  plan.id,
                  startsAt,
                  endsAt,
                  appointmentId,
                );
                if (hostProfileId) {
                  await verifyHostFreeForMove(tx, {
                    consultantProfileId: hostProfileId,
                    consultantUserId: plan.consultantProfile?.user.id ?? "",
                    startsAt,
                    endsAt,
                    appointmentId,
                  });
                }
              }
              // Lift the moving rows out of the overlap constraint first, so a
              // session may take another's old time; every row is confirmed
              // again below, where the constraint judges the new times.
              const lifted = await tx.appointmentOccurrence.updateMany({
                where: {
                  id: { in: movable.map((s) => s.id) },
                  appointmentId,
                  ...MOVABLE_SESSION_WHERE,
                },
                data: { isTentative: true },
              });
              if (lifted.count !== movable.length) {
                throw refuse(
                  "This class changed while you were moving it. Refresh and try again.",
                );
              }
              try {
                for (const { session, startsAt, endsAt } of windows) {
                  await tx.appointmentOccurrence.updateMany({
                    where: { id: session.id, startsAt: session.startsAt },
                    data: {
                      startsAt,
                      endsAt,
                      movedAt: now,
                      isTentative: false,
                    },
                  });
                }
              } catch (error) {
                if (isExclusionViolation(error)) {
                  throw new BookingRuleError(
                    "SCHEDULE_CONFLICT",
                    "One of the new times conflicts with another confirmed session on your calendar.",
                    409,
                  );
                }
                throw error;
              }

              const seats = await tx.appointmentParticipant.findMany({
                where: { appointmentId, ...seatHoldingParticipant(now) },
                select: { userId: true },
              });
              const seatUserIds = seats.map((s) => s.userId);
              const clashing = new Set<string>();
              for (const { startsAt, endsAt } of windows) {
                for (const userId of await attendeeClashes(
                  tx,
                  appointmentId,
                  seatUserIds,
                  { startsAt, endsAt },
                )) {
                  clashing.add(userId);
                }
              }
              const retimeBy = retimeLeaveUntil(now, firstNew);
              await extendRetimeLeave(tx, "class", hosted.cls.id, retimeBy);
              await recomputeEarningsHold(tx, appointmentId);

              const groups = splitByClash(
                seatUserIds.filter((id) => id !== actorUserId),
                clashing,
              );
              const bells: Array<StagedTrigger | undefined> = [];
              for (const group of groups) {
                const staged = await notifyAppointmentRescheduled(
                  group.userIds,
                  {
                    ...notificationScope(hosted.appointment.organizationId),
                    outcome: "MOVED",
                    oldDateTime: firstOld.toISOString(),
                    newDateTime: firstNew.toISOString(),
                    leaveBy: retimeBy.toISOString(),
                    clash: group.clash,
                    appointmentType: "class",
                    consultantName:
                      plan.consultantProfile?.user.name ?? "Your host",
                    consulteeName: "Participant",
                    planTitle: planTitleOrSessionLabel(plan.title, "class"),
                    dashboardUrl,
                  },
                  { tx, deferAttempt: true },
                );
                bells.push(...staged.map((r) => r.staged));
              }
              return {
                groups,
                bells,
                attendeesWithClash: clashing.size,
                retimeBy,
              };
            }, RETIME_TX_OPTIONS),
        ),
      ),
  );

  const emails = await Promise.all(
    result.groups.map((group) =>
      stageAppointmentRescheduledEmail(prisma, {
        appointmentId,
        userIds: group.userIds,
        outcome: "MOVED",
        appointmentType: "class",
        oldStartsAt: firstOld,
        newStartsAt: firstNew,
        leaveBy: result.retimeBy,
        clash: group.clash,
        proposedBy: plan.consultantProfile?.user.name ?? undefined,
        dashboardUrl,
      }).catch(() => []),
    ),
  );
  await flushNotificationsAfter(
    {
      bells: result.bells,
      emails: [{ rows: emails.flat(), emailType: "APPOINTMENT_RESCHEDULED" }],
    },
    "class-series-retime",
  );

  return {
    moved: windows.length,
    retimeBy: result.retimeBy,
    attendeesWithClash: result.attendeesWithClash,
  };
}

/** The sessions a series move would touch, for the host's picker: count and length. */
export async function movableClassSessions(
  appointmentId: string,
  now: Date = new Date(),
): Promise<{
  count: number;
  sessionMinutes: number;
  firstStartsAt: Date | null;
}> {
  const rows = await prisma.appointmentOccurrence.findMany({
    where: {
      appointmentId,
      ...MOVABLE_SESSION_WHERE,
      startsAt: { gte: new Date(now.getTime() + RESCHEDULE_LEAD_TIME_MS) },
    },
    orderBy: { startsAt: "asc" },
    select: { startsAt: true, endsAt: true },
  });
  const first = rows[0];
  return {
    count: rows.length,
    sessionMinutes: first
      ? Math.round((first.endsAt.getTime() - first.startsAt.getTime()) / 60_000)
      : 60,
    firstStartsAt: first?.startsAt ?? null,
  };
}

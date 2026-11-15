/**
 * Re-timing a published webinar: the host picks the new date in one step. The
 * session row moves in place (its Meeting and recordings stay attached) and is
 * stamped `movedAt`; the host and ACCEPTED co-hosts must be free at the new
 * time, attendees busy then are flagged but never block it, and every seat
 * bought before the move may leave with a full refund until `retimeBy`.
 *
 * Lock order: event checkout → appointment → host + co-host slot batch.
 */
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
import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";
import { seatHoldingParticipant } from "@/utils/scheduling-engine/occupancyPolicy";
import { BookingRuleError } from "./booking-rule-error";
import { isTooSoonFor, RESCHEDULE_MIN_LEAD_HOURS } from "./lead-time";
import {
  acceptedCohostProfileIds,
  hostBatchEntries,
  withHostSlotBatch,
} from "./host-slot-batch";
import {
  verifyCohostsFreeForMove,
  verifyHostFreeForMove,
} from "./class-sessions";
import {
  attendeeClashes,
  extendRetimeLeave,
  RETIME_TX_OPTIONS,
  retimeLeaveUntil,
  splitByClash,
} from "./retime-leave";

export type RetimeResult = {
  occurrenceId: string;
  startsAt: Date;
  endsAt: Date;
  retimeBy: Date;
  /** Attendees who already hold another booking at the new time. */
  attendeesWithClash: number;
};

function refuse(
  code: "RETIME_NOT_ALLOWED" | "RETIME_TOO_SOON",
  message: string,
): BookingRuleError {
  return new BookingRuleError(code, message);
}

/** Moves a webinar's one live session to `startsAt`, keeping its length. */
export async function retimeWebinar(args: {
  appointmentId: string;
  startsAt: Date;
  actorUserId: string;
}): Promise<RetimeResult> {
  const { appointmentId, startsAt } = args;
  const pre = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      organizationId: true,
      webinar: {
        select: {
          id: true,
          status: true,
          webinarPlan: {
            select: {
              id: true,
              title: true,
              consultantProfileId: true,
              consultantProfile: {
                select: { user: { select: { id: true, name: true } } },
              },
            },
          },
        },
      },
      occurrences: {
        where: {
          deletedAt: null,
          completionStatus: "SCHEDULED",
          isTentative: false,
        },
        orderBy: { startsAt: "asc" },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          consultantProfileId: true,
        },
      },
    },
  });
  const webinar = pre?.webinar;
  const session = pre?.occurrences[0];
  if (!pre || !webinar || webinar.status !== "SCHEDULED" || !session) {
    throw refuse(
      "RETIME_NOT_ALLOWED",
      "Only a published webinar with an upcoming session can be re-timed.",
    );
  }
  const now = new Date();
  // The one reschedule boundary: a start at or inside 24 hours is too soon.
  const tooSoon = (at: Date) =>
    isTooSoonFor("reschedule", { settled: true }, at.getTime(), now.getTime());
  if (tooSoon(session.startsAt)) {
    throw refuse(
      "RETIME_TOO_SOON",
      `A webinar can't be re-timed within ${RESCHEDULE_MIN_LEAD_HOURS} hours of its start. Cancel it instead — everyone is refunded in full.`,
    );
  }
  if (tooSoon(startsAt) || startsAt.getTime() % SCHEDULING_INTERVAL_MS !== 0) {
    throw refuse(
      "RETIME_TOO_SOON",
      `Pick a new time on the half hour, at least ${RESCHEDULE_MIN_LEAD_HOURS} hours away.`,
    );
  }
  const endsAt = new Date(
    startsAt.getTime() +
      (session.endsAt.getTime() - session.startsAt.getTime()),
  );
  const plan = webinar.webinarPlan;
  const hostProfileId = session.consultantProfileId ?? plan.consultantProfileId;
  const profiles = [
    ...(hostProfileId ? [hostProfileId] : []),
    ...(await acceptedCohostProfileIds("WEBINAR", plan.id)),
  ];

  const dashboardUrl = notificationHref(pre.organizationId, "appointments");
  const result = await withEventCheckoutLock(
    { appointmentType: "WEBINAR", eventId: webinar.id },
    () =>
      withAppointmentLock(appointmentId, () =>
        withHostSlotBatch(
          hostBatchEntries(profiles, [{ startsAt, endsAt }]),
          () =>
            prisma.$transaction(async (tx) => {
              await verifyCohostsFreeForMove(
                tx,
                "WEBINAR",
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
              const seats = await tx.appointmentParticipant.findMany({
                where: {
                  appointmentId,
                  ...seatHoldingParticipant(now),
                },
                select: { userId: true },
              });
              const seatUserIds = seats.map((s) => s.userId);
              const clashing = new Set(
                await attendeeClashes(tx, appointmentId, seatUserIds, {
                  startsAt,
                  endsAt,
                }),
              );
              let moved;
              try {
                moved = await tx.appointmentOccurrence.updateMany({
                  where: {
                    id: session.id,
                    appointmentId,
                    deletedAt: null,
                    completionStatus: "SCHEDULED",
                    startsAt: session.startsAt,
                  },
                  data: { startsAt, endsAt, movedAt: now },
                });
              } catch (error) {
                if (isExclusionViolation(error)) {
                  throw new BookingRuleError(
                    "SCHEDULE_CONFLICT",
                    "That time conflicts with another confirmed session on your calendar.",
                    409,
                  );
                }
                throw error;
              }
              if (moved.count === 0) {
                throw refuse(
                  "RETIME_NOT_ALLOWED",
                  "This webinar changed while you were re-timing it. Refresh and try again.",
                );
              }
              const retimeBy = await extendRetimeLeave(
                tx,
                "webinar",
                webinar.id,
                retimeLeaveUntil(now, startsAt),
              );
              await recomputeEarningsHold(tx, appointmentId);
              // The bells commit with the move; a crash after commit loses none.
              const groups = splitByClash(
                seatUserIds.filter((id) => id !== args.actorUserId),
                clashing,
              );
              const bells: Array<StagedTrigger | undefined> = [];
              for (const group of groups) {
                const staged = await notifyAppointmentRescheduled(
                  group.userIds,
                  {
                    ...notificationScope(pre.organizationId),
                    outcome: "MOVED",
                    oldDateTime: session.startsAt.toISOString(),
                    newDateTime: startsAt.toISOString(),
                    leaveBy: retimeBy.toISOString(),
                    clash: group.clash,
                    appointmentType: "webinar",
                    consultantName:
                      plan.consultantProfile?.user.name ?? "Your host",
                    consulteeName: "Participant",
                    planTitle: planTitleOrSessionLabel(plan.title, "webinar"),
                    dashboardUrl,
                  },
                  {
                    tx,
                    deferAttempt: true,
                    required: {
                      kind: "EVENT_MOVED",
                      recipients: group.userIds,
                    },
                  },
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

  // Rendering stays outside the transaction; the bells above already committed.
  const emails = await Promise.all(
    result.groups.map((group) =>
      stageAppointmentRescheduledEmail(prisma, {
        appointmentId,
        userIds: group.userIds,
        outcome: "MOVED",
        appointmentType: "webinar",
        oldStartsAt: session.startsAt,
        newStartsAt: startsAt,
        leaveBy: result.retimeBy,
        clash: group.clash,
        proposedBy: plan.consultantProfile?.user.name ?? undefined,
        requiredFor: group.userIds,
        dashboardUrl,
      }).catch(() => []),
    ),
  );
  await flushNotificationsAfter(
    {
      bells: result.bells,
      emails: [{ rows: emails.flat(), emailType: "APPOINTMENT_RESCHEDULED" }],
    },
    "event-retime",
  );

  return {
    occurrenceId: session.id,
    startsAt,
    endsAt,
    retimeBy: result.retimeBy,
    attendeesWithClash: result.attendeesWithClash,
  };
}

/**
 * D8/D9 — the consultee returns one live subscription session to the plan.
 *
 * The session is released through the CAS helper to CANCELLED without a
 * tombstone (it stays countable, frees the expert's time and its ordinal), the
 * entitlement counts it as remaining again, and `planEndsAt` moves 7 days in
 * the same conditional write that spends one of the two returns. No money moves.
 */
import {
  AppointmentStatus,
  OccurrenceCompletionStatus,
  Prisma,
} from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { withAppointmentLock } from "@/utils/appointmentlock";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { transitionOccurrenceCompletion } from "@/lib/booking/transitions";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { stageBells } from "@/lib/novu/stage-bell";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import {
  DEFAULT_NOTIFICATION_TIMEZONE,
  formatNotificationDateTime,
  resolveRecipientTimezones,
} from "@/lib/novu/humanize";
import { stageAppointmentCancelledEmail } from "@/lib/email/senders/booking";
import { goHref } from "@/lib/dashboard/go";
import { BookingRuleError } from "./booking-rule-error";
import { subscriptionPlanEnd } from "./entitlement";
import {
  RETURN_BLOCK_COPY,
  RETURN_CAP,
  RETURN_EXTENSION_MS,
  RETURN_HISTORY_REASON,
  RETURN_NOTICE_HOURS,
} from "./session-return-rules";
import { stageNoticesForFreedWindows } from "@/lib/booking/backup-interest";

const HOUR_MS = 3_600_000;

export class SessionReturnForbiddenError extends Error {
  constructor() {
    super("Only the person who booked this plan can return its sessions.");
    this.name = "SessionReturnForbiddenError";
  }
}

export class SessionReturnNotFoundError extends Error {
  constructor() {
    super("Session not found");
    this.name = "SessionReturnNotFoundError";
  }
}

interface SessionReturnResult {
  occurrenceId: string;
  sessionsReturned: number;
  planEndsAt: string;
}

const RETURN_SELECT = {
  id: true,
  appointmentId: true,
  startsAt: true,
  endsAt: true,
  consultantProfileId: true,
  completionStatus: true,
  isTentative: true,
  deletedAt: true,
  appointment: {
    select: {
      organizationId: true,
      subscription: {
        select: {
          id: true,
          status: true,
          requestedById: true,
          sessionsReturned: true,
          planEndsAt: true,
          schedulingPeriodStartsAt: true,
          schedulingTimezone: true,
          requestedBy: { select: { user: { select: { name: true } } } },
          subscriptionPlan: {
            select: {
              title: true,
              durationInMonths: true,
              consultantProfile: {
                select: { user: { select: { id: true, name: true } } },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.AppointmentOccurrenceSelect;

async function dbNow(tx: Tx): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>(
    Prisma.sql`SELECT now() AS now`,
  );
  return row.now;
}

const refuse = (
  code: ConstructorParameters<typeof BookingRuleError>[0],
  message: string,
) => new BookingRuleError(code, message);

export async function returnSessionToPlan(args: {
  appointmentId: string;
  occurrenceId: string;
  actorUserId: string;
  consulteeProfileId: string | null;
}): Promise<SessionReturnResult> {
  const committed = await withAppointmentLock(args.appointmentId, () =>
    withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const occ = await tx.appointmentOccurrence.findUnique({
            where: { id: args.occurrenceId },
            select: RETURN_SELECT,
          });
          const sub = occ?.appointment.subscription;
          if (!occ || occ.appointmentId !== args.appointmentId || !sub) {
            throw new SessionReturnNotFoundError();
          }
          if (
            !args.consulteeProfileId ||
            sub.requestedById !== args.consulteeProfileId
          ) {
            throw new SessionReturnForbiddenError();
          }
          if (sub.status !== AppointmentStatus.APPROVED) {
            throw refuse(
              "SESSION_NOT_RETURNABLE",
              "Only a session of an active plan can be returned.",
            );
          }
          if (
            occ.completionStatus !== OccurrenceCompletionStatus.SCHEDULED ||
            occ.isTentative ||
            occ.deletedAt
          ) {
            throw refuse(
              "SESSION_NOT_RETURNABLE",
              "This session can no longer be returned — it was moved, cancelled or already returned.",
            );
          }
          if (sub.sessionsReturned >= RETURN_CAP) {
            throw refuse("RETURN_CAP_REACHED", RETURN_BLOCK_COPY.CAP_REACHED);
          }
          const now = await dbNow(tx);
          const cutoff = new Date(
            now.getTime() + RETURN_NOTICE_HOURS * HOUR_MS,
          );
          if (occ.startsAt < cutoff) {
            throw refuse(
              "RETURN_WINDOW_CLOSED",
              RETURN_BLOCK_COPY.WINDOW_CLOSED,
            );
          }
          const openReschedule = await tx.rescheduleRequest.findFirst({
            where: { openForAppointmentId: args.appointmentId },
            select: { id: true },
          });
          if (openReschedule) {
            throw refuse(
              "RETURN_RESCHEDULE_OPEN",
              RETURN_BLOCK_COPY.RESCHEDULE_OPEN,
            );
          }
          const dispute = await tx.dispute.findFirst({
            where: {
              payment: { appointmentId: args.appointmentId },
              status: { notIn: DISPUTE_INACTIVE_FOR_GATING },
            },
            select: { id: true },
          });
          if (dispute) {
            throw refuse(
              "DISPUTE_ACTIVE",
              "This plan has an open payment dispute, so its sessions can't be returned until it resolves.",
            );
          }

          const moved = await transitionOccurrenceCompletion(tx, {
            where: {
              id: occ.id,
              appointmentId: args.appointmentId,
              isTentative: false,
              deletedAt: null,
              startsAt: { gte: cutoff },
            },
            to: OccurrenceCompletionStatus.CANCELLED,
            fromIn: [OccurrenceCompletionStatus.SCHEDULED],
            actorUserId: args.actorUserId,
            reason: RETURN_HISTORY_REASON,
            organizationId: occ.appointment.organizationId,
            appointmentId: args.appointmentId,
            allowZero: true,
          });
          if (moved === 0) {
            throw refuse(
              "SESSION_NOT_RETURNABLE",
              "This session can no longer be returned — it was moved, cancelled or already returned.",
            );
          }
          if (occ.consultantProfileId) {
            await stageNoticesForFreedWindows(tx, occ.consultantProfileId, [
              occ,
            ]);
          }

          // The counter and the extension move together, so a plan is extended
          // exactly once per return and never past RETURN_CAP returns.
          const endsAt = new Date(
            subscriptionPlanEnd(sub).getTime() + RETURN_EXTENSION_MS,
          );
          const spent = await tx.subscription.updateMany({
            where: {
              id: sub.id,
              status: AppointmentStatus.APPROVED,
              sessionsReturned: sub.sessionsReturned,
            },
            data: {
              sessionsReturned: { increment: 1 },
              planEndsAt: endsAt,
            },
          });
          if (spent.count === 0) {
            throw refuse("RETURN_CAP_REACHED", RETURN_BLOCK_COPY.CAP_REACHED);
          }

          const expert = sub.subscriptionPlan.consultantProfile?.user;
          const consulteeName = sub.requestedBy?.user?.name ?? "Your client";
          const reason =
            "they returned it to their plan, so it can be booked again";
          const dashboardUrl = goHref("expert", "requests");
          let bell = null;
          let emails: Awaited<
            ReturnType<typeof stageAppointmentCancelledEmail>
          > = [];
          if (expert) {
            const zones = await resolveRecipientTimezones([expert.id], tx);
            const zone = zones.get(expert.id) ?? DEFAULT_NOTIFICATION_TIMEZONE;
            bell = await stageBells(tx, {
              workflowId: NOVU_WORKFLOWS.APPOINTMENT_CANCELLED,
              recipients: [expert.id],
              payload: {
                appointmentType: "subscription session",
                planTitle: sub.subscriptionPlan.title,
                consultantName: expert.name ?? "Consultant",
                consulteeName,
                cancelledBy: consulteeName,
                reason,
                dateTime: formatNotificationDateTime(occ.startsAt, zone),
                dashboardUrl,
              },
              dedupeKey: `occ-return:${occ.id}`,
            });
            emails = await stageAppointmentCancelledEmail(tx, {
              appointmentId: args.appointmentId,
              userIds: [expert.id],
              startsAt: occ.startsAt,
              cancelledBy: consulteeName,
              reason,
              dashboardUrl,
            });
          }
          return {
            result: {
              occurrenceId: occ.id,
              sessionsReturned: sub.sessionsReturned + 1,
              planEndsAt: endsAt.toISOString(),
            },
            bell,
            emails,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ),
  );
  await flushNotificationsAfter(
    {
      bells: committed.bell ?? [],
      emails: [{ rows: committed.emails, emailType: "APPOINTMENT_CANCELLED" }],
    },
    "session-return",
  );
  return committed.result;
}

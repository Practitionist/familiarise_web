import prisma from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";
import { withAppointmentLock } from "@/utils/appointmentlock";
import {
  RESCHEDULE_OPEN_STATUSES,
  transitionRescheduleRequest,
} from "@/lib/booking/transitions";
import {
  reportPartialRestore,
  restoreRescheduledBooking,
} from "@/lib/booking/reschedule-restore";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { notifyAppointmentRescheduled } from "@/lib/novu";
import { EMAIL_BUDGET_MS, sendAppointmentRescheduledEmail } from "@/lib/email";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";

/**
 * The initiator takes their own reschedule back, and the booking returns to
 * exactly what it was. The restore itself is shared with expiry
 * (`lib/booking/reschedule-restore.ts`, #1846); a decline is the one ending
 * that leaves the slots released.
 */
export async function withdrawRescheduleRequest(args: {
  rescheduleRequestId: string;
  /** Must be the initiator. The caller is responsible for proving that. */
  withdrawnById: string;
}): Promise<{ withdrawn: boolean; reason?: string }> {
  const { rescheduleRequestId, withdrawnById } = args;

  const request = await prisma.rescheduleRequest.findUnique({
    where: { id: rescheduleRequestId },
    select: {
      id: true,
      status: true,
      initiatedById: true,
      releasedOccurrenceIds: true,
      appointmentId: true,
      createdAt: true,
      appointment: {
        select: {
          consultationId: true,
          subscriptionId: true,
        },
      },
    },
  });

  if (!request) return { withdrawn: false, reason: "PROPOSAL_NOT_FOUND" };

  // Withdrawal is the initiator's alone. The other side already has Decline,
  // which ends the same request with a different meaning and a different
  // outcome for the slots — giving them this too would just be a second
  // Decline wearing a friendlier word.
  if (request.initiatedById !== withdrawnById) {
    return { withdrawn: false, reason: "NOT_INITIATOR" };
  }
  if (!RESCHEDULE_OPEN_STATUSES.includes(request.status)) {
    return { withdrawn: false, reason: "PROPOSAL_NOT_OPEN" };
  }

  let restored = 0;
  try {
    // #1583 A-P0-04 — the withdraw is a lifecycle mutation like accept and
    // cancel; it serialises on the appointment atom, and the tx opens inside.
    await withAppointmentLock(request.appointmentId, () =>
      prisma.$transaction(async (tx) => {
        // The CAS is the guard: if the other party answered while we were
        // deciding, this matches zero rows and throws rather than un-releasing
        // slots that a concurrent accept has already re-confirmed.
        await transitionRescheduleRequest(tx, {
          actorUserId: withdrawnById,
          appointmentId: request.appointmentId,
          where: { id: request.id },
          to: "WITHDRAWN",
          data: { resolvedById: withdrawnById },
        });

        restored = await restoreRescheduledBooking(tx, request, {
          actorUserId: withdrawnById,
          reason: "reschedule withdrawn",
          op: "reschedule-withdraw",
        });
      }),
    );
  } catch (err) {
    // A lost CAS is a MODELLED outcome, not a fault: the other party accepted
    // or declined while this withdrawal was in flight. Reporting it as an error
    // would page on ordinary two-party contention, and the route would answer
    // 500 instead of the 409 this actually is.
    if (err instanceof IllegalTransitionError) {
      return { withdrawn: false, reason: "PROPOSAL_NOT_OPEN" };
    }
    reportSentryError(err, {
      subsystem: "bookings",
      op: "reschedule-withdraw",
      extra: {
        rescheduleRequestId,
        releasedOccurrenceIds: request.releasedOccurrenceIds,
      },
    });
    throw err;
  }

  reportPartialRestore(request, restored, "reschedule-withdraw");

  // PR 2e — the initiator withdrew their own proposal; both parties learn
  // the booking stays at its original times. Fire-and-forget.
  try {
    const detail = await prisma.rescheduleRequest.findUnique({
      where: { id: rescheduleRequestId },
      select: {
        initiatedById: true,
        appointment: {
          select: {
            id: true,
            organizationId: true,
            appointmentType: true,
            consultation: {
              select: {
                requestedBy: {
                  select: { user: { select: { id: true, name: true } } },
                },
                consultationPlan: {
                  select: {
                    title: true,
                    consultantProfile: {
                      select: { user: { select: { id: true, name: true } } },
                    },
                  },
                },
              },
            },
            subscription: {
              select: {
                requestedBy: {
                  select: { user: { select: { id: true, name: true } } },
                },
                subscriptionPlan: {
                  select: {
                    title: true,
                    consultantProfile: {
                      select: { user: { select: { id: true, name: true } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const appt = detail?.appointment;
    const side = appt?.consultation ?? appt?.subscription;
    if (detail && side && appt) {
      const isConsultation = "consultationPlan" in side;
      const planTitle = isConsultation
        ? side.consultationPlan.title
        : side.subscriptionPlan.title;
      const consultantUser = isConsultation
        ? side.consultationPlan.consultantProfile.user
        : side.subscriptionPlan.consultantProfile.user;
      const consulteeUser = side.requestedBy.user;
      const withdrawnUserIds = [
        detail.initiatedById,
        consultantUser.id,
        consulteeUser.id,
      ].filter((id, i, arr) => arr.indexOf(id) === i);
      await notifyAppointmentRescheduled(withdrawnUserIds, {
        ...notificationScope(appt.organizationId),
        appointmentType: appt.appointmentType,
        consultantName: consultantUser.name || "Consultant",
        consulteeName: consulteeUser.name || "Consultee",
        planTitle,
        dashboardUrl: notificationHref(appt.organizationId, "appointments"),
        outcome: "WITHDRAWN",
      });
      // #1653 — the email twin; the sender never throws.
      await sendAppointmentRescheduledEmail(
        {
          appointmentId: appt.id,
          userIds: withdrawnUserIds,
          outcome: "WITHDRAWN",
          appointmentType: appt.appointmentType,
          dashboardUrl: notificationHref(appt.organizationId, "appointments"),
        },
        EMAIL_BUDGET_MS.REQUEST,
      );
    }
  } catch (notifyErr) {
    reportSentryError(
      notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr)),
      {
        subsystem: "bookings",
        op: "reschedule-withdraw-notify",
        expected: true,
      },
    );
  }

  return { withdrawn: true };
}

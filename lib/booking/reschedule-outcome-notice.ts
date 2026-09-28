import prisma from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";
import { notifyAppointmentRescheduled } from "@/lib/novu";
import { sendAppointmentRescheduledEmail } from "@/lib/email";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";

/**
 * Tell both parties that a reschedule ended with the booking back on its
 * original time: the initiator withdrew it (PR 2e), or nobody answered and it
 * expired (#1846, #1527 decision 9). One event on the existing
 * `appointment-rescheduled` family and its email twin, both awaited, because a
 * trigger left running after the response is lost when the instance freezes.
 *
 * Never throws: the ending has committed, and a notice failure must not undo
 * it or abort a sweep. `oldDateTime` is the earliest restored session, so the
 * copy can say which time stands.
 */
export async function notifyRescheduleRestored(
  rescheduleRequestId: string,
  outcome: "WITHDRAWN" | "EXPIRED",
  emailBudgetMs: number,
): Promise<void> {
  try {
    const detail = await prisma.rescheduleRequest.findUnique({
      where: { id: rescheduleRequestId },
      select: {
        initiatedById: true,
        releasedOccurrenceIds: true,
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
    if (!detail || !side || !appt) return;

    const isConsultation = "consultationPlan" in side;
    const planTitle = isConsultation
      ? side.consultationPlan.title
      : side.subscriptionPlan.title;
    const consultantUser = isConsultation
      ? side.consultationPlan.consultantProfile.user
      : side.subscriptionPlan.consultantProfile.user;
    const consulteeUser = side.requestedBy.user;
    const userIds = [
      detail.initiatedById,
      consultantUser.id,
      consulteeUser.id,
    ].filter((id, i, arr) => arr.indexOf(id) === i);

    const restored = await prisma.appointmentOccurrence.findFirst({
      where: {
        id: { in: detail.releasedOccurrenceIds },
        completionStatus: "SCHEDULED",
        deletedAt: null,
      },
      orderBy: { startsAt: "asc" },
      select: { startsAt: true },
    });
    const dashboardUrl = notificationHref(appt.organizationId, "appointments");

    await notifyAppointmentRescheduled(userIds, {
      ...notificationScope(appt.organizationId),
      appointmentType: appt.appointmentType,
      consultantName: consultantUser.name || "Consultant",
      consulteeName: consulteeUser.name || "Consultee",
      planTitle,
      dashboardUrl,
      outcome,
      ...(restored ? { oldDateTime: restored.startsAt.toISOString() } : {}),
    });
    // #1653 — the email twin; the sender never throws.
    await sendAppointmentRescheduledEmail(
      {
        appointmentId: appt.id,
        userIds,
        outcome,
        appointmentType: appt.appointmentType,
        oldStartsAt: restored?.startsAt ?? null,
        dashboardUrl,
      },
      emailBudgetMs,
    );
  } catch (notifyErr) {
    reportSentryError(
      notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr)),
      {
        subsystem: "bookings",
        op:
          outcome === "EXPIRED"
            ? "reschedule-expiry-notify"
            : "reschedule-withdraw-notify",
        expected: true,
      },
    );
  }
}

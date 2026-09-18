import { notifyAppointmentCancelled } from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { EMAIL_BUDGET_MS, sendAppointmentCancelledEmail } from "@/lib/email";

/**
 * #1703 D2 — the consultee's notice when a request expires without them:
 * the 24 h pay-link lapsed, or the expert never answered within 48 h. Bell
 * and email ride their outboxes, so a re-run cannot ring twice (the bell's
 * transactionId is derived from this payload; the email dedupes on content).
 */
export interface RequestExpiredNotice {
  appointmentId: string;
  organizationId: string | null;
  consulteeUserId: string;
  consultantName: string;
  consulteeName: string;
  planTitle: string;
  appointmentType: "CONSULTATION" | "SUBSCRIPTION";
  startsAt: Date | null;
  reason: string;
}

export const PAY_LINK_LAPSED_REASON =
  "The payment link expired before it was paid. Ask the expert for the time again if you still want it.";

export const UNANSWERED_REQUEST_REASON =
  "The expert did not respond within 48 hours, so the request expired. No payment was taken.";

/** Never throws: an expiry that already committed must not fail on a notice. */
export async function notifyConsulteeRequestExpired(
  notice: RequestExpiredNotice,
): Promise<void> {
  const dashboardUrl = notificationHref(notice.organizationId, "appointments");
  try {
    await notifyAppointmentCancelled([notice.consulteeUserId], {
      ...notificationScope(notice.organizationId),
      appointmentId: notice.appointmentId,
      appointmentType: notice.appointmentType,
      consultantName: notice.consultantName,
      consulteeName: notice.consulteeName,
      planTitle: notice.planTitle,
      ...(notice.startsAt ? { dateTime: notice.startsAt.toISOString() } : {}),
      dashboardUrl,
      cancelledBy: "system",
      reason: notice.reason,
    });
    await sendAppointmentCancelledEmail(
      {
        appointmentId: notice.appointmentId,
        userIds: [notice.consulteeUserId],
        startsAt: notice.startsAt,
        cancelledBy: "Familiarise",
        reason: notice.reason,
        dashboardUrl,
      },
      EMAIL_BUDGET_MS.JOB,
    );
  } catch (error) {
    console.error(
      `[expiry-notice] failed for appointment ${notice.appointmentId}:`,
      error,
    );
  }
}

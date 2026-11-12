import { notifyAppointmentCancelled } from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu/outbox";
import { EMAIL_BUDGET_MS, sendAppointmentCancelledEmail } from "@/lib/email";
import { stageAppointmentCancelledEmail } from "@/lib/email/senders/booking";
import {
  attemptStaged,
  type StagedRecipientEmail,
} from "@/lib/email/send-to-recipients";
import type { Tx } from "@/lib/prisma";

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

// #1589 N-P0-03 — the paid-but-never-scheduled subscription; the refund rides
// the same sweep through the booking refund front door.
export const UNSCHEDULED_SUBSCRIPTION_REASON =
  "The expert did not schedule any sessions within 30 days, so the subscription expired. Your payment is being refunded.";

/** Never throws: an expiry that already committed must not fail on a notice. */
export async function notifyConsulteeRequestExpired(
  notice: RequestExpiredNotice,
): Promise<void> {
  const dashboardUrl = notificationHref(notice.organizationId, "appointments");
  try {
    await notifyAppointmentCancelled(
      [notice.consulteeUserId],
      bellPayload(notice, dashboardUrl),
    );
    await sendAppointmentCancelledEmail(
      emailArgs(notice, dashboardUrl, [notice.consulteeUserId]),
      EMAIL_BUDGET_MS.JOB,
    );
  } catch (error) {
    console.error(
      `[expiry-notice] failed for appointment ${notice.appointmentId}:`,
      error,
    );
  }
}

export interface StagedRequestExpiredNotice {
  bells: StagedTrigger[];
  emails: StagedRecipientEmail[];
}

/**
 * The same notice written to the bell and email outboxes inside the caller's
 * transaction, so it commits with the state change: once committed, the
 * outbox drain delivers it even if the inline attempt never runs.
 */
export async function stageConsulteeRequestExpired(
  tx: Tx,
  notice: RequestExpiredNotice,
): Promise<StagedRequestExpiredNotice> {
  return stageRequestEndedNotice(tx, notice, {
    recipients: [notice.consulteeUserId],
  });
}

/**
 * A system ending told to every recipient in the caller's transaction; the
 * refund line reaches only `refundUserIds`, so the expert never reads it.
 */
export async function stageRequestEndedNotice(
  tx: Tx,
  notice: Omit<RequestExpiredNotice, "consulteeUserId">,
  opts: { recipients: string[]; refundText?: string; refundUserIds?: string[] },
): Promise<StagedRequestExpiredNotice> {
  if (opts.recipients.length === 0) return { bells: [], emails: [] };
  const dashboardUrl = notificationHref(notice.organizationId, "appointments");
  const bells = await notifyAppointmentCancelled(
    opts.recipients,
    bellPayload(notice, dashboardUrl),
    { tx },
  );
  const emails = await stageAppointmentCancelledEmail(tx, {
    ...emailArgs(notice, dashboardUrl, opts.recipients),
    ...(opts.refundText
      ? { refundText: opts.refundText, refundUserIds: opts.refundUserIds }
      : {}),
  });
  return {
    bells: bells.flatMap((bell) => (bell.staged ? [bell.staged] : [])),
    emails,
  };
}

/** The inline attempt after commit. Never throws: the drain retries a miss. */
export async function attemptStagedRequestExpired(
  staged: StagedRequestExpiredNotice,
  budgetMs: number,
): Promise<void> {
  await Promise.allSettled([
    ...staged.bells.map((bell) => attemptTrigger(bell)),
    attemptStaged(staged.emails, "APPOINTMENT_CANCELLED", budgetMs),
  ]);
}

function bellPayload(
  notice: Omit<RequestExpiredNotice, "consulteeUserId">,
  dashboardUrl: string,
) {
  return {
    ...notificationScope(notice.organizationId),
    appointmentId: notice.appointmentId,
    appointmentType: notice.appointmentType,
    consultantName: notice.consultantName,
    consulteeName: notice.consulteeName,
    planTitle: notice.planTitle,
    ...(notice.startsAt ? { dateTime: notice.startsAt.toISOString() } : {}),
    dashboardUrl,
    cancelledBy: "system" as const,
    reason: notice.reason,
  };
}

function emailArgs(
  notice: Omit<RequestExpiredNotice, "consulteeUserId">,
  dashboardUrl: string,
  userIds: string[],
) {
  return {
    appointmentId: notice.appointmentId,
    userIds,
    startsAt: notice.startsAt,
    cancelledBy: "Familiarise",
    reason: notice.reason,
    dashboardUrl,
  };
}

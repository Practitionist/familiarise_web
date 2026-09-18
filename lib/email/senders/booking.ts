/**
 * #1653 — the booking lifecycle emails: booked, cancelled, rescheduled,
 * reminder, new request and trial. Each sender takes user ids plus the raw
 * domain values the call site already holds (Dates, names, the href its Novu
 * bell computed), resolves recipients through the preference gate, and
 * renders per recipient in that recipient's zone. None of them throws.
 */

import * as Sentry from "@sentry/nextjs";
import * as React from "react";
import type { Tx } from "@/lib/prisma";
import type { PreferenceCategory } from "@/lib/novu/templates/types";
import { formatInViewerZone, zoneLabel } from "@/lib/time/viewer-zone";
import { getAppUrl } from "@/lib/url";
import { formatCurrencyAmount } from "@/utils/formatting";
import AppointmentBookedEmail from "@/emails/booking/AppointmentBookedEmail";
import AppointmentCancelledEmail from "@/emails/booking/AppointmentCancelledEmail";
import AppointmentRescheduledEmail, {
  type RescheduleEmailOutcome,
} from "@/emails/booking/AppointmentRescheduledEmail";
import AppointmentReminderEmail from "@/emails/booking/AppointmentReminderEmail";
import NewBookingRequestEmail from "@/emails/booking/NewBookingRequestEmail";
import TrialScheduledEmail from "@/emails/booking/TrialScheduledEmail";
import { SENDERS } from "../config";
import { loadEmailRecipients, type EmailRecipient } from "../preferences";
import {
  sendToRecipients,
  stageToRecipients,
  type SendToRecipientsResult,
  type StagedRecipientEmail,
} from "../send-to-recipients";

export {
  attemptStaged,
  type SendToRecipientsResult,
  type StagedRecipientEmail,
} from "../send-to-recipients";

const WHEN_PATTERN = "EEE, d MMM yyyy 'at' h:mm a";

/** "Tue, 15 Sep 2026 at 4:30 PM IST" — every time in a booking email. */
export function whenText(date: Date | string, zone: string): string {
  return `${formatInViewerZone(date, zone, WHEN_PATTERN)} ${zoneLabel(date, zone)}`;
}

/** "A refund of ₹1,200 is on its way" — the cancellation's refund line. */
export function refundOnItsWay(amountPaise: number, currency: string): string {
  return `A refund of ${formatCurrencyAmount(amountPaise, currency)} is on its way`;
}

// The bells pass relative hrefs on some paths; a mail client needs absolute.
function absolute(href: string): string {
  return href.startsWith("/") ? `${getAppUrl()}${href}` : href;
}

function greet(r: EmailRecipient): string {
  return r.name?.trim() || "there";
}

// "CONSULTATION" reads as a database value in a sentence.
function humanType(appointmentType: string): string {
  return appointmentType.toLowerCase();
}

type Spec = {
  emailType: string;
  category: PreferenceCategory;
  entityRef: string;
  subject: (r: EmailRecipient) => string;
  render: (r: EmailRecipient) => React.ReactElement;
};

const FAILED: SendToRecipientsResult = { sent: 0, skipped: 0, failed: 1 };

// A sender never throws into a route or a webhook: the mail is best effort
// and the outbox relay finishes what the inline attempt could not.
async function guarded(
  spec: Spec,
  userIds: string[],
  budgetMs: number,
): Promise<SendToRecipientsResult> {
  try {
    const recipients = await loadEmailRecipients(userIds, spec.category);
    return await sendToRecipients({
      recipients,
      emailType: spec.emailType,
      from: SENDERS.notifications,
      subject: spec.subject,
      render: spec.render,
      entityRef: spec.entityRef,
      budgetMs,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "email", emailType: spec.emailType } },
    );
    console.error(`[email] ${spec.emailType} failed:`, error);
    return FAILED;
  }
}

// ── Booked ──────────────────────────────────────────────────────────────────

export interface AppointmentBookedEmailArgs {
  appointmentId: string;
  /** The payer; every other recipient reads the consultant-side copy. */
  consulteeUserId: string;
  consultantUserId?: string | null;
  consulteeName: string;
  consultantName: string;
  planTitle: string;
  appointmentType: string;
  startsAt: Date;
  dashboardUrl: string;
  cancellationWindowText?: string;
}

function bookedSpec(args: AppointmentBookedEmailArgs): Spec {
  const type = humanType(args.appointmentType);
  const role = (r: EmailRecipient) =>
    r.userId === args.consulteeUserId ? "consultee" : "consultant";
  return {
    emailType: "APPOINTMENT_BOOKED",
    category: "appointments",
    entityRef: `appointment:${args.appointmentId}`,
    subject: (r) =>
      role(r) === "consultee"
        ? `Your ${type} with ${args.consultantName} is confirmed`
        : `New booking: ${args.consulteeName} for ${args.planTitle}`,
    render: (r) =>
      React.createElement(AppointmentBookedEmail, {
        role: role(r),
        recipientName: greet(r),
        otherPartyName:
          role(r) === "consultee" ? args.consultantName : args.consulteeName,
        planTitle: args.planTitle,
        appointmentType: type,
        startsAtText: whenText(args.startsAt, r.zone),
        dashboardUrl: absolute(args.dashboardUrl),
        cancellationWindowText: args.cancellationWindowText,
        unsubscribeUrl: r.unsubscribeUrl,
      }),
  };
}

function bookedRecipientIds(args: AppointmentBookedEmailArgs): string[] {
  return [args.consulteeUserId, args.consultantUserId].filter(
    (id): id is string => !!id,
  );
}

export function sendAppointmentBookedEmail(
  args: AppointmentBookedEmailArgs,
  budgetMs: number,
): Promise<SendToRecipientsResult> {
  return guarded(bookedSpec(args), bookedRecipientIds(args), budgetMs);
}

/**
 * The payment webhook's twin: recipients are read and rows staged through
 * `tx`, and the caller runs `attemptStaged()` after commit. A database
 * failure propagates so the booking and its rows roll back together.
 */
export async function stageAppointmentBookedEmail(
  tx: Tx,
  args: AppointmentBookedEmailArgs,
): Promise<StagedRecipientEmail[]> {
  const spec = bookedSpec(args);
  const recipients = await loadEmailRecipients(
    bookedRecipientIds(args),
    spec.category,
    tx,
  );
  return stageToRecipients({
    tx,
    recipients,
    emailType: spec.emailType,
    from: SENDERS.notifications,
    subject: spec.subject,
    render: spec.render,
    entityRef: spec.entityRef,
  });
}

// ── Cancelled ───────────────────────────────────────────────────────────────

export interface AppointmentCancelledEmailArgs {
  appointmentId: string;
  userIds: string[];
  startsAt?: Date | null;
  /** A name or a capitalised role: "The consultant", "Familiarise". */
  cancelledBy: string;
  reason?: string | null;
  /** Shown to `refundUserIds` (every recipient when that list is absent). */
  refundText?: string;
  refundUserIds?: string[];
  dashboardUrl: string;
}

export function sendAppointmentCancelledEmail(
  args: AppointmentCancelledEmailArgs,
  budgetMs: number,
): Promise<SendToRecipientsResult> {
  const showRefund = (r: EmailRecipient) =>
    !!args.refundText &&
    (!args.refundUserIds || args.refundUserIds.includes(r.userId));
  return guarded(
    {
      emailType: "APPOINTMENT_CANCELLED",
      category: "appointments",
      entityRef: `appointment:${args.appointmentId}`,
      subject: (r) =>
        args.startsAt
          ? `Your session on ${whenText(args.startsAt, r.zone)} was cancelled`
          : "Your session was cancelled",
      render: (r) =>
        React.createElement(AppointmentCancelledEmail, {
          recipientName: greet(r),
          startsAtText: args.startsAt
            ? whenText(args.startsAt, r.zone)
            : undefined,
          cancelledBy: args.cancelledBy,
          reason: args.reason ?? undefined,
          refundText: showRefund(r) ? args.refundText : undefined,
          dashboardUrl: absolute(args.dashboardUrl),
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
    args.userIds,
    budgetMs,
  );
}

// ── Rescheduled ─────────────────────────────────────────────────────────────

export interface AppointmentRescheduledEmailArgs {
  appointmentId: string;
  userIds: string[];
  outcome: RescheduleEmailOutcome;
  appointmentType: string;
  oldStartsAt?: Date | null;
  newStartsAt?: Date | null;
  proposedBy?: string;
  /** PROPOSED only: the reschedule request's `expiresAt`. */
  respondBy?: Date | null;
  dashboardUrl: string;
}

export function sendAppointmentRescheduledEmail(
  args: AppointmentRescheduledEmailArgs,
  budgetMs: number,
): Promise<SendToRecipientsResult> {
  const type = humanType(args.appointmentType);
  const subjects: Record<RescheduleEmailOutcome, string> = {
    PROPOSED: `New time proposed for your ${type}`,
    MOVED: `Your ${type} has moved`,
    RELEASED: `Your ${type} time was released`,
    DECLINED: `Proposed time declined for your ${type}`,
    WITHDRAWN: `Reschedule request withdrawn for your ${type}`,
  };
  return guarded(
    {
      emailType: "APPOINTMENT_RESCHEDULED",
      category: "appointments",
      entityRef: `appointment:${args.appointmentId}`,
      subject: () => subjects[args.outcome],
      render: (r) =>
        React.createElement(AppointmentRescheduledEmail, {
          outcome: args.outcome,
          recipientName: greet(r),
          appointmentType: type,
          oldStartsAtText: args.oldStartsAt
            ? whenText(args.oldStartsAt, r.zone)
            : undefined,
          newStartsAtText: args.newStartsAt
            ? whenText(args.newStartsAt, r.zone)
            : undefined,
          proposedBy: args.proposedBy,
          respondByText:
            args.outcome === "PROPOSED" && args.respondBy
              ? whenText(args.respondBy, r.zone)
              : undefined,
          dashboardUrl: absolute(args.dashboardUrl),
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
    args.userIds,
    budgetMs,
  );
}

// ── Reminder ────────────────────────────────────────────────────────────────

export type ReminderWindowLabel = "24h" | "1h";

const WINDOW_WORDS: Record<ReminderWindowLabel, string> = {
  "24h": "tomorrow",
  "1h": "in about an hour",
};

export interface AppointmentReminderEmailArgs {
  appointmentId: string;
  userIds: string[];
  windowLabel: ReminderWindowLabel;
  /** Lets the consultant read the consultee's name as the other party. */
  consultantUserId?: string | null;
  consultantName: string;
  consulteeName: string;
  planTitle: string;
  appointmentType: string;
  startsAt: Date;
  joinUrl?: string;
  dashboardUrl: string;
}

export function sendAppointmentReminderEmail(
  args: AppointmentReminderEmailArgs,
  budgetMs: number,
): Promise<SendToRecipientsResult> {
  const type = humanType(args.appointmentType);
  return guarded(
    {
      emailType: "APPOINTMENT_REMINDER",
      category: "appointments",
      entityRef: `appointment:${args.appointmentId}:${args.windowLabel}`,
      subject: () => `Reminder: your ${type} is coming up`,
      render: (r) =>
        React.createElement(AppointmentReminderEmail, {
          recipientName: greet(r),
          otherPartyName:
            r.userId === args.consultantUserId
              ? args.consulteeName
              : args.consultantName,
          planTitle: args.planTitle,
          appointmentType: type,
          startsAtText: whenText(args.startsAt, r.zone),
          windowLabel: WINDOW_WORDS[args.windowLabel],
          joinUrl: args.joinUrl ? absolute(args.joinUrl) : undefined,
          dashboardUrl: absolute(args.dashboardUrl),
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
    args.userIds,
    budgetMs,
  );
}

// ── New booking request ─────────────────────────────────────────────────────

export interface NewBookingRequestEmailArgs {
  /** The consultation (request) id the route has. */
  requestId: string;
  consultantUserId: string;
  consultantName: string;
  consulteeName: string;
  planTitle: string;
  appointmentType: string;
  requestedAt?: Date | null;
  respondBy?: Date | null;
  reviewUrl: string;
}

export function sendNewBookingRequestEmail(
  args: NewBookingRequestEmailArgs,
  budgetMs: number,
): Promise<SendToRecipientsResult> {
  const type = humanType(args.appointmentType);
  return guarded(
    {
      emailType: "NEW_BOOKING_REQUEST",
      category: "appointments",
      entityRef: `request:${args.requestId}`,
      subject: () => `${args.consulteeName} requested a ${type} with you`,
      render: (r) =>
        React.createElement(NewBookingRequestEmail, {
          consultantName: greet(r),
          consulteeName: args.consulteeName,
          planTitle: args.planTitle,
          appointmentType: type,
          requestedAtText: args.requestedAt
            ? whenText(args.requestedAt, r.zone)
            : undefined,
          respondByText: args.respondBy
            ? whenText(args.respondBy, r.zone)
            : undefined,
          reviewUrl: absolute(args.reviewUrl),
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
    [args.consultantUserId],
    budgetMs,
  );
}

// ── Unscheduled-subscription nudge (#1703) ─────────────────────────────────

export interface UnscheduledSubscriptionNudgeEmailArgs {
  subscriptionId: string;
  consultantUserId: string;
  consulteeName: string;
  planTitle: string;
  nudgeDays: number;
  timingsUrl: string;
}

/** The email twin of `notifyUnscheduledSubscriptionNudge`; one per stage. */
export function sendUnscheduledSubscriptionNudgeEmail(
  args: UnscheduledSubscriptionNudgeEmailArgs,
  budgetMs: number,
): Promise<SendToRecipientsResult> {
  return guarded(
    {
      emailType: "SUBSCRIPTION_UNSCHEDULED_NUDGE",
      category: "appointments",
      entityRef: `subscription:${args.subscriptionId}:day${args.nudgeDays}`,
      subject: () =>
        `${args.consulteeName}'s subscription is waiting for session times`,
      render: (r) =>
        React.createElement(NewBookingRequestEmail, {
          consultantName: greet(r),
          consulteeName: args.consulteeName,
          planTitle: args.planTitle,
          appointmentType: "subscription",
          reviewUrl: absolute(args.timingsUrl),
          unsubscribeUrl: r.unsubscribeUrl,
          nudgeDays: args.nudgeDays,
        }),
    },
    [args.consultantUserId],
    budgetMs,
  );
}

// ── Trial scheduled ─────────────────────────────────────────────────────────

export interface TrialScheduledEmailArgs {
  trialId: string;
  consulteeUserId: string;
  consultantUserId: string;
  consulteeName: string;
  consultantName: string;
  planTitle: string;
  startsAt: Date;
  awaitingPayment: boolean;
  dashboardUrl: string;
  /** The consultee's CTA while the trial awaits payment. */
  paymentUrl?: string | null;
}

export function sendTrialScheduledEmail(
  args: TrialScheduledEmailArgs,
  budgetMs: number,
): Promise<SendToRecipientsResult> {
  const role = (r: EmailRecipient) =>
    r.userId === args.consulteeUserId ? "consultee" : "consultant";
  const state = args.awaitingPayment
    ? "held until payment completes"
    : "confirmed";
  return guarded(
    {
      emailType: "TRIAL_SESSION_SCHEDULED",
      category: "trials",
      entityRef: `trial:${args.trialId}`,
      subject: (r) =>
        role(r) === "consultee"
          ? `Your free trial with ${args.consultantName} is ${state}`
          : `Trial with ${args.consulteeName} is ${state}`,
      render: (r) =>
        React.createElement(TrialScheduledEmail, {
          role: role(r),
          recipientName: greet(r),
          otherPartyName:
            role(r) === "consultee" ? args.consultantName : args.consulteeName,
          planTitle: args.planTitle,
          startsAtText: whenText(args.startsAt, r.zone),
          awaitingPayment: args.awaitingPayment,
          dashboardUrl: absolute(
            role(r) === "consultee" && args.paymentUrl
              ? args.paymentUrl
              : args.dashboardUrl,
          ),
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
    [args.consulteeUserId, args.consultantUserId],
    budgetMs,
  );
}

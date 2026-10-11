/**
 * Booking lifecycle emails: booked, cancelled, rescheduled, reminder,
 * new request, unscheduled nudge, trial scheduled, and window opened.
 */

import * as React from "react";
import { Button, Section, Text } from "react-email";
import type { Tx } from "@/lib/prisma";
import AppointmentBookedEmail from "@/emails/booking/AppointmentBookedEmail";
import AppointmentCancelledEmail from "@/emails/booking/AppointmentCancelledEmail";
import AppointmentRescheduledEmail, {
  type RescheduleEmailOutcome,
} from "@/emails/booking/AppointmentRescheduledEmail";
import AppointmentReminderEmail from "@/emails/booking/AppointmentReminderEmail";
import NewBookingRequestEmail from "@/emails/booking/NewBookingRequestEmail";
import TrialScheduledEmail from "@/emails/booking/TrialScheduledEmail";
import WindowOpenedEmail from "@/emails/booking/WindowOpenedEmail";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";
import type { EmailRecipient } from "../preferences";
import {
  attemptStaged,
  type SendToRecipientsResult,
  type StagedRecipientEmail,
} from "../send-to-recipients";
import {
  absolute,
  defineBudgetedEmailSender,
  greet,
  money,
  stageSpecGuarded,
  whenText,
  type RecipientEmailSpec,
} from "./shared";

export {
  attemptStaged,
  whenText,
  type SendToRecipientsResult,
  type StagedRecipientEmail,
};

export function refundOnItsWay(amountPaise: number, currency: string): string {
  return `A refund of ${money(amountPaise, currency)} is on its way`;
}

function humanType(appointmentType: string): string {
  return appointmentType.toLowerCase();
}

// ── Booked ──────────────────────────────────────────────────────────────────

export interface AppointmentBookedEmailArgs {
  appointmentId: string;
  consulteeUserId: string;
  consultantUserId?: string | null;
  collaboratorUserIds?: string[];
  consulteeName: string;
  consultantName: string;
  planTitle: string;
  appointmentType: string;
  startsAt: Date;
  dashboardUrl: string;
  cancellationWindowText?: string;
}

function bookedSpec(args: AppointmentBookedEmailArgs): RecipientEmailSpec {
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

export async function stageAppointmentBookedEmail(
  tx: Tx,
  args: AppointmentBookedEmailArgs,
): Promise<StagedRecipientEmail[]> {
  const userIds = Array.from(
    new Set(
      [
        args.consulteeUserId,
        args.consultantUserId,
        ...(args.collaboratorUserIds ?? []),
      ].filter((id): id is string => !!id),
    ),
  );
  return stageSpecGuarded(bookedSpec(args), userIds, tx);
}

// ── Cancelled ───────────────────────────────────────────────────────────────

export interface AppointmentCancelledEmailArgs {
  appointmentId: string;
  userIds: string[];
  startsAt?: Date | null;
  cancelledBy: string;
  reason?: string | null;
  refundText?: string;
  refundUserIds?: string[];
  dashboardUrl: string;
}

export const sendAppointmentCancelledEmail =
  defineBudgetedEmailSender<AppointmentCancelledEmailArgs>((args) => {
    const showRefund = (r: EmailRecipient) =>
      !!args.refundText &&
      (!args.refundUserIds || args.refundUserIds.includes(r.userId));
    return {
      userIds: args.userIds,
      spec: {
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
    };
  });

// ── Rescheduled ─────────────────────────────────────────────────────────────

export interface AppointmentRescheduledEmailArgs {
  appointmentId: string;
  userIds: string[];
  outcome: RescheduleEmailOutcome;
  appointmentType: string;
  oldStartsAt?: Date | null;
  newStartsAt?: Date | null;
  proposedBy?: string;
  respondBy?: Date | null;
  dashboardUrl: string;
}

export const sendAppointmentRescheduledEmail =
  defineBudgetedEmailSender<AppointmentRescheduledEmailArgs>((args) => {
    const type = humanType(args.appointmentType);
    const subjects: Record<RescheduleEmailOutcome, string> = {
      PROPOSED: `New time proposed for your ${type}`,
      MOVED: `Your ${type} has moved`,
      RELEASED: `Your ${type} time was released`,
      DECLINED: `Proposed time declined for your ${type}`,
      WITHDRAWN: `Reschedule request withdrawn for your ${type}`,
      EXPIRED: `Your ${type} keeps its original time`,
    };
    return {
      userIds: args.userIds,
      spec: {
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
    };
  });

// ── Reminder ────────────────────────────────────────────────────────────────

export type ReminderWindowLabel = "24h" | "1h";

/**
 * #1583 P1 — the `FailedEmail.emailType` the reminder twin stages under, and
 * the `entityRef` builder beside it. The reminder sweep reads BOTH back to
 * decide which slots still owe a notice, so a literal duplicated at the reader
 * would drift from the writer and silently turn the reader's guard into a
 * no-op. Same shape as SUBSCRIPTION_UNSCHEDULED_NUDGE_EMAIL_TYPE below.
 */
export const APPOINTMENT_REMINDER_EMAIL_TYPE = "APPOINTMENT_REMINDER";

/** The `FailedEmail.entityRef` for one occurrence+window's reminder email. */
export function appointmentReminderEntityRef(
  occurrenceId: string,
  windowLabel: ReminderWindowLabel,
): string {
  return `occurrence:${occurrenceId}:${windowLabel}`;
}

/** Legacy appointment-scoped reminder entityRef retained for single-slot transition checks. */
export function legacyAppointmentReminderEntityRef(
  appointmentId: string,
  windowLabel: ReminderWindowLabel,
): string {
  return `appointment:${appointmentId}:${windowLabel}`;
}

const WINDOW_WORDS: Record<ReminderWindowLabel, string> = {
  "24h": "tomorrow",
  "1h": "in about an hour",
};

export interface AppointmentReminderEmailArgs {
  appointmentId: string;
  occurrenceId?: string;
  userIds: string[];
  collaboratorUserIds?: string[];
  windowLabel: ReminderWindowLabel;
  consultantUserId?: string | null;
  consultantName: string;
  consulteeName: string;
  planTitle: string;
  appointmentType: string;
  startsAt: Date;
  joinUrl?: string;
  dashboardUrl: string;
}

export function reminderSpec(
  args: AppointmentReminderEmailArgs,
): RecipientEmailSpec {
  const type = humanType(args.appointmentType);
  const collabSet = new Set(args.collaboratorUserIds ?? []);
  const isHostOrCollaborator = (r: EmailRecipient) =>
    r.userId === args.consultantUserId || collabSet.has(r.userId);
  const resolvedJoinUrl = args.joinUrl ? absolute(args.joinUrl) : undefined;
  const resolvedDashboardUrl = absolute(args.dashboardUrl);
  const windowText = WINDOW_WORDS[args.windowLabel];
  return {
    emailType: APPOINTMENT_REMINDER_EMAIL_TYPE,
    category: "appointments",
    entityRef: args.occurrenceId
      ? appointmentReminderEntityRef(args.occurrenceId, args.windowLabel)
      : legacyAppointmentReminderEntityRef(
          args.appointmentId,
          args.windowLabel,
        ),
    subject: () => `Reminder: your ${type} is coming up`,
    render: (r) => {
      const startsAtText = whenText(args.startsAt, r.zone);
      if (isHostOrCollaborator(r)) {
        return React.createElement(
          EmailLayout,
          {
            preview: `Upcoming ${type} to host: ${args.planTitle} (${startsAtText})`,
            unsubscribeUrl: r.unsubscribeUrl,
          },
          React.createElement(
            React.Fragment,
            null,
            React.createElement(
              Text,
              { style: heading },
              "You have an upcoming session to host",
            ),
            React.createElement(Text, { style: paragraph }, `Hi ${greet(r)},`),
            React.createElement(
              Text,
              { style: paragraph },
              `Your ${type} session for `,
              React.createElement("strong", null, args.planTitle),
              ` starts ${windowText}, on `,
              React.createElement("strong", null, startsAtText),
              ".",
            ),
            React.createElement(
              Text,
              { style: paragraph },
              resolvedJoinUrl
                ? "The meeting room is open from your dashboard and from the button below."
                : "The join link appears on your dashboard shortly before the session starts.",
            ),
            React.createElement(
              Section,
              { style: buttonContainer },
              React.createElement(
                Button,
                {
                  style: button,
                  href: resolvedJoinUrl ?? resolvedDashboardUrl,
                },
                resolvedJoinUrl ? "Join session" : "View session",
              ),
            ),
          ),
        );
      }
      return React.createElement(AppointmentReminderEmail, {
        recipientName: greet(r),
        otherPartyName: args.consultantName,
        planTitle: args.planTitle,
        appointmentType: type,
        startsAtText,
        windowLabel: windowText,
        joinUrl: resolvedJoinUrl,
        dashboardUrl: resolvedDashboardUrl,
        unsubscribeUrl: r.unsubscribeUrl,
      });
    },
  };
}

export const sendAppointmentReminderEmail =
  defineBudgetedEmailSender<AppointmentReminderEmailArgs>((args) => ({
    userIds: args.userIds,
    spec: reminderSpec(args),
  }));

// ── New booking request ─────────────────────────────────────────────────────

export interface NewBookingRequestEmailArgs {
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

export const sendNewBookingRequestEmail =
  defineBudgetedEmailSender<NewBookingRequestEmailArgs>((args) => {
    const type = humanType(args.appointmentType);
    return {
      userIds: [args.consultantUserId],
      spec: {
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
    };
  });

// ── Unscheduled-subscription nudge ─────────────────────────────────────────

export interface UnscheduledSubscriptionNudgeEmailArgs {
  subscriptionId: string;
  consultantUserId: string;
  consulteeName: string;
  planTitle: string;
  nudgeHours: number;
  timingsUrl: string;
}

export const SUBSCRIPTION_UNSCHEDULED_NUDGE_EMAIL_TYPE =
  "SUBSCRIPTION_UNSCHEDULED_NUDGE";

export function unscheduledNudgeEntityRef(
  subscriptionId: string,
  nudgeHours: number,
): string {
  return `subscription:${subscriptionId}:h${nudgeHours}`;
}

export const sendUnscheduledSubscriptionNudgeEmail =
  defineBudgetedEmailSender<UnscheduledSubscriptionNudgeEmailArgs>((args) => ({
    userIds: [args.consultantUserId],
    spec: {
      emailType: SUBSCRIPTION_UNSCHEDULED_NUDGE_EMAIL_TYPE,
      category: "appointments",
      entityRef: unscheduledNudgeEntityRef(
        args.subscriptionId,
        args.nudgeHours,
      ),
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
          nudgeHours: args.nudgeHours,
        }),
    },
  }));

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
  paymentUrl?: string | null;
}

export const sendTrialScheduledEmail =
  defineBudgetedEmailSender<TrialScheduledEmailArgs>((args) => {
    const role = (r: EmailRecipient) =>
      r.userId === args.consulteeUserId ? "consultee" : "consultant";
    const state = args.awaitingPayment
      ? "held until payment completes"
      : "confirmed";
    return {
      userIds: [args.consulteeUserId, args.consultantUserId],
      spec: {
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
              role(r) === "consultee"
                ? args.consultantName
                : args.consulteeName,
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
    };
  });

// ── Window opened ───────────────────────────────────────────────────────────

export const WINDOW_OPENED_EMAIL_TYPE = "WINDOW_OPENED";

export async function stageWindowOpenedEmail(
  tx: Tx,
  args: {
    interestId: string;
    userId: string;
    consultantName: string;
    windowStart: Date;
    bookUrl: string;
  },
): Promise<StagedRecipientEmail[]> {
  return stageSpecGuarded(
    {
      emailType: WINDOW_OPENED_EMAIL_TYPE,
      category: "appointments",
      entityRef: `window-opened:${args.interestId}`,
      subject: () => `A time with ${args.consultantName} just opened`,
      render: (r) =>
        React.createElement(WindowOpenedEmail, {
          recipientName: greet(r),
          consultantName: args.consultantName,
          windowText: whenText(args.windowStart, r.zone),
          bookUrl: absolute(args.bookUrl),
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
    [args.userId],
    tx,
  );
}

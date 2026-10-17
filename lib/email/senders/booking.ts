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
import ClassSessionEmail, {
  classSessionSubject,
  type ClassSessionEmailKind,
} from "@/emails/booking/ClassSessionEmail";
import DocumentAndRecordingEmail, {
  documentAndRecordingSubject,
  type DocumentAndRecordingEmailKind,
} from "@/emails/booking/DocumentAndRecordingEmail";
import NewBookingRequestEmail from "@/emails/booking/NewBookingRequestEmail";
import TrialAndSubscriptionEmail, {
  trialAndSubscriptionSubject,
  type TrialAndSubscriptionEmailKind,
} from "@/emails/booking/TrialAndSubscriptionEmail";
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
  defineLifecycleStager,
  greet,
  money,
  prepareSpecEmails,
  stageSpecGuarded,
  whenText,
  type PreparedRecipientEmails,
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

function buildCancelledEmail(args: AppointmentCancelledEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
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
}

export const sendAppointmentCancelledEmail =
  defineBudgetedEmailSender<AppointmentCancelledEmailArgs>(buildCancelledEmail);

export const stageAppointmentCancelledEmail =
  defineLifecycleStager<AppointmentCancelledEmailArgs>(buildCancelledEmail);

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

function buildRescheduledEmail(args: AppointmentRescheduledEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
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
}

export const sendAppointmentRescheduledEmail =
  defineBudgetedEmailSender<AppointmentRescheduledEmailArgs>(
    buildRescheduledEmail,
  );

export const stageAppointmentRescheduledEmail =
  defineLifecycleStager<AppointmentRescheduledEmailArgs>(buildRescheduledEmail);

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

function buildNewBookingRequestEmail(args: NewBookingRequestEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
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
}

export const sendNewBookingRequestEmail =
  defineBudgetedEmailSender<NewBookingRequestEmailArgs>(
    buildNewBookingRequestEmail,
  );

export const stageNewBookingRequestEmail =
  defineLifecycleStager<NewBookingRequestEmailArgs>(
    buildNewBookingRequestEmail,
  );

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

function buildTrialScheduledEmail(args: TrialScheduledEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
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
  };
}

export const stageTrialScheduledEmail =
  defineLifecycleStager<TrialScheduledEmailArgs>(buildTrialScheduledEmail);

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

// ── Class session & outcome notices ─────────────────────────────────────────

export type EmailTimestampInput = Date | string | null;

export interface ClassSessionLifecycleEmailArgs {
  appointmentId: string;
  userIds: string[];
  kind: ClassSessionEmailKind;
  planTitle: string;
  consultantName?: string;
  appointmentType?: string;
  startsAt?: EmailTimestampInput;
  makeUpBy?: EmailTimestampInput;
  amountPaise?: number;
  currency?: string;
  missedCount?: number;
  voided?: boolean;
  recordingUrl?: string | null;
  supportUrl?: string | null;
  dashboardUrl: string;
}

function buildClassSessionEmail(args: ClassSessionLifecycleEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  const amountText =
    typeof args.amountPaise === "number"
      ? money(args.amountPaise, args.currency ?? "INR")
      : undefined;
  return {
    userIds: args.userIds,
    spec: {
      emailType: `CLASS_SESSION_${args.kind}`,
      category: "appointments",
      entityRef: `appointment:${args.appointmentId}`,
      subject: () =>
        classSessionSubject({
          kind: args.kind,
          planTitle: args.planTitle,
          voided: args.voided,
          appointmentType: args.appointmentType,
        }),
      render: (r) =>
        React.createElement(ClassSessionEmail, {
          kind: args.kind,
          recipientName: greet(r),
          planTitle: args.planTitle,
          consultantName: args.consultantName,
          appointmentType: args.appointmentType,
          startsAtText: args.startsAt
            ? whenText(args.startsAt, r.zone)
            : undefined,
          makeUpByText: args.makeUpBy
            ? whenText(args.makeUpBy, r.zone)
            : undefined,
          amountText,
          missedCount: args.missedCount,
          voided: args.voided,
          recordingUrl: args.recordingUrl
            ? absolute(args.recordingUrl)
            : undefined,
          supportUrl: args.supportUrl ? absolute(args.supportUrl) : undefined,
          dashboardUrl: absolute(args.dashboardUrl),
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
  };
}

export interface ClassExitAvailableEmailArgs {
  appointmentId: string;
  userIds: string[];
  planTitle: string;
  missedCount?: number;
  dashboardUrl: string;
}

function buildClassExitAvailableEmail(args: ClassExitAvailableEmailArgs) {
  return buildClassSessionEmail({
    ...args,
    kind: "EXIT_AVAILABLE",
  });
}

export const stageClassExitAvailableEmails =
  defineLifecycleStager<ClassExitAvailableEmailArgs>(
    buildClassExitAvailableEmail,
  );

export interface SessionOutcomeEmailArgs {
  appointmentId: string;
  userIds: string[];
  outcome: "NO_SHOW" | "MISSED_RECORDING";
  planTitle: string;
  startsAt?: EmailTimestampInput;
  recordingUrl?: string | null;
  supportUrl?: string | null;
  dashboardUrl: string;
}

function buildSessionOutcomeEmail(args: SessionOutcomeEmailArgs) {
  return buildClassSessionEmail({
    appointmentId: args.appointmentId,
    userIds: args.userIds,
    kind: args.outcome,
    planTitle: args.planTitle,
    startsAt: args.startsAt,
    recordingUrl: args.recordingUrl ? absolute(args.recordingUrl) : undefined,
    supportUrl: args.supportUrl ? absolute(args.supportUrl) : undefined,
    dashboardUrl: absolute(args.dashboardUrl),
  });
}

export function prepareSessionOutcomeEmails(
  args: SessionOutcomeEmailArgs,
): Promise<PreparedRecipientEmails> {
  const { userIds, spec } = buildSessionOutcomeEmail({
    ...args,
    recordingUrl: args.recordingUrl ? absolute(args.recordingUrl) : undefined,
    supportUrl: args.supportUrl ? absolute(args.supportUrl) : undefined,
    dashboardUrl: absolute(args.dashboardUrl),
  });
  return prepareSpecEmails(spec, userIds);
}

export const stageSessionOutcomeEmails =
  defineLifecycleStager<SessionOutcomeEmailArgs>(buildSessionOutcomeEmail);

export interface AppointmentCompletedEmailArgs {
  appointmentId: string;
  userIds: string[];
  planTitle: string;
  appointmentType?: string;
  dashboardUrl: string;
}

function buildAppointmentCompletedEmail(args: AppointmentCompletedEmailArgs) {
  return buildClassSessionEmail({
    appointmentId: args.appointmentId,
    userIds: args.userIds,
    kind: "COMPLETED",
    planTitle: args.planTitle,
    appointmentType: args.appointmentType,
    dashboardUrl: absolute(args.dashboardUrl),
  });
}

export const stageAppointmentCompletedEmails =
  defineLifecycleStager<AppointmentCompletedEmailArgs>(
    buildAppointmentCompletedEmail,
  );

// ── Trial & Subscription lifecycle ──────────────────────────────────────────

export interface TrialLifecycleEmailArgs {
  trialId: string;
  userIds: string[];
  kind: Extract<
    TrialAndSubscriptionEmailKind,
    "TRIAL_REQUESTED" | "TRIAL_COMPLETED" | "TRIAL_CANCELLED" | "TRIAL_REJECTED"
  >;
  planTitle: string;
  consultantUserId?: string;
  consulteeUserId?: string;
  consultantName?: string;
  consulteeName?: string;
  startsAt?: EmailTimestampInput;
  dashboardUrl: string;
}

function buildTrialLifecycleEmail(args: TrialLifecycleEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  return {
    userIds: args.userIds,
    spec: {
      emailType: args.kind,
      category: "trials",
      entityRef: `trial:${args.trialId}`,
      subject: () =>
        trialAndSubscriptionSubject({
          kind: args.kind,
          planTitle: args.planTitle,
          consulteeName: args.consulteeName,
          consultantName: args.consultantName,
        }),
      render: (r) => {
        const isConsultant =
          (args.consultantUserId && r.userId === args.consultantUserId) ||
          (!args.consultantUserId &&
            Boolean(
              args.consultantName && r.name?.trim() === args.consultantName,
            ));
        return React.createElement(TrialAndSubscriptionEmail, {
          kind: args.kind,
          recipientName: greet(r),
          recipientRole: isConsultant ? "consultant" : "consultee",
          planTitle: args.planTitle,
          consultantName: args.consultantName,
          consulteeName: args.consulteeName,
          startsAtText: args.startsAt
            ? whenText(args.startsAt, r.zone)
            : undefined,
          dashboardUrl: absolute(args.dashboardUrl),
          unsubscribeUrl: r.unsubscribeUrl,
        });
      },
    },
  };
}

export const stageTrialLifecycleEmail =
  defineLifecycleStager<TrialLifecycleEmailArgs>(buildTrialLifecycleEmail);

export interface SubscriptionLifecycleEmailArgs {
  subscriptionId: string;
  userIds: string[];
  kind: Extract<
    TrialAndSubscriptionEmailKind,
    "SUBSCRIPTION_STARTED" | "SUBSCRIPTION_RENEWED"
  >;
  planTitle: string;
  consultantName?: string;
  cycleOrdinal?: number;
  nextBatch?: number;
  remainingSessions?: number;
  dashboardUrl: string;
}

function buildSubscriptionLifecycleEmail(
  args: SubscriptionLifecycleEmailArgs,
): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  return {
    userIds: args.userIds,
    spec: {
      emailType: args.kind,
      category: "subscriptions",
      entityRef: `subscription:${args.subscriptionId}`,
      subject: () =>
        trialAndSubscriptionSubject({
          kind: args.kind,
          planTitle: args.planTitle,
          consultantName: args.consultantName,
        }),
      render: (r) =>
        React.createElement(TrialAndSubscriptionEmail, {
          kind: args.kind,
          recipientName: greet(r),
          planTitle: args.planTitle,
          consultantName: args.consultantName,
          cycleOrdinal: args.cycleOrdinal,
          nextBatch: args.nextBatch,
          remainingSessions: args.remainingSessions,
          dashboardUrl: absolute(args.dashboardUrl),
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
  };
}

export const stageSubscriptionLifecycleEmail =
  defineLifecycleStager<SubscriptionLifecycleEmailArgs>(
    buildSubscriptionLifecycleEmail,
  );

// ── Shared documents & session recordings ───────────────────────────────────

export interface DocumentAndRecordingEmailArgs {
  entityId: string;
  userIds: string[];
  kind: DocumentAndRecordingEmailKind;
  actorName?: string;
  fileName?: string;
  versionNo?: number;
  reviewStatus?: string;
  reviewNotes?: string | null;
  appointmentType?: string;
  actionUrl?: string;
  dashboardUrl: string;
}

function buildDocumentAndRecordingEmail(args: DocumentAndRecordingEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  const resolvedActionUrl = absolute(args.actionUrl ?? args.dashboardUrl);
  return {
    userIds: args.userIds,
    spec: {
      emailType: args.kind,
      category: "appointments",
      entityRef: `session-media:${args.entityId}`,
      subject: () =>
        documentAndRecordingSubject({
          kind: args.kind,
          fileName: args.fileName,
          appointmentType: args.appointmentType,
        }),
      render: (r) =>
        React.createElement(DocumentAndRecordingEmail, {
          kind: args.kind,
          recipientName: greet(r),
          actorName: args.actorName,
          fileName: args.fileName,
          versionNo: args.versionNo,
          reviewStatus: args.reviewStatus,
          reviewNotes: args.reviewNotes,
          appointmentType: args.appointmentType,
          dashboardUrl: resolvedActionUrl,
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
  };
}

export const stageDocumentAndRecordingEmail =
  defineLifecycleStager<DocumentAndRecordingEmailArgs>(
    buildDocumentAndRecordingEmail,
  );

/**
 * Booking lifecycle emails: booked, cancelled, rescheduled, reminder,
 * new request, unscheduled nudge, trial scheduled, window opened and event
 * seat opened.
 */

import { refundNoticeText } from "@/lib/notifications/refund-wording";
import UnplacedWeeksEmail from "@/emails/booking/UnplacedWeeksEmail";
import * as React from "react";
import { Button, Section, Text } from "react-email";
import type { Tx } from "@/lib/prisma";
import {
  calendarLinks,
  type CalendarSession,
} from "@/lib/appointments/calendar-links";
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
import EventSeatOpenedEmail from "@/emails/booking/EventSeatOpenedEmail";
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
import SessionOutcomeNoticeEmail from "@/emails/booking/SessionOutcomeNoticeEmail";
import type { NoticeCopy } from "@/lib/booking/outcome-notice-copy";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";
import { shownMoves, type SessionMove } from "@/lib/booking/session-moves";
import type { EmailRecipient } from "../preferences";
import {
  attemptStaged,
  screenPreparedEmails,
  type ScreenedRecipientEmails,
  type SendToRecipientsResult,
  type StagedRecipientEmail,
} from "../send-to-recipients";
import {
  absolute,
  defineBudgetedEmailSender,
  defineLifecyclePreparer,
  defineLifecycleStager,
  greet,
  money,
  prepareBuiltSpec,
  prepareSpecEmails,
  stageBuiltSpec,
  stageSpecGuarded,
  stageSpecOncePerRecipient,
  stageSpecOncePerRecipientQuietly,
  whenText,
  type PreparedRecipientEmails,
  type PreparedSpecEmails,
  type RecipientClaim,
  type RecipientEmailSpec,
} from "./shared";

export {
  attemptStaged,
  whenText,
  type SendToRecipientsResult,
  type StagedRecipientEmail,
};

/** A send required for anyone traces its render failure instead of losing it. */
const isRequired = (requiredFor: readonly string[] | undefined) =>
  (requiredFor?.length ?? 0) > 0;

export function refundOnItsWay(amountPaise: number, currency: string): string {
  return refundNoticeText(amountPaise, currency, false);
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
  /** The next session ahead, which the attendee's calendar links name; none means no links. */
  calendarSession?: CalendarSession | null;
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
        calendar:
          role(r) === "consultee" && args.calendarSession
            ? calendarLinks({
                appointmentId: args.appointmentId,
                userId: r.userId,
                title: args.planTitle,
                ...args.calendarSession,
              })
            : null,
        unsubscribeUrl: r.unsubscribeUrl,
      }),
  };
}

function buildBookedEmail(args: AppointmentBookedEmailArgs) {
  const userIds = Array.from(
    new Set(
      [
        args.consulteeUserId,
        args.consultantUserId,
        ...(args.collaboratorUserIds ?? []),
      ].filter((id): id is string => !!id),
    ),
  );
  return { userIds, spec: bookedSpec(args) };
}

/** Renders the booked notices before the confirming transaction opens. */
export function prepareAppointmentBookedEmail(
  args: AppointmentBookedEmailArgs,
): Promise<PreparedSpecEmails> {
  return prepareBuiltSpec(buildBookedEmail, args);
}

export function stageAppointmentBookedEmail(
  tx: Tx,
  args: AppointmentBookedEmailArgs,
  pre?: PreparedSpecEmails | null,
): Promise<StagedRecipientEmail[]> {
  return stageBuiltSpec(tx, buildBookedEmail, args, pre);
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
  /** Recipients the other party's change makes this a required notice for. */
  requiredFor?: readonly string[];
  /** A host removed this one seat from a class or webinar; nothing was cancelled. */
  removedFrom?: { eventLabel: string; planTitle: string };
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
      requiredFor: args.requiredFor,
      traceRenderFailure: isRequired(args.requiredFor),
      entityRef: `appointment:${args.appointmentId}`,
      subject: (r) =>
        args.removedFrom
          ? `You were removed from ${args.removedFrom.planTitle}`
          : args.startsAt
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
          removedFrom: args.removedFrom,
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
  /** MOVED by a host: the free full-refund leave ends then. */
  leaveBy?: Date | null;
  /** MOVED: these recipients already hold another session at the new time. */
  clash?: boolean;
  /** A series move: every moved session, old time and new. */
  moves?: readonly SessionMove[];
  /** Recipients the other party's change makes this a required notice for. */
  requiredFor?: readonly string[];
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
      requiredFor: args.requiredFor,
      traceRenderFailure: isRequired(args.requiredFor),
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
          leaveByText:
            args.outcome === "MOVED" && args.leaveBy
              ? whenText(args.leaveBy, r.zone)
              : undefined,
          clash: args.outcome === "MOVED" && args.clash === true,
          ...movesProps(args, r.zone),
          dashboardUrl: absolute(args.dashboardUrl),
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
  };
}

function movesProps(args: AppointmentRescheduledEmailArgs, zone: string) {
  if (args.outcome !== "MOVED" || !args.moves || args.moves.length < 2) {
    return {};
  }
  const { shown, more } = shownMoves(args.moves);
  return {
    moves: shown.map((m) => ({
      fromText: whenText(m.from, zone),
      toText: whenText(m.to, zone),
    })),
    moreMoves: more,
  };
}

export const sendAppointmentRescheduledEmail =
  defineBudgetedEmailSender<AppointmentRescheduledEmailArgs>(
    buildRescheduledEmail,
  );

export const stageAppointmentRescheduledEmail =
  defineLifecycleStager<AppointmentRescheduledEmailArgs>(buildRescheduledEmail);

// ── Reminder ────────────────────────────────────────────────────────────────

export type ReminderWindowLabel = "24h" | "1h" | "15m";

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
  "15m": "in a few minutes",
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
  /** When the buyer is refunded in full if cycle 1 is still unplaced. */
  refundAt: Date;
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

function unscheduledNudgeSpec(
  args: UnscheduledSubscriptionNudgeEmailArgs,
): RecipientEmailSpec {
  return {
    emailType: SUBSCRIPTION_UNSCHEDULED_NUDGE_EMAIL_TYPE,
    category: "appointments",
    entityRef: unscheduledNudgeEntityRef(args.subscriptionId, args.nudgeHours),
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
        refundAtText: whenText(args.refundAt, r.zone),
      }),
  };
}

/** A sweep's deadline email claim lasts past the deadline it announces. */
const DEADLINE_EMAIL_CLAIM_MS = 7 * 24 * 60 * 60 * 1000;

/** Stages the nudge once per stage; the claim commits with the row. */
export function stageUnscheduledSubscriptionNudgeEmail(
  args: UnscheduledSubscriptionNudgeEmailArgs,
) {
  const entityRef = unscheduledNudgeEntityRef(
    args.subscriptionId,
    args.nudgeHours,
  );
  return stageSpecOncePerRecipientQuietly(
    unscheduledNudgeSpec(args),
    [args.consultantUserId],
    {
      scope: SUBSCRIPTION_UNSCHEDULED_NUDGE_EMAIL_TYPE,
      key: (userId) => `${entityRef}:${userId}`,
      ttlMs: DEADLINE_EMAIL_CLAIM_MS,
    },
  );
}

// ── Request about to lapse ──────────────────────────────────────────────────

export interface RequestExpiringEmailArgs {
  consultationId: string;
  consultantUserId: string;
  consulteeName: string;
  planTitle: string;
  expiresAt: Date;
  reviewUrl: string;
}

export const REQUEST_EXPIRING_EMAIL_TYPE = "REQUEST_EXPIRING_SOON";

/** One alert per request: the guard and the sender share this entityRef. */
export function requestExpiringEntityRef(consultationId: string): string {
  return `request:${consultationId}:expiring`;
}

function requestExpiringSpec(
  args: RequestExpiringEmailArgs,
): RecipientEmailSpec {
  return {
    emailType: REQUEST_EXPIRING_EMAIL_TYPE,
    category: "appointments",
    entityRef: requestExpiringEntityRef(args.consultationId),
    subject: (r) =>
      `${args.consulteeName}'s request lapses at ${whenText(args.expiresAt, r.zone)}`,
    render: (r) =>
      React.createElement(NewBookingRequestEmail, {
        consultantName: greet(r),
        consulteeName: args.consulteeName,
        planTitle: args.planTitle,
        appointmentType: "consultation",
        reviewUrl: absolute(args.reviewUrl),
        unsubscribeUrl: r.unsubscribeUrl,
        expiresAtText: whenText(args.expiresAt, r.zone),
      }),
  };
}

/** Stages the alert once per request; the claim commits with the row. */
export function stageRequestExpiringEmail(args: RequestExpiringEmailArgs) {
  const entityRef = requestExpiringEntityRef(args.consultationId);
  return stageSpecOncePerRecipientQuietly(
    requestExpiringSpec(args),
    [args.consultantUserId],
    {
      scope: REQUEST_EXPIRING_EMAIL_TYPE,
      key: (userId) => `${entityRef}:${userId}`,
      ttlMs: DEADLINE_EMAIL_CLAIM_MS,
    },
  );
}

export interface UnplacedWeekNudgeEmailArgs {
  consultantProfileId: string;
  consultantUserId: string;
  /** The consultant's local day: one reminder per consultant per day. */
  localDay: string;
  weeks: {
    consulteeName: string;
    planTitle: string;
    number: number;
    count: number;
    sessions: number;
    range: string;
    url: string;
  }[];
}

export const SUBSCRIPTION_WEEK_NUDGE_EMAIL_TYPE = "SUBSCRIPTION_WEEK_NUDGE";

export function unplacedWeekNudgeEntityRef(
  consultantProfileId: string,
  localDay: string,
): string {
  return `consultant:${consultantProfileId}:weeks:${localDay}`;
}

export const sendUnplacedWeekNudgeEmail =
  defineBudgetedEmailSender<UnplacedWeekNudgeEmailArgs>((args) => ({
    userIds: [args.consultantUserId],
    spec: {
      emailType: SUBSCRIPTION_WEEK_NUDGE_EMAIL_TYPE,
      category: "appointments",
      entityRef: unplacedWeekNudgeEntityRef(
        args.consultantProfileId,
        args.localDay,
      ),
      subject: () =>
        args.weeks.length === 1
          ? `${args.weeks[0].consulteeName}'s week ${args.weeks[0].number} needs session times`
          : `${args.weeks.length} plans need session times this week`,
      render: (r) =>
        React.createElement(UnplacedWeeksEmail, {
          consultantName: greet(r),
          weeks: args.weeks.map((w) => ({ ...w, url: absolute(w.url) })),
          unsubscribeUrl: r.unsubscribeUrl,
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

/** Renders the scheduled notice outside any transaction; `screenPreparedEmails` reads its verdicts before staging. */
export function prepareTrialScheduledEmail(
  args: TrialScheduledEmailArgs,
): Promise<PreparedRecipientEmails> {
  const { userIds, spec } = buildTrialScheduledEmail(args);
  return prepareSpecEmails(spec, userIds);
}

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

// ── Event seat opened ───────────────────────────────────────────────────────

export const EVENT_SEAT_OPENED_EMAIL_TYPE = "EVENT_SEAT_OPENED";

export interface EventSeatOpenedEmailArgs {
  appointmentId: string;
  /** The cooldown window this notice belongs to; part of the per-recipient claim key. */
  bucket: number;
  userIds: string[];
  planTitle: string;
  kind: "WEBINAR" | "CLASS";
  startsAt: Date | null;
  checkoutUrl: string;
}

/** Renders outside any transaction and stages once per recipient under `claim`; never call it inside `tx`. */
export function stageEventSeatOpenedEmails(
  args: EventSeatOpenedEmailArgs,
  claim: RecipientClaim,
): Promise<StagedRecipientEmail[]> {
  const startsAt = args.startsAt;
  return stageSpecOncePerRecipient(
    {
      emailType: EVENT_SEAT_OPENED_EMAIL_TYPE,
      category: "appointments",
      entityRef: `appointment:${args.appointmentId}`,
      subject: () => `A seat just opened in ${args.planTitle}`,
      render: (r) =>
        React.createElement(EventSeatOpenedEmail, {
          recipientName: greet(r),
          planTitle: args.planTitle,
          eventLabel: args.kind === "CLASS" ? "class" : "webinar",
          startsText: startsAt ? whenText(startsAt, r.zone) : null,
          checkoutUrl: absolute(args.checkoutUrl),
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
    args.userIds,
    claim,
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
  outcome: "MISSED_RECORDING";
  planTitle: string;
  startsAt?: EmailTimestampInput;
  recordingUrl?: string | null;
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
    dashboardUrl: absolute(args.dashboardUrl),
  });
}

export function prepareSessionOutcomeEmails(
  args: SessionOutcomeEmailArgs,
): Promise<PreparedRecipientEmails> {
  const { userIds, spec } = buildSessionOutcomeEmail({
    ...args,
    recordingUrl: args.recordingUrl ? absolute(args.recordingUrl) : undefined,
    dashboardUrl: absolute(args.dashboardUrl),
  });
  return prepareSpecEmails(spec, userIds);
}

export const stageSessionOutcomeEmails =
  defineLifecycleStager<SessionOutcomeEmailArgs>(buildSessionOutcomeEmail);

export interface SessionOutcomeNoticeEmailArgs {
  emailType: "SESSION_OUTCOME_PROPOSED" | "SESSION_OUTCOME_REVIEWED";
  appointmentId: string;
  userIds: string[];
  /** One recipient's words and link, built in their own zone. */
  noticeFor: (userId: string, zone: string) => { copy: NoticeCopy; href: string };
}

/** Renders and screens a session-outcome notice before the verdict's transaction stages it. */
export async function prepareSessionOutcomeNoticeEmails(
  args: SessionOutcomeNoticeEmailArgs,
): Promise<ScreenedRecipientEmails> {
  const spec: RecipientEmailSpec = {
    emailType: args.emailType,
    category: "appointments",
    entityRef: `appointment:${args.appointmentId}`,
    subject: (r) => args.noticeFor(r.userId, r.zone).copy.subject,
    render: (r) => {
      const { copy, href } = args.noticeFor(r.userId, r.zone);
      return React.createElement(SessionOutcomeNoticeEmail, {
        recipientName: greet(r),
        subject: copy.subject,
        lines: copy.lines,
        actionLabel: copy.actionLabel,
        actionHref: absolute(href),
        unsubscribeUrl: r.unsubscribeUrl,
      });
    },
  };
  return screenPreparedEmails(await prepareSpecEmails(spec, args.userIds));
}

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
    "TRIAL_COMPLETED" | "TRIAL_CANCELLED"
  >;
  planTitle: string;
  consultantUserId?: string;
  consulteeUserId?: string;
  consultantName?: string;
  consulteeName?: string;
  startsAt?: EmailTimestampInput;
  /** Recipients a change someone else made makes this a required notice for. */
  requiredFor?: readonly string[];
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
      requiredFor: args.requiredFor,
      traceRenderFailure: isRequired(args.requiredFor),
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

/** Renders a trial lifecycle email before the transaction that stages it. */
export const prepareTrialLifecycleEmail =
  defineLifecyclePreparer<TrialLifecycleEmailArgs>(buildTrialLifecycleEmail);

export interface SubscriptionLifecycleEmailArgs {
  subscriptionId: string;
  userIds: string[];
  kind: Extract<
    TrialAndSubscriptionEmailKind,
    "SUBSCRIPTION_STARTED" | "SUBSCRIPTION_RENEWED"
  >;
  planTitle: string;
  consultantName?: string;
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

/** Stages the notice at most once per recipient under `claim`. */
export function stageDocumentAndRecordingEmailOnce(
  args: DocumentAndRecordingEmailArgs,
  claim: RecipientClaim,
): Promise<StagedRecipientEmail[]> {
  const { userIds, spec } = buildDocumentAndRecordingEmail(args);
  return stageSpecOncePerRecipient(spec, userIds, claim);
}

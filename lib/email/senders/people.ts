/**
 * People and access emails: support replies and status changes,
 * suspension and ban notices, and new reviews.
 */

import * as React from "react";
import { Button, Section, Text } from "react-email";
import type { SupportTicketStatus } from "@prisma/client";
import { EmailLayout } from "@/emails/components/EmailLayout";
import {
  button,
  buttonContainer,
  heading,
  paragraph,
} from "@/emails/components/styles";
import AccountBannedEmail, {
  ACCOUNT_BANNED_SUBJECT,
} from "@/emails/account/AccountBannedEmail";
import AccountSuspendedEmail, {
  ACCOUNT_SUSPENDED_SUBJECT,
} from "@/emails/account/AccountSuspendedEmail";
import AccountRestrictedEmail, {
  accountRestrictedSubject,
  type AccountRestrictedEmailKind,
} from "@/emails/auth/AccountRestrictedEmail";
import NewReviewEmail, {
  newReviewSubject,
} from "@/emails/reviews/NewReviewEmail";
import SupportTicketResponseEmail, {
  supportTicketResponseSubject,
} from "@/emails/support/SupportTicketResponseEmail";
import SupportTicketUpdateEmail, {
  supportTicketUpdateSubject,
} from "@/emails/support/SupportTicketUpdateEmail";
import { SENDERS, supportEmail } from "../config";
import {
  absolute,
  defineBudgetedEmailSender,
  defineLifecycleStager,
  greet,
  whenText,
  type RecipientEmailSpec,
} from "./shared";

const EXCERPT_LENGTH = 140;

function excerptOf(text: string | null | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > EXCERPT_LENGTH
    ? `${trimmed.slice(0, EXCERPT_LENGTH)}…`
    : trimmed;
}

// ── Support ─────────────────────────────────────────────────────────────────

export interface SupportTicketReceivedEmailArgs {
  ticketId: string;
  ownerUserId: string;
  reference: string;
  title: string;
  slaWindow: string | null;
  ticketUrl: string;
}

function buildSupportTicketReceivedEmail(
  args: SupportTicketReceivedEmailArgs,
): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  const subject = `Support request received (${args.reference})`;
  return {
    userIds: [args.ownerUserId],
    spec: {
      emailType: "SUPPORT_TICKET_RECEIVED",
      category: null,
      from: SENDERS.notifications,
      entityRef: `ticket:${args.ticketId}`,
      subject: () => subject,
      render: (r) =>
        React.createElement(EmailLayout, {
          preview: subject,
          children: [
            React.createElement(Text, { style: heading, key: "h" }, subject),
            React.createElement(
              Text,
              { style: paragraph, key: "greet" },
              `Hi ${greet(r)},`,
            ),
            React.createElement(
              Text,
              { style: paragraph, key: "body" },
              `We received your support request `,
              React.createElement("strong", null, args.reference),
              args.slaWindow
                ? ` (${args.title}). Our team expects to respond within ${args.slaWindow}.`
                : ` (${args.title}).`,
            ),
            React.createElement(
              Section,
              { style: buttonContainer, key: "cta" },
              React.createElement(
                Button,
                { style: button, href: absolute(args.ticketUrl) },
                "View request",
              ),
            ),
          ],
        }),
    },
  };
}

export const sendSupportTicketReceivedEmail =
  defineBudgetedEmailSender<SupportTicketReceivedEmailArgs>(
    buildSupportTicketReceivedEmail,
  );

export interface SupportTicketResponseEmailArgs {
  ticketId: string;
  ownerUserId: string;
  reference?: string;
  title: string;
  respondedBy: string;
  replyText: string;
  ticketUrl: string;
}

function buildSupportTicketResponseEmail(
  args: SupportTicketResponseEmailArgs,
): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  return {
    userIds: [args.ownerUserId],
    spec: {
      emailType: "SUPPORT_TICKET_RESPONSE",
      category: "support",
      from: SENDERS.notifications,
      entityRef: `ticket:${args.ticketId}`,
      subject: () => supportTicketResponseSubject(args),
      render: (r) =>
        React.createElement(SupportTicketResponseEmail, {
          recipientName: greet(r),
          reference: args.reference,
          title: args.title,
          respondedBy: args.respondedBy,
          replyText: args.replyText,
          ticketUrl: absolute(args.ticketUrl),
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
  };
}

export const sendSupportTicketResponseEmail =
  defineBudgetedEmailSender<SupportTicketResponseEmailArgs>(
    buildSupportTicketResponseEmail,
  );

export const stageSupportTicketResponseEmail =
  defineLifecycleStager<SupportTicketResponseEmailArgs>(
    buildSupportTicketResponseEmail,
  );

export function supportNextStepText(status: SupportTicketStatus): string {
  switch (status) {
    case "OPEN":
      return "It is back in the queue and a member of the support team will pick it up.";
    case "IN_PROGRESS":
      return "A member of the support team is working on it and will reply on the ticket.";
    case "ON_HOLD":
      return "We are waiting on something before we can continue, and we will let you know as soon as it moves.";
    case "RESOLVED":
      return "If this fixed the problem, nothing more is needed. If it did not, reply on the ticket and it will be reopened.";
    case "CLOSED":
      return "The ticket is closed. If you need anything else, open a new request from your dashboard.";
  }
}

export interface SupportTicketUpdateEmailArgs {
  ticketId: string;
  ownerUserId: string;
  reference?: string;
  title: string;
  statusCode: SupportTicketStatus;
  statusLabel: string;
  ticketUrl: string;
}

function buildSupportTicketUpdateEmail(args: SupportTicketUpdateEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  return {
    userIds: [args.ownerUserId],
    spec: {
      emailType: "SUPPORT_TICKET_UPDATE",
      category: "support",
      from: SENDERS.notifications,
      entityRef: `ticket:${args.ticketId}`,
      subject: () => supportTicketUpdateSubject(args),
      render: (r) =>
        React.createElement(SupportTicketUpdateEmail, {
          recipientName: greet(r),
          reference: args.reference,
          title: args.title,
          statusLabel: args.statusLabel,
          nextStepText: supportNextStepText(args.statusCode),
          ticketUrl: absolute(args.ticketUrl),
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
  };
}

export const sendSupportTicketUpdateEmail =
  defineBudgetedEmailSender<SupportTicketUpdateEmailArgs>(
    buildSupportTicketUpdateEmail,
  );

export const stageSupportTicketUpdateEmail =
  defineLifecycleStager<SupportTicketUpdateEmailArgs>(
    buildSupportTicketUpdateEmail,
  );

export interface FeedbackUpdateEmailArgs {
  feedbackId: string;
  userId: string;
  title?: string;
  statusLabel: string;
  replyText?: string | null;
  dashboardUrl: string;
}

function buildFeedbackUpdateEmail(args: FeedbackUpdateEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  const title = args.title ?? "Product feedback";
  return {
    userIds: [args.userId],
    spec: {
      emailType: "PLATFORM_FEEDBACK_UPDATE",
      category: "feedback",
      from: SENDERS.notifications,
      entityRef: `feedback:${args.feedbackId}`,
      subject: () =>
        supportTicketResponseSubject({
          kind: "FEEDBACK_UPDATED",
          statusLabel: args.statusLabel,
        }),
      render: (r) =>
        React.createElement(SupportTicketResponseEmail, {
          kind: "FEEDBACK_UPDATED",
          recipientName: greet(r),
          title,
          statusLabel: args.statusLabel,
          replyText: args.replyText ?? "",
          ticketUrl: absolute(args.dashboardUrl),
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
  };
}

export const stageFeedbackUpdateEmail =
  defineLifecycleStager<FeedbackUpdateEmailArgs>(buildFeedbackUpdateEmail);

// ── Account & Moderation ────────────────────────────────────────────────────

export type ModerationReportOutcomeEmailArgs = {
  reportId: string;
  reference: string;
  outcome: string;
  reason?: string | null;
  dashboardUrl?: string;
} & (
  | { userId: string; reporterUserId?: string }
  | { reporterUserId: string; userId?: string }
);

function buildModerationReportOutcomeEmail(
  args: ModerationReportOutcomeEmailArgs,
): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  const recipientUserId = args.reporterUserId ?? args.userId ?? "";
  const subject = `Update on your report (${args.reference})`;
  return {
    userIds: [recipientUserId],
    spec: {
      emailType: "MODERATION_REPORT_OUTCOME",
      category: null,
      from: SENDERS.security,
      entityRef: `report:${args.reportId}`,
      subject: () => subject,
      render: (r) =>
        React.createElement(EmailLayout, {
          preview: subject,
          children: [
            React.createElement(Text, { style: heading, key: "h" }, subject),
            React.createElement(
              Text,
              { style: paragraph, key: "greet" },
              `Hi ${greet(r)},`,
            ),
            React.createElement(
              Text,
              { style: paragraph, key: "body" },
              `We have completed reviewing your report `,
              React.createElement("strong", null, args.reference),
              `. Outcome: `,
              React.createElement("strong", null, args.outcome),
              args.reason ? `. ${args.reason}` : ".",
            ),
            ...(args.dashboardUrl
              ? [
                  React.createElement(
                    Section,
                    { style: buttonContainer, key: "cta" },
                    React.createElement(
                      Button,
                      { style: button, href: absolute(args.dashboardUrl) },
                      "Open dashboard",
                    ),
                  ),
                ]
              : []),
          ],
        }),
    },
  };
}

export const stageModerationReportOutcomeEmail =
  defineLifecycleStager<ModerationReportOutcomeEmailArgs>(
    buildModerationReportOutcomeEmail,
  );

export interface AccountModerationEmailArgs {
  userId: string;
  kind: AccountRestrictedEmailKind;
  reason?: string | null;
  suspendedUntil?: Date | string | null;
  appointmentsCancelled?: number | null;
  supportUrl?: string;
  dashboardUrl?: string;
}

function buildAccountModerationEmail(args: AccountModerationEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  const until = args.suspendedUntil || null;
  const emailTypeMap: Record<AccountRestrictedEmailKind, string> = {
    BANNED: "ACCOUNT_BANNED",
    SUSPENDED: "ACCOUNT_SUSPENDED",
    REINSTATED: "ACCOUNT_REINSTATED",
    MODERATION_WARNING: "MODERATION_WARNING",
    WARNING: "MODERATION_WARNING",
    CONTENT_REMOVED: "CONTENT_REMOVED_NOTICE",
    REVIEW_EXCLUDED: "REVIEW_EXCLUDED_FROM_RATING",
  };
  return {
    userIds: [args.userId],
    spec: {
      emailType: emailTypeMap[args.kind],
      category: null,
      from: SENDERS.security,
      entityRef: `user:${args.userId}`,
      subject: () => accountRestrictedSubject(args.kind),
      render: (r) =>
        React.createElement(AccountRestrictedEmail, {
          kind: args.kind,
          recipientName: greet(r),
          reason: args.reason ?? undefined,
          suspendedUntilText: until ? whenText(until, r.zone) : undefined,
          appointmentsCancelled: args.appointmentsCancelled ?? 0,
          supportEmail: supportEmail(),
          supportUrl: args.supportUrl ? absolute(args.supportUrl) : undefined,
          dashboardUrl: args.dashboardUrl
            ? absolute(args.dashboardUrl)
            : undefined,
        }),
    },
  };
}

export const stageAccountModerationEmail =
  defineLifecycleStager<AccountModerationEmailArgs>(
    buildAccountModerationEmail,
  );

export interface AccountSuspendedEmailArgs {
  userId: string;
  reason?: string | null;
  suspendedUntil?: Date | string | null;
  appointmentsCancelled?: number | null;
}

function buildAccountSuspendedEmail(args: AccountSuspendedEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  const until = args.suspendedUntil || null;
  return {
    userIds: [args.userId],
    spec: {
      emailType: "ACCOUNT_SUSPENDED",
      category: null,
      from: SENDERS.security,
      entityRef: `user:${args.userId}`,
      subject: () => ACCOUNT_SUSPENDED_SUBJECT,
      render: (r) =>
        React.createElement(AccountSuspendedEmail, {
          recipientName: greet(r),
          reason: args.reason ?? undefined,
          suspendedUntilText: until ? whenText(until, r.zone) : undefined,
          appointmentsCancelled: args.appointmentsCancelled ?? 0,
          supportEmail: supportEmail(),
        }),
    },
  };
}

export const sendAccountSuspendedEmail =
  defineBudgetedEmailSender<AccountSuspendedEmailArgs>(
    buildAccountSuspendedEmail,
  );

export interface AccountBannedEmailArgs {
  userId: string;
  reason?: string | null;
  appointmentsCancelled?: number | null;
}

function buildAccountBannedEmail(args: AccountBannedEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  return {
    userIds: [args.userId],
    spec: {
      emailType: "ACCOUNT_BANNED",
      category: null,
      from: SENDERS.security,
      entityRef: `user:${args.userId}`,
      subject: () => ACCOUNT_BANNED_SUBJECT,
      render: (r) =>
        React.createElement(AccountBannedEmail, {
          recipientName: greet(r),
          reason: args.reason ?? undefined,
          appointmentsCancelled: args.appointmentsCancelled ?? 0,
          supportEmail: supportEmail(),
        }),
    },
  };
}

export const sendAccountBannedEmail =
  defineBudgetedEmailSender<AccountBannedEmailArgs>(buildAccountBannedEmail);

// ── Reviews ─────────────────────────────────────────────────────────────────

export interface NewReviewEmailArgs {
  reviewId: string;
  consultantUserId: string;
  reviewerName: string;
  rating: number;
  comment?: string | null;
  reviewUrl: string;
}

function buildNewReviewEmail(args: NewReviewEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  return {
    userIds: [args.consultantUserId],
    spec: {
      emailType: "NEW_REVIEW_RECEIVED",
      category: "feedback",
      from: SENDERS.notifications,
      entityRef: `review:${args.reviewId}`,
      subject: () => newReviewSubject(args),
      render: (r) =>
        React.createElement(NewReviewEmail, {
          consultantName: greet(r),
          reviewerName: args.reviewerName,
          rating: args.rating,
          excerpt: excerptOf(args.comment),
          reviewUrl: absolute(args.reviewUrl),
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
  };
}

export const sendNewReviewEmail =
  defineBudgetedEmailSender<NewReviewEmailArgs>(buildNewReviewEmail);

export const stageNewReviewEmail =
  defineLifecycleStager<NewReviewEmailArgs>(buildNewReviewEmail);

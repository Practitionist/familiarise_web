/**
 * #1653 — the people and access emails: support replies and status changes,
 * suspension and ban notices, the SSO certificate expiry and a new review.
 * Each sender takes user ids plus the raw values its call site already holds,
 * resolves recipients through the preference gate (a `null` category is a
 * required notice that the gate never blocks), and renders per recipient in
 * that recipient's zone. None of them throws.
 */

import * as Sentry from "@sentry/nextjs";
import * as React from "react";
import type { SupportTicketStatus } from "@prisma/client";
import type { PreferenceCategory } from "@/lib/novu/templates/types";
import { formatInViewerZone, zoneLabel } from "@/lib/time/viewer-zone";
import { getAppUrl } from "@/lib/url";
import AccountBannedEmail, {
  ACCOUNT_BANNED_SUBJECT,
} from "@/emails/account/AccountBannedEmail";
import AccountSuspendedEmail, {
  ACCOUNT_SUSPENDED_SUBJECT,
} from "@/emails/account/AccountSuspendedEmail";
import OrgSsoCertExpiringEmail, {
  orgSsoCertExpiringSubject,
  type SsoCertSeverity,
} from "@/emails/organizations/OrgSsoCertExpiringEmail";
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
import { loadEmailRecipients, type EmailRecipient } from "../preferences";
import {
  sendToRecipients,
  type SendToRecipientsResult,
} from "../send-to-recipients";

const WHEN_PATTERN = "EEE, d MMM yyyy 'at' h:mm a";

// "Tue, 15 Sep 2026 at 4:30 PM IST" — the same shape the booking emails use.
function whenText(date: Date | string, zone: string): string {
  return `${formatInViewerZone(date, zone, WHEN_PATTERN)} ${zoneLabel(date, zone)}`;
}

// The bells pass relative hrefs on some paths; a mail client needs absolute.
function absolute(href: string): string {
  return href.startsWith("/") ? `${getAppUrl()}${href}` : href;
}

function greet(r: EmailRecipient): string {
  return r.name?.trim() || "there";
}

// The in-app bell truncates a review or reply at 140 characters (b2c.ts).
const EXCERPT_LENGTH = 140;

function excerptOf(text: string | null | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > EXCERPT_LENGTH
    ? `${trimmed.slice(0, EXCERPT_LENGTH)}…`
    : trimmed;
}

type Spec = {
  emailType: string;
  /** `null` is a required notice: never gated, no unsubscribe link. */
  category: PreferenceCategory | null;
  from: string;
  entityRef: string;
  subject: (r: EmailRecipient) => string;
  render: (r: EmailRecipient) => React.ReactElement;
};

const FAILED: SendToRecipientsResult = { sent: 0, skipped: 0, failed: 1 };

// A sender never throws into a route or a script: the mail is best effort
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
      from: spec.from,
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

// ── Support ─────────────────────────────────────────────────────────────────

export interface SupportTicketResponseEmailArgs {
  ticketId: string;
  ownerUserId: string;
  reference?: string;
  title: string;
  respondedBy: string;
  replyText: string;
  ticketUrl: string;
}

export function sendSupportTicketResponseEmail(
  args: SupportTicketResponseEmailArgs,
  budgetMs: number,
): Promise<SendToRecipientsResult> {
  return guarded(
    {
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
    [args.ownerUserId],
    budgetMs,
  );
}

/** What the reader can expect after each status, for the update email. */
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
  /** The clause after "is now", as the bell renders it: "in progress". */
  statusLabel: string;
  ticketUrl: string;
}

export function sendSupportTicketUpdateEmail(
  args: SupportTicketUpdateEmailArgs,
  budgetMs: number,
): Promise<SendToRecipientsResult> {
  return guarded(
    {
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
    [args.ownerUserId],
    budgetMs,
  );
}

// ── Account ─────────────────────────────────────────────────────────────────

export interface AccountSuspendedEmailArgs {
  userId: string;
  reason?: string | null;
  /** Formatted in the user's own zone; an empty string counts as absent. */
  suspendedUntil?: Date | string | null;
  appointmentsCancelled?: number | null;
}

export function sendAccountSuspendedEmail(
  args: AccountSuspendedEmailArgs,
  budgetMs: number,
): Promise<SendToRecipientsResult> {
  const until = args.suspendedUntil || null;
  return guarded(
    {
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
    [args.userId],
    budgetMs,
  );
}

export interface AccountBannedEmailArgs {
  userId: string;
  reason?: string | null;
  appointmentsCancelled?: number | null;
}

export function sendAccountBannedEmail(
  args: AccountBannedEmailArgs,
  budgetMs: number,
): Promise<SendToRecipientsResult> {
  return guarded(
    {
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
    [args.userId],
    budgetMs,
  );
}

// ── Organisation ────────────────────────────────────────────────────────────

export interface OrgSsoCertExpiringEmailArgs {
  orgId: string;
  /** The org's OWNER roster, resolved by the caller. */
  recipientUserIds: string[];
  orgName: string;
  providerName: string;
  severity: SsoCertSeverity;
  daysRemaining?: number;
  notAfter: Date | string;
  updateUrl: string;
}

export function sendOrgSsoCertExpiringEmail(
  args: OrgSsoCertExpiringEmailArgs,
  budgetMs: number,
): Promise<SendToRecipientsResult> {
  return guarded(
    {
      emailType: "ORG_SSO_CERT_EXPIRING",
      category: null,
      from: SENDERS.security,
      entityRef: `org:${args.orgId}`,
      subject: () => orgSsoCertExpiringSubject(args),
      render: (r) =>
        React.createElement(OrgSsoCertExpiringEmail, {
          orgName: args.orgName,
          providerName: args.providerName,
          severity: args.severity,
          daysRemaining: args.daysRemaining,
          expiresAtText: whenText(args.notAfter, r.zone),
          updateUrl: absolute(args.updateUrl),
        }),
    },
    args.recipientUserIds,
    budgetMs,
  );
}

// ── Reviews ─────────────────────────────────────────────────────────────────

export interface NewReviewEmailArgs {
  reviewId: string;
  consultantUserId: string;
  /** Already anonymised by the caller when the reviewer withheld their name. */
  reviewerName: string;
  rating: number;
  comment?: string | null;
  reviewUrl: string;
}

export function sendNewReviewEmail(
  args: NewReviewEmailArgs,
  budgetMs: number,
): Promise<SendToRecipientsResult> {
  return guarded(
    {
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
    [args.consultantUserId],
    budgetMs,
  );
}

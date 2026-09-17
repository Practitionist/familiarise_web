/**
 * P3 onboarding email twins — the Resend side of the onboarding/org bells.
 *
 * Every sender here is a required notice (`category: null`): verification
 * outcomes, roster changes, org creation and invite-accept affect access or
 * money-adjacent state, so the preference gate never blocks them. Each takes
 * user ids plus the raw values its call site already holds, resolves
 * recipients through the preference gate, renders per recipient, and never
 * throws (fire-and-forget from routes; the outbox relay finishes the send).
 */

import * as Sentry from "@sentry/nextjs";
import * as React from "react";
import VerificationDecidedEmail, {
  verificationDecidedSubject,
  type VerificationDecidedStatus,
} from "@/emails/verification/VerificationDecidedEmail";
import OrgCreatedEmail, {
  orgCreatedSubject,
} from "@/emails/organizations/OrgCreatedEmail";
import OrgMembershipChangedEmail, {
  orgMembershipChangedSubject,
  type OrgMembershipChangeKind,
} from "@/emails/organizations/OrgMembershipChangedEmail";
import OrgWelcomeEmail, {
  orgWelcomeSubject,
} from "@/emails/organizations/OrgWelcomeEmail";
import { getAppUrl } from "@/lib/url";
import { EMAIL_BUDGET_MS, SENDERS, supportEmail } from "../config";
import { loadEmailRecipients, type EmailRecipient } from "../preferences";
import {
  sendToRecipients,
  type SendToRecipientsResult,
} from "../send-to-recipients";

export const ONBOARDING_EMAIL_TYPES = {
  VERIFICATION_DECIDED: "VERIFICATION_DECIDED",
  ORG_MEMBERSHIP_ROLE_CHANGED: "ORG_MEMBERSHIP_ROLE_CHANGED",
  ORG_MEMBERSHIP_REMOVED: "ORG_MEMBERSHIP_REMOVED",
  ORG_CREATED: "ORG_CREATED",
  ORG_WELCOME: "ORG_WELCOME",
} as const;

type Spec = {
  emailType: string;
  entityRef: string;
  from: string;
  budgetMs: number;
  subject: (r: EmailRecipient) => string;
  render: (r: EmailRecipient) => React.ReactElement;
};

const FAILED: SendToRecipientsResult = { sent: 0, skipped: 0, failed: 1 };

function absolute(href: string): string {
  return href.startsWith("/") ? `${getAppUrl()}${href}` : href;
}

function greet(r: EmailRecipient): string {
  return r.name?.trim() || "there";
}

async function guarded(
  spec: Spec,
  userIds: string[],
): Promise<SendToRecipientsResult> {
  try {
    const recipients = await loadEmailRecipients(userIds, null);
    return await sendToRecipients({
      recipients,
      emailType: spec.emailType,
      from: spec.from,
      entityRef: spec.entityRef,
      budgetMs: spec.budgetMs,
      subject: spec.subject,
      render: spec.render,
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

// ── Verification decided ────────────────────────────────────────────────────

export interface VerificationDecidedEmailArgs {
  userId: string;
  verificationId: string;
  status: VerificationDecidedStatus;
  reason?: string;
  dashboardUrl: string;
}

/** Post-commit twin of the verification-status-changed bell. */
export function sendVerificationDecidedEmail(
  args: VerificationDecidedEmailArgs,
): Promise<SendToRecipientsResult> {
  const dashboardUrl = absolute(args.dashboardUrl);
  const support = supportEmail();
  return guarded(
    {
      emailType: ONBOARDING_EMAIL_TYPES.VERIFICATION_DECIDED,
      entityRef: `verification:${args.verificationId}`,
      from: SENDERS.onboarding,
      budgetMs: EMAIL_BUDGET_MS.REQUEST,
      subject: () => verificationDecidedSubject(args.status),
      render: (r) =>
        React.createElement(VerificationDecidedEmail, {
          recipientName: greet(r),
          status: args.status,
          reason: args.reason,
          dashboardUrl,
          supportEmail: support,
        }),
    },
    [args.userId],
  );
}

// ── Membership role change / removal (non-EXPERT) ───────────────────────────

export interface OrgMembershipChangedEmailArgs {
  userId: string;
  membershipId: string;
  kind: OrgMembershipChangeKind;
  orgName: string;
  roleBefore?: string;
  roleAfter?: string;
  actorName: string;
  dashboardUrl: string;
}

/** Post-commit required notice to the affected member. */
export function sendOrgMembershipChangedEmail(
  args: OrgMembershipChangedEmailArgs,
): Promise<SendToRecipientsResult> {
  const dashboardUrl = absolute(args.dashboardUrl);
  const support = supportEmail();
  const emailType =
    args.kind === "REMOVED"
      ? ONBOARDING_EMAIL_TYPES.ORG_MEMBERSHIP_REMOVED
      : ONBOARDING_EMAIL_TYPES.ORG_MEMBERSHIP_ROLE_CHANGED;
  return guarded(
    {
      emailType,
      entityRef: `membership:${args.membershipId}`,
      from: SENDERS.notifications,
      budgetMs: EMAIL_BUDGET_MS.REQUEST,
      subject: () =>
        orgMembershipChangedSubject({ kind: args.kind, orgName: args.orgName }),
      render: (r) =>
        React.createElement(OrgMembershipChangedEmail, {
          recipientName: greet(r),
          kind: args.kind,
          orgName: args.orgName,
          roleBefore: args.roleBefore,
          roleAfter: args.roleAfter,
          actorName: args.actorName,
          dashboardUrl,
          supportEmail: support,
        }),
    },
    [args.userId],
  );
}

// ── Org created ─────────────────────────────────────────────────────────────

export interface OrgCreatedEmailArgs {
  userId: string;
  orgId: string;
  orgName: string;
  dashboardUrl: string;
}

/** Post-commit confirmation to the creator. */
export function sendOrgCreatedEmail(
  args: OrgCreatedEmailArgs,
): Promise<SendToRecipientsResult> {
  const dashboardUrl = absolute(args.dashboardUrl);
  return guarded(
    {
      emailType: ONBOARDING_EMAIL_TYPES.ORG_CREATED,
      entityRef: `org:${args.orgId}`,
      from: SENDERS.onboarding,
      budgetMs: EMAIL_BUDGET_MS.REQUEST,
      subject: () => orgCreatedSubject(args.orgName),
      render: (r) =>
        React.createElement(OrgCreatedEmail, {
          recipientName: greet(r),
          orgName: args.orgName,
          dashboardUrl,
        }),
    },
    [args.userId],
  );
}

// ── Org welcome (acceptee) ──────────────────────────────────────────────────

export interface OrgWelcomeEmailArgs {
  userId: string;
  membershipId: string;
  orgName: string;
  role: string;
  dashboardUrl: string;
}

/** Post-commit welcome to the joiner; skipped when alreadyMember. */
export function sendOrgWelcomeEmail(
  args: OrgWelcomeEmailArgs,
): Promise<SendToRecipientsResult> {
  const dashboardUrl = absolute(args.dashboardUrl);
  return guarded(
    {
      emailType: ONBOARDING_EMAIL_TYPES.ORG_WELCOME,
      entityRef: `membership:${args.membershipId}`,
      from: SENDERS.onboarding,
      budgetMs: EMAIL_BUDGET_MS.REQUEST,
      subject: () => orgWelcomeSubject(args.orgName),
      render: (r) =>
        React.createElement(OrgWelcomeEmail, {
          recipientName: greet(r),
          orgName: args.orgName,
          role: args.role,
          dashboardUrl,
        }),
    },
    [args.userId],
  );
}

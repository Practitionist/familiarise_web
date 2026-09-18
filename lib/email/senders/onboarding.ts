/**
 * P3 onboarding email twins — the Resend side of the onboarding/org bells.
 *
 * Every sender here is a required notice (`category: null`): verification
 * outcomes, roster changes, org creation and invite-accept affect access or
 * money-adjacent state, so the preference gate never blocks them. Each takes
 * user ids plus the raw values its call site already holds, resolves
 * recipients through the preference gate, renders per recipient, and never
 * throws.
 *
 * Two shapes per notice. `send*` stages and attempts in one call (for a
 * caller with nothing else to do). `stage*` only writes the outbox rows —
 * one fast insert per recipient, no vendor call — and returns them for
 * `attemptOnboardingEmail()` inside `after()`. Routes use the second shape:
 * the row exists before the response, so a dropped or timed-out `after()`
 * costs nothing but latency (the relay finishes the send), while the
 * response never waits on the Resend budget.
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
import prisma from "@/lib/prisma";
import { getAppUrl } from "@/lib/url";
import { EMAIL_BUDGET_MS, SENDERS, supportEmail } from "../config";
import { loadEmailRecipients, type EmailRecipient } from "../preferences";
import {
  attemptStaged,
  sendToRecipients,
  stageToRecipients,
  type SendToRecipientsResult,
  type StagedRecipientEmail,
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

/** Outbox rows a route attempts after its response (`attemptOnboardingEmail`). */
export interface StagedOnboardingEmail {
  emailType: string;
  budgetMs: number;
  list: StagedRecipientEmail[];
}

const NOTHING_STAGED = (spec: Spec): StagedOnboardingEmail => ({
  emailType: spec.emailType,
  budgetMs: spec.budgetMs,
  list: [],
});

function absolute(href: string): string {
  return href.startsWith("/") ? `${getAppUrl()}${href}` : href;
}

function greet(r: EmailRecipient): string {
  return r.name?.trim() || "there";
}

// Stage only: recipients are resolved on the global client (never inside a
// transaction — PG_POOL_MAX=1), then one FailedEmail row per allowed
// recipient. A failure here is reported and yields an empty list; the
// caller's business write is already committed and must not be undone.
async function stageGuarded(
  spec: Spec,
  userIds: string[],
): Promise<StagedOnboardingEmail> {
  try {
    const recipients = await loadEmailRecipients(userIds, null);
    const list = await stageToRecipients({
      tx: prisma,
      recipients,
      emailType: spec.emailType,
      from: spec.from,
      entityRef: spec.entityRef,
      subject: spec.subject,
      render: spec.render,
    });
    return { emailType: spec.emailType, budgetMs: spec.budgetMs, list };
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "email", emailType: spec.emailType } },
    );
    console.error(`[email] ${spec.emailType} stage failed:`, error);
    return NOTHING_STAGED(spec);
  }
}

/** The `after()` half of a `stage*` call. Never throws. */
export async function attemptOnboardingEmail(
  staged: StagedOnboardingEmail,
): Promise<void> {
  if (staged.list.length === 0) return;
  try {
    await attemptStaged(staged.list, staged.emailType, staged.budgetMs);
  } catch (error) {
    console.error(`[email] ${staged.emailType} attempt failed:`, error);
  }
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

function verificationDecidedSpec(args: VerificationDecidedEmailArgs): Spec {
  const dashboardUrl = absolute(args.dashboardUrl);
  const support = supportEmail();
  return {
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
  };
}

/** Post-commit twin of the verification-status-changed bell. */
export function sendVerificationDecidedEmail(
  args: VerificationDecidedEmailArgs,
): Promise<SendToRecipientsResult> {
  return guarded(verificationDecidedSpec(args), [args.userId]);
}

/** Stage-only twin; attempt with `attemptOnboardingEmail()` after the response. */
export function stageVerificationDecidedEmail(
  args: VerificationDecidedEmailArgs,
): Promise<StagedOnboardingEmail> {
  return stageGuarded(verificationDecidedSpec(args), [args.userId]);
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

function orgMembershipChangedSpec(args: OrgMembershipChangedEmailArgs): Spec {
  const dashboardUrl = absolute(args.dashboardUrl);
  const support = supportEmail();
  return {
    emailType:
      args.kind === "REMOVED"
        ? ONBOARDING_EMAIL_TYPES.ORG_MEMBERSHIP_REMOVED
        : ONBOARDING_EMAIL_TYPES.ORG_MEMBERSHIP_ROLE_CHANGED,
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
  };
}

/** Post-commit required notice to the affected member. */
export function sendOrgMembershipChangedEmail(
  args: OrgMembershipChangedEmailArgs,
): Promise<SendToRecipientsResult> {
  return guarded(orgMembershipChangedSpec(args), [args.userId]);
}

/** Stage-only twin; attempt with `attemptOnboardingEmail()` after the response. */
export function stageOrgMembershipChangedEmail(
  args: OrgMembershipChangedEmailArgs,
): Promise<StagedOnboardingEmail> {
  return stageGuarded(orgMembershipChangedSpec(args), [args.userId]);
}

// ── Org created ─────────────────────────────────────────────────────────────

export interface OrgCreatedEmailArgs {
  userId: string;
  orgId: string;
  orgName: string;
  dashboardUrl: string;
}

function orgCreatedSpec(args: OrgCreatedEmailArgs): Spec {
  const dashboardUrl = absolute(args.dashboardUrl);
  return {
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
  };
}

/** Post-commit confirmation to the creator. */
export function sendOrgCreatedEmail(
  args: OrgCreatedEmailArgs,
): Promise<SendToRecipientsResult> {
  return guarded(orgCreatedSpec(args), [args.userId]);
}

/** Stage-only twin; attempt with `attemptOnboardingEmail()` after the response. */
export function stageOrgCreatedEmail(
  args: OrgCreatedEmailArgs,
): Promise<StagedOnboardingEmail> {
  return stageGuarded(orgCreatedSpec(args), [args.userId]);
}

// ── Org welcome (acceptee) ──────────────────────────────────────────────────

export interface OrgWelcomeEmailArgs {
  userId: string;
  membershipId: string;
  orgName: string;
  role: string;
  dashboardUrl: string;
}

function orgWelcomeSpec(args: OrgWelcomeEmailArgs): Spec {
  const dashboardUrl = absolute(args.dashboardUrl);
  return {
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
  };
}

/** Post-commit welcome to the joiner; skipped when alreadyMember. */
export function sendOrgWelcomeEmail(
  args: OrgWelcomeEmailArgs,
): Promise<SendToRecipientsResult> {
  return guarded(orgWelcomeSpec(args), [args.userId]);
}

/** Stage-only twin; attempt with `attemptOnboardingEmail()` after the response. */
export function stageOrgWelcomeEmail(
  args: OrgWelcomeEmailArgs,
): Promise<StagedOnboardingEmail> {
  return stageGuarded(orgWelcomeSpec(args), [args.userId]);
}

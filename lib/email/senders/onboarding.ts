/**
 * Onboarding and organization email twins — staged through the outbox and
 * attempted after the response via `attemptOnboardingEmail()`.
 */

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
import { EMAIL_BUDGET_MS, SENDERS, supportEmail } from "../config";
import { attemptStaged } from "../send-to-recipients";
import {
  absolute,
  defineStagedEmailSender,
  greet,
  type StagedOnboardingEmail,
  type StagingTx,
} from "./shared";

export type { StagedOnboardingEmail, StagingTx };

export const ONBOARDING_EMAIL_TYPES = {
  VERIFICATION_DECIDED: "VERIFICATION_DECIDED",
  ORG_MEMBERSHIP_ROLE_CHANGED: "ORG_MEMBERSHIP_ROLE_CHANGED",
  ORG_MEMBERSHIP_REMOVED: "ORG_MEMBERSHIP_REMOVED",
  ORG_CREATED: "ORG_CREATED",
  ORG_WELCOME: "ORG_WELCOME",
} as const;

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

// ── Verification decided ────────────────────────────────────────────────────

export interface VerificationDecidedEmailArgs {
  userId: string;
  verificationId: string;
  status: VerificationDecidedStatus;
  reason?: string;
  dashboardUrl: string;
  daysLeft?: number;
}

export const stageVerificationDecidedEmail =
  defineStagedEmailSender<VerificationDecidedEmailArgs>(
    EMAIL_BUDGET_MS.REQUEST,
    (args) => {
      const dashboardUrl = absolute(args.dashboardUrl);
      const support = supportEmail();
      return {
        userIds: [args.userId],
        spec: {
          emailType: ONBOARDING_EMAIL_TYPES.VERIFICATION_DECIDED,
          category: null,
          entityRef: `verification:${args.verificationId}`,
          from: SENDERS.onboarding,
          subject: () => verificationDecidedSubject(args.status),
          render: (r) =>
            React.createElement(VerificationDecidedEmail, {
              recipientName: greet(r),
              status: args.status,
              reason: args.reason,
              dashboardUrl,
              supportEmail: support,
              daysLeft: args.daysLeft,
            }),
        },
      };
    },
  );

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

export const stageOrgMembershipChangedEmail =
  defineStagedEmailSender<OrgMembershipChangedEmailArgs>(
    EMAIL_BUDGET_MS.REQUEST,
    (args) => {
      const dashboardUrl = absolute(args.dashboardUrl);
      const support = supportEmail();
      return {
        userIds: [args.userId],
        spec: {
          emailType:
            args.kind === "REMOVED"
              ? ONBOARDING_EMAIL_TYPES.ORG_MEMBERSHIP_REMOVED
              : ONBOARDING_EMAIL_TYPES.ORG_MEMBERSHIP_ROLE_CHANGED,
          category: null,
          entityRef: `membership:${args.membershipId}`,
          from: SENDERS.notifications,
          subject: () =>
            orgMembershipChangedSubject({
              kind: args.kind,
              orgName: args.orgName,
            }),
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
      };
    },
  );

// ── Org created ─────────────────────────────────────────────────────────────

export interface OrgCreatedEmailArgs {
  userId: string;
  orgId: string;
  orgName: string;
  dashboardUrl: string;
}

export const stageOrgCreatedEmail =
  defineStagedEmailSender<OrgCreatedEmailArgs>(
    EMAIL_BUDGET_MS.REQUEST,
    (args) => {
      const dashboardUrl = absolute(args.dashboardUrl);
      return {
        userIds: [args.userId],
        spec: {
          emailType: ONBOARDING_EMAIL_TYPES.ORG_CREATED,
          category: null,
          entityRef: `org:${args.orgId}`,
          from: SENDERS.onboarding,
          subject: () => orgCreatedSubject(args.orgName),
          render: (r) =>
            React.createElement(OrgCreatedEmail, {
              recipientName: greet(r),
              orgName: args.orgName,
              dashboardUrl,
            }),
        },
      };
    },
  );

// ── Org welcome (acceptee) ──────────────────────────────────────────────────

export interface OrgWelcomeEmailArgs {
  userId: string;
  membershipId: string;
  orgName: string;
  role: string;
  dashboardUrl: string;
}

export const stageOrgWelcomeEmail =
  defineStagedEmailSender<OrgWelcomeEmailArgs>(
    EMAIL_BUDGET_MS.REQUEST,
    (args) => {
      const dashboardUrl = absolute(args.dashboardUrl);
      return {
        userIds: [args.userId],
        spec: {
          emailType: ONBOARDING_EMAIL_TYPES.ORG_WELCOME,
          category: null,
          entityRef: `membership:${args.membershipId}`,
          from: SENDERS.onboarding,
          subject: () => orgWelcomeSubject(args.orgName),
          render: (r) =>
            React.createElement(OrgWelcomeEmail, {
              recipientName: greet(r),
              orgName: args.orgName,
              role: args.role,
              dashboardUrl,
            }),
        },
      };
    },
  );

/**
 * Onboarding and organization email twins — staged through the outbox and
 * attempted after the response via `attemptOnboardingEmail()`.
 */

import * as React from "react";
import VerificationDecidedEmail, {
  verificationDecidedSubject,
  type VerificationDecidedStatus,
} from "@/emails/verification/VerificationDecidedEmail";
import OrgContractAndSeatEmail, {
  orgContractAndSeatSubject,
  type OrgContractAndSeatEmailKind,
} from "@/emails/organizations/OrgContractAndSeatEmail";
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
  dateText,
  defineBudgetedEmailSender,
  defineLifecycleStager,
  defineStagedEmailSender,
  greet,
  type RecipientEmailSpec,
  type StagedOnboardingEmail,
} from "./shared";

export type { OrgContractAndSeatEmailKind, StagedOnboardingEmail };
export { type StagingTx } from "./shared";

export const ONBOARDING_EMAIL_TYPES = {
  VERIFICATION_DECIDED: "VERIFICATION_DECIDED",
  ORG_MEMBERSHIP_ROLE_CHANGED: "ORG_MEMBERSHIP_ROLE_CHANGED",
  ORG_MEMBERSHIP_REMOVED: "ORG_MEMBERSHIP_REMOVED",
  ORG_INVITE_ACCEPTED_OPERATOR: "ORG_INVITE_ACCEPTED_OPERATOR",
  ORG_CONTRACT_AND_SEAT: "ORG_CONTRACT_AND_SEAT",
  COMPLIANCE_ALERT: "COMPLIANCE_ALERT",
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

function buildVerificationDecidedSpec(args: VerificationDecidedEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
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
}

export const stageVerificationDecidedEmail =
  defineStagedEmailSender<VerificationDecidedEmailArgs>(
    EMAIL_BUDGET_MS.REQUEST,
    buildVerificationDecidedSpec,
  );

export const sendVerificationDecidedEmail =
  defineBudgetedEmailSender<VerificationDecidedEmailArgs>(
    buildVerificationDecidedSpec,
  );

// ── Membership role change / removal / operator invite acceptance ───────────

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

function buildOrgMembershipChangedSpec(args: OrgMembershipChangedEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
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
          actorName: args.actorName,
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
}

export const stageOrgMembershipChangedEmail =
  defineStagedEmailSender<OrgMembershipChangedEmailArgs>(
    EMAIL_BUDGET_MS.REQUEST,
    buildOrgMembershipChangedSpec,
  );

export const sendOrgMembershipChangedEmail =
  defineBudgetedEmailSender<OrgMembershipChangedEmailArgs>(
    buildOrgMembershipChangedSpec,
  );

export interface OrgInviteAcceptedOperatorEmailArgs {
  recipientUserIds: string[];
  membershipId: string;
  orgName: string;
  role: string;
  memberName: string;
  dashboardUrl: string;
}

function buildOrgInviteAcceptedOperatorSpec(
  args: OrgInviteAcceptedOperatorEmailArgs,
): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  const dashboardUrl = absolute(args.dashboardUrl);
  const support = supportEmail();
  return {
    userIds: args.recipientUserIds,
    spec: {
      emailType: ONBOARDING_EMAIL_TYPES.ORG_INVITE_ACCEPTED_OPERATOR,
      category: null,
      entityRef: `membership:${args.membershipId}:operator`,
      from: SENDERS.notifications,
      subject: () =>
        orgMembershipChangedSubject({
          kind: "MEMBER_JOINED",
          orgName: args.orgName,
          actorName: args.memberName,
        }),
      render: (r) =>
        React.createElement(OrgMembershipChangedEmail, {
          recipientName: greet(r),
          kind: "MEMBER_JOINED",
          orgName: args.orgName,
          roleAfter: args.role,
          actorName: args.memberName,
          dashboardUrl,
          supportEmail: support,
        }),
    },
  };
}

export const stageOrgInviteAcceptedOperatorEmail =
  defineLifecycleStager<OrgInviteAcceptedOperatorEmailArgs>(
    buildOrgInviteAcceptedOperatorSpec,
  );

export const sendOrgInviteAcceptedOperatorEmail =
  defineBudgetedEmailSender<OrgInviteAcceptedOperatorEmailArgs>(
    buildOrgInviteAcceptedOperatorSpec,
  );

// ── Org created ─────────────────────────────────────────────────────────────

export interface OrgCreatedEmailArgs {
  userId: string;
  orgId: string;
  orgName: string;
  dashboardUrl: string;
}

function buildOrgCreatedSpec(args: OrgCreatedEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
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
}

export const stageOrgCreatedEmail =
  defineStagedEmailSender<OrgCreatedEmailArgs>(
    EMAIL_BUDGET_MS.REQUEST,
    buildOrgCreatedSpec,
  );

export const sendOrgCreatedEmail =
  defineBudgetedEmailSender<OrgCreatedEmailArgs>(buildOrgCreatedSpec);

// ── Org welcome (acceptee) ──────────────────────────────────────────────────

export interface OrgWelcomeEmailArgs {
  userId: string;
  membershipId: string;
  orgName: string;
  role: string;
  dashboardUrl: string;
}

function buildOrgWelcomeSpec(args: OrgWelcomeEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
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
}

export const stageOrgWelcomeEmail =
  defineStagedEmailSender<OrgWelcomeEmailArgs>(
    EMAIL_BUDGET_MS.REQUEST,
    buildOrgWelcomeSpec,
  );

export const sendOrgWelcomeEmail =
  defineBudgetedEmailSender<OrgWelcomeEmailArgs>(buildOrgWelcomeSpec);

// ── Org contract & seat lifecycle + compliance deadline alerts ──────────────

export interface OrgContractAndSeatEmailArgs {
  recipientUserIds: string[];
  entityId: string;
  kind: Exclude<OrgContractAndSeatEmailKind, "COMPLIANCE_ALERT">;
  orgName: string;
  programName?: string;
  effectiveDate?: Date | string;
  reason?: string | null;
  dashboardUrl: string;
}

function buildOrgContractAndSeatSpec(args: OrgContractAndSeatEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  const dashboardUrl = absolute(args.dashboardUrl);
  return {
    userIds: args.recipientUserIds,
    spec: {
      emailType: ONBOARDING_EMAIL_TYPES.ORG_CONTRACT_AND_SEAT,
      category: null,
      entityRef: `org_contract_seat:${args.entityId}:${args.kind.toLowerCase()}`,
      from: SENDERS.notifications,
      subject: () =>
        orgContractAndSeatSubject({
          kind: args.kind,
          orgName: args.orgName,
          programName: args.programName,
        }),
      render: (r) =>
        React.createElement(OrgContractAndSeatEmail, {
          recipientName: greet(r),
          kind: args.kind,
          orgName: args.orgName,
          programName: args.programName,
          effectiveDateText: args.effectiveDate
            ? dateText(args.effectiveDate, r.zone)
            : undefined,
          reason: args.reason,
          dashboardUrl,
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
  };
}

export const stageOrgContractAndSeatEmail =
  defineLifecycleStager<OrgContractAndSeatEmailArgs>(
    buildOrgContractAndSeatSpec,
  );

export const sendOrgContractAndSeatEmail =
  defineBudgetedEmailSender<OrgContractAndSeatEmailArgs>(
    buildOrgContractAndSeatSpec,
  );

export interface ComplianceAlertEmailArgs {
  recipientUserIds: string[];
  alertId: string;
  title: string;
  orgName?: string;
  dueDate?: Date | string;
  reason?: string | null;
  dashboardUrl: string;
}

function buildComplianceAlertSpec(args: ComplianceAlertEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  const dashboardUrl = absolute(args.dashboardUrl);
  return {
    userIds: args.recipientUserIds,
    spec: {
      emailType: ONBOARDING_EMAIL_TYPES.COMPLIANCE_ALERT,
      category: null,
      entityRef: `compliance:${args.alertId}`,
      from: SENDERS.security,
      subject: () =>
        orgContractAndSeatSubject({
          kind: "COMPLIANCE_ALERT",
          title: args.title,
        }),
      render: (r) =>
        React.createElement(OrgContractAndSeatEmail, {
          recipientName: greet(r),
          kind: "COMPLIANCE_ALERT",
          title: args.title,
          orgName: args.orgName,
          dueDateText: args.dueDate
            ? dateText(args.dueDate, r.zone)
            : undefined,
          reason: args.reason,
          dashboardUrl,
        }),
    },
  };
}

export const stageComplianceAlertEmail =
  defineLifecycleStager<ComplianceAlertEmailArgs>(buildComplianceAlertSpec);

export const sendComplianceAlertEmail =
  defineBudgetedEmailSender<ComplianceAlertEmailArgs>(buildComplianceAlertSpec);

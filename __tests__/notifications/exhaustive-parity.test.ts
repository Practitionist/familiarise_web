/** @jest-environment node */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NotificationOutboxKind } from "@prisma/client";
import {
  FAMILIES,
  EVENT_FAMILY,
  familyOf,
} from "@/lib/novu/templates/families";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import {
  AccountRestrictedEmail,
  accountRestrictedSubject,
  type AccountRestrictedEmailKind,
} from "@/emails/auth/AccountRestrictedEmail";
import {
  ClassSessionEmail,
  classSessionSubject,
  type ClassSessionEmailKind,
} from "@/emails/booking/ClassSessionEmail";
import {
  DocumentAndRecordingEmail,
  documentAndRecordingSubject,
  type DocumentAndRecordingEmailKind,
} from "@/emails/booking/DocumentAndRecordingEmail";
import {
  TrialAndSubscriptionEmail,
  trialAndSubscriptionSubject,
  type TrialAndSubscriptionEmailKind,
} from "@/emails/booking/TrialAndSubscriptionEmail";
import {
  OrgContractAndSeatEmail,
  orgContractAndSeatSubject,
  type OrgContractAndSeatEmailKind,
} from "@/emails/organizations/OrgContractAndSeatEmail";
import {
  OrgDunningEmail,
  orgOperationalEmailSubject,
  type OrgOperationalEmailKind,
} from "@/emails/payments/OrgDunningEmail";
import {
  ReferralBonusEmail,
  referralBonusSubject,
  type ReferralBonusEmailKind,
} from "@/emails/payments/ReferralBonusEmail";
import SupportTicketResponseEmail, {
  supportTicketResponseSubject,
  type SupportTicketEmailKind,
} from "@/emails/support/SupportTicketResponseEmail";
import VerificationDecidedEmail, {
  verificationDecidedSubject,
  type VerificationDecidedStatus,
} from "@/emails/verification/VerificationDecidedEmail";
import AppointmentRescheduledEmail, {
  type RescheduleEmailOutcome,
} from "@/emails/booking/AppointmentRescheduledEmail";
import OrgMembershipChangedEmail, {
  orgMembershipChangedSubject,
  type OrgMembershipChangeKind,
} from "@/emails/organizations/OrgMembershipChangedEmail";
import SsoProviderEmail, {
  ssoProviderSubject,
  type SsoProviderEmailKind,
} from "@/emails/organizations/SsoProviderEmail";
import { recordFlowOutcome } from "@/lib/support/deflection";
import {
  applyBestEffortEffects,
  applyTransactionalEffects,
} from "@/lib/moderation/side-effects";
import { sendSecurityEventEmail } from "@/lib/auth/security-email";
import type { StagedTrigger } from "@/lib/novu/outbox";

const mockStageBell = jest.fn<Promise<StagedTrigger>, [unknown, unknown]>();
const mockNotifyAccountSecurityNotice = jest.fn();
const mockNotifyModerationWarning = jest.fn();
const mockNotifyAccountSuspended = jest.fn();
const mockNotifyAccountBanned = jest.fn();
const mockNotifyVerificationStatusChanged = jest.fn();
const mockFlushNotificationsAfter = jest.fn();
const mockStageAccountModerationEmail = jest.fn();
const mockStageModerationReportOutcomeEmail = jest.fn();
const mockStageVerificationDecidedEmail = jest.fn();
const mockSendSecurityNoticeEmail = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportFlowOutcome: {
      create: jest.fn().mockResolvedValue({ id: "outcome-1" }),
    },
  },
}));

jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: (tx: unknown, input: unknown) => mockStageBell(tx, input),
}));

jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: (bundle: unknown, label: string) =>
    mockFlushNotificationsAfter(bundle, label),
  stageNowAttemptAfter: async (label: string, fn: () => Promise<unknown>) => {
    await fn();
    mockFlushNotificationsAfter({}, label);
  },
}));

jest.mock("../../lib/novu/service", () => ({
  notifyAccountSecurityNotice: (...args: unknown[]) =>
    mockNotifyAccountSecurityNotice(...args),
  notifyModerationWarning: (...args: unknown[]) =>
    mockNotifyModerationWarning(...args),
  notifyAccountSuspended: (...args: unknown[]) =>
    mockNotifyAccountSuspended(...args),
  notifyAccountBanned: (...args: unknown[]) => mockNotifyAccountBanned(...args),
  notifyVerificationStatusChanged: (...args: unknown[]) =>
    mockNotifyVerificationStatusChanged(...args),
}));

jest.mock("../../lib/novu", () => ({
  notifyModerationWarning: (...args: unknown[]) =>
    mockNotifyModerationWarning(...args),
  notifyAccountSuspended: (...args: unknown[]) =>
    mockNotifyAccountSuspended(...args),
  notifyAccountBanned: (...args: unknown[]) => mockNotifyAccountBanned(...args),
  notifyVerificationStatusChanged: (...args: unknown[]) =>
    mockNotifyVerificationStatusChanged(...args),
  notifyAccountSecurityNotice: (...args: unknown[]) =>
    mockNotifyAccountSecurityNotice(...args),
}));

jest.mock("../../lib/email/senders/people", () => ({
  stageAccountModerationEmail: (...args: unknown[]) =>
    mockStageAccountModerationEmail(...args),
  stageModerationReportOutcomeEmail: (...args: unknown[]) =>
    mockStageModerationReportOutcomeEmail(...args),
}));

jest.mock("../../lib/email/senders/onboarding", () => ({
  stageVerificationDecidedEmail: (...args: unknown[]) =>
    mockStageVerificationDecidedEmail(...args),
}));

jest.mock("../../lib/email", () => ({
  sendSecurityNoticeEmail: (...args: unknown[]) =>
    mockSendSecurityNoticeEmail(...args),
}));

jest.mock("../../lib/moderation/cancel-user-engagements", () => ({
  cancelFutureEngagementsForUser: jest.fn().mockResolvedValue({
    cancelled: 2,
    refunded: 0,
    errors: [],
  }),
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn().mockReturnValue({
    revokeUserToken: jest.fn().mockResolvedValue(undefined),
    deleteMessage: jest.fn().mockResolvedValue(undefined),
  }),
  isExpectedStreamError: jest.fn().mockReturnValue(false),
  withStreamCircuitBreaker: async (fn: () => Promise<unknown>) => fn(),
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

describe("Exhaustive Dual-Channel Notification & Template Parity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStageBell.mockImplementation(async (_tx, input) => ({
      id: "outbox-row-1",
      kind: NotificationOutboxKind.SINGLE,
      workflowId:
        typeof input === "object" && input !== null && "workflowId" in input
          ? String(input.workflowId)
          : "unknown",
      transactionId: "tx-1",
      recipients: ["user-1"],
      payload: {},
      attempts: 0,
      status: "PENDING",
      notBefore: null,
    }));
    mockStageAccountModerationEmail.mockResolvedValue([
      { id: "fe-mod-1", emailType: "MODERATION_WARNING" },
    ]);
    mockStageModerationReportOutcomeEmail.mockResolvedValue([
      { id: "fe-rep-1", emailType: "MODERATION_REPORT_OUTCOME" },
    ]);
    mockStageVerificationDecidedEmail.mockResolvedValue({
      emailType: "VERIFICATION_DECIDED",
      budgetMs: 3000,
      list: [
        {
          row: { id: "fe-verif-1" },
          message: { to: "u@example.com", subject: "s", html: "<p>h</p>" },
        },
      ],
    });
    mockNotifyVerificationStatusChanged.mockResolvedValue({
      success: true,
      staged: {
        id: "verif-bell-1",
        kind: "trigger" as const,
        workflowId: "verification-status-changed",
        transactionId: "verif-tx-1",
        recipients: ["target-1"],
        payload: {},
        attempts: 0,
        status: "PENDING",
        notBefore: null,
      },
    });
    mockNotifyAccountSecurityNotice.mockResolvedValue([
      {
        success: true,
        staged: {
          id: "sec-bell-1",
          kind: "trigger" as const,
          workflowId: "account-security-notice",
          transactionId: "sec-tx-1",
          recipients: ["user-1"],
          payload: {},
          attempts: 0,
          status: "PENDING",
          notBefore: null,
        },
      },
    ]);
    mockNotifyModerationWarning.mockResolvedValue({
      success: true,
      staged: {
        id: "warn-bell-1",
        kind: "trigger" as const,
        workflowId: "moderation-warning",
        transactionId: "warn-tx-1",
        recipients: ["user-1"],
        payload: {},
        attempts: 0,
        status: "PENDING",
        notBefore: null,
      },
    });
    mockNotifyAccountSuspended.mockResolvedValue({
      success: true,
      staged: {
        id: "susp-bell-1",
        kind: "trigger" as const,
        workflowId: "account-suspended",
        transactionId: "susp-tx-1",
        recipients: ["user-1"],
        payload: {},
        attempts: 0,
        status: "PENDING",
        notBefore: null,
      },
    });
    mockNotifyAccountBanned.mockResolvedValue({
      success: true,
      staged: {
        id: "ban-bell-1",
        kind: "trigger" as const,
        workflowId: "account-banned",
        transactionId: "ban-tx-1",
        recipients: ["user-1"],
        payload: {},
        attempts: 0,
        status: "PENDING",
        notBefore: null,
      },
    });
    mockSendSecurityNoticeEmail.mockResolvedValue(undefined);
  });

  describe("1. Novu 16-Family Consolidation & Workflow Registry", () => {
    it("maintains exactly 16 workflow families within Novu's 20-workflow plan cap", () => {
      expect(FAMILIES).toHaveLength(16);
      const uniqueIds = new Set(FAMILIES.map((f) => f.id));
      expect(uniqueIds.size).toBe(16);

      const mandatoryIds = FAMILIES.filter((f) => f.category === null).map(
        (f) => f.id,
      );
      expect(mandatoryIds).toEqual(["account", "platform"]);
    });

    it("maps every single NOVU_WORKFLOWS constant onto a registered FamilyId", () => {
      const validFamilyIds = new Set(FAMILIES.map((f) => f.id));
      const allWorkflowIds = Object.values(NOVU_WORKFLOWS);
      expect(allWorkflowIds).toContain(NOVU_WORKFLOWS.RECORDING_REMOVED);
      expect(allWorkflowIds).toHaveLength(Object.keys(EVENT_FAMILY).length);

      for (const workflowId of allWorkflowIds) {
        expect(EVENT_FAMILY[workflowId]).toBeDefined();
        const family = familyOf(workflowId);
        expect(validFamilyIds.has(family)).toBe(true);
      }
    });
  });

  describe("2. Exhaustive React Email Template Rendering Across All Variants", () => {
    it("renders all 7 AccountRestrictedEmail kinds with non-empty HTML and subject", () => {
      const kinds: AccountRestrictedEmailKind[] = [
        "BANNED",
        "SUSPENDED",
        "REINSTATED",
        "MODERATION_WARNING",
        "WARNING",
        "CONTENT_REMOVED",
        "REVIEW_EXCLUDED",
      ];
      for (const kind of kinds) {
        const subject = accountRestrictedSubject(kind);
        expect(subject.length).toBeGreaterThan(10);
        const html = renderToStaticMarkup(
          React.createElement(AccountRestrictedEmail, {
            kind,
            recipientName: "Aarav",
            reason: "Policy check",
            suspendedUntilText: "18 Oct 2026, 6:00 PM IST",
            appointmentsCancelled: 2,
            supportEmail: "support@familiarisenow.com",
            supportUrl: "https://familiarisenow.com/support",
            dashboardUrl: "https://familiarisenow.com/dashboard",
          }),
        );
        expect(html).toContain(subject);
        expect(html).toContain("Aarav");
      }
    });

    it("renders all 7 ClassSessionEmail kinds cleanly", () => {
      const kinds: ClassSessionEmailKind[] = [
        "CANCELLED",
        "MAKEUP_SCHEDULED",
        "SESSION_REFUNDED",
        "EXIT_AVAILABLE",
        "NO_SHOW",
        "MISSED_RECORDING",
        "COMPLETED",
      ];
      for (const kind of kinds) {
        const subject = classSessionSubject({
          kind,
          planTitle: "System Design Cohort",
          voided: kind === "CANCELLED",
        });
        expect(subject).toContain("System Design Cohort");
        const html = renderToStaticMarkup(
          React.createElement(ClassSessionEmail, {
            kind,
            recipientName: "Meera",
            planTitle: "System Design Cohort",
            consultantName: "Dr. Rao",
            startsAtText: "Mon, 12 Oct, 7:00 PM IST",
            amountText: "INR 2,500",
            recordingUrl: "https://familiarisenow.com/recording",
            supportUrl: "https://familiarisenow.com/support",
            dashboardUrl: "https://familiarisenow.com/dashboard",
          }),
        );
        expect(html).toContain("System Design Cohort");
      }
    });

    it("renders all 5 DocumentAndRecordingEmail and 6 TrialAndSubscriptionEmail kinds", () => {
      const docKinds: DocumentAndRecordingEmailKind[] = [
        "DOCUMENT_UPLOADED",
        "DOCUMENT_REVIEWED",
        "RECORDING_READY",
        "RECORDING_FAILED",
        "RECORDING_REMOVED",
      ];
      for (const kind of docKinds) {
        const subject = documentAndRecordingSubject({
          kind,
          fileName: "resume-v2.pdf",
          appointmentType: "consultation",
        });
        const html = renderToStaticMarkup(
          React.createElement(DocumentAndRecordingEmail, {
            kind,
            recipientName: "Kabir",
            actorName: "Ananya",
            fileName: "resume-v2.pdf",
            appointmentType: "consultation",
            versionNo: 2,
            reviewStatus: "CHANGES_REQUESTED",
            reviewNotes: "Please update section 2",
            dashboardUrl: "https://familiarisenow.com/dashboard",
          }),
        );
        expect(html).toContain(subject);
      }

      const trialKinds: TrialAndSubscriptionEmailKind[] = [
        "TRIAL_COMPLETED",
        "TRIAL_CANCELLED",
        "SUBSCRIPTION_STARTED",
        "SUBSCRIPTION_RENEWED",
      ];
      for (const kind of trialKinds) {
        const subject = trialAndSubscriptionSubject({
          kind,
          planTitle: "Backend Mentorship",
          consulteeName: "Rohan",
        });
        const html = renderToStaticMarkup(
          React.createElement(TrialAndSubscriptionEmail, {
            kind,
            recipientName: "Diya",
            planTitle: "Backend Mentorship",
            consultantName: "Vikram",
            consulteeName: "Rohan",
            startsAtText: "Fri, 16 Oct, 6:00 PM IST",
            nextBatch: 4,
            remainingSessions: 8,
            dashboardUrl: "https://familiarisenow.com/dashboard",
          }),
        );
        expect(html).toContain(subject);
      }
    });

    it("renders all OrgContractAndSeatEmail, OrgDunningEmail, ReferralBonusEmail, and extended templates", () => {
      const seatKinds: OrgContractAndSeatEmailKind[] = [
        "SEAT_ASSIGNED",
        "SEAT_REVOKED",
        "CONTRACT_ACTIVATED",
        "CONTRACT_RENEWED",
        "CONTRACT_ENDED",
        "COMPLIANCE_ALERT",
      ];
      for (const kind of seatKinds) {
        const subject = orgContractAndSeatSubject({
          kind,
          orgName: "Acme Corp",
          programName: "Leadership Track",
          title: "DPDP Filing",
        });
        const html = renderToStaticMarkup(
          React.createElement(OrgContractAndSeatEmail, {
            kind,
            orgName: "Acme Corp",
            programName: "Leadership Track",
            title: "DPDP Filing",
            dueDateText: "20 Oct 2026",
            effectiveDateText: "15 Oct 2026",
            reason: "Annual renewal",
            dashboardUrl: "https://familiarisenow.com/dashboard/org",
          }),
        );
        expect(html).toContain(subject);
      }

      const dunningKinds: OrgOperationalEmailKind[] = [
        "MEMBER_OVERAGE_TIMED_OUT",
        "LICENSE_RENEWAL_UPCOMING",
        "PROGRAM_CAP_NEAR",
        "PROGRAM_EXHAUSTED",
        "DATA_EXPORT_READY",
      ];
      for (const kind of dunningKinds) {
        const subject = orgOperationalEmailSubject({
          kind,
          orgName: "Acme Corp",
          programName: "Leadership Track",
          daysUntilRenewal: 7,
        });
        const html = renderToStaticMarkup(
          React.createElement(OrgDunningEmail, {
            kind,
            orgName: "Acme Corp",
            programName: "Leadership Track",
            assigneeName: "Rohan",
            amountText: "INR 4,000",
            expectedTotalText: "INR 48,000",
            renewalDateText: "18 Oct 2026",
            expiresAtText: "25 Oct 2026",
            daysUntilRenewal: 7,
            cycle: "ANNUAL",
            engagementsUsed: 9,
            cap: 10,
            usedPct: 90,
            actionUrl: "https://familiarisenow.com/dashboard/org/billing",
          }),
        );
        expect(html).toContain(subject);
      }

      const stage4DunningHtml = renderToStaticMarkup(
        React.createElement(OrgDunningEmail, {
          kind: "INVOICE_OVERDUE",
          orgName: "Acme Corp",
          invoiceNumber: "INV-2026-0042",
          amountText: "INR 48,000",
          dueDateText: "01 Oct 2026",
          daysLate: 30,
          reminderStage: 4,
          actionUrl: "https://familiarisenow.com/dashboard/org/billing",
        }),
      );
      expect(stage4DunningHtml).toContain("Acme Corp");
      expect(stage4DunningHtml).toContain(
        "Sponsored bookings paused: Invoice INV-2026-0042 overdue",
      );
      expect(stage4DunningHtml).toContain(
        "sponsored bookings have been paused",
      );

      const referralKinds: ReferralBonusEmailKind[] = [
        "BONUS_EARNED",
        "WELCOME_BONUS",
        "CREDITS_APPLIED",
      ];
      for (const kind of referralKinds) {
        const subject = referralBonusSubject({
          kind,
          amountText: "INR 500",
        });
        const html = renderToStaticMarkup(
          React.createElement(ReferralBonusEmail, {
            kind,
            counterpartyName: "Aditi",
            amountText: "INR 500",
            remainingText: "INR 1,000",
            dashboardUrl: "https://familiarisenow.com/dashboard",
          }),
        );
        expect(html).toContain(subject);
      }

      const supportKinds: SupportTicketEmailKind[] = [
        "RESPONSE",
        "STATUS_UPDATED",
        "FEEDBACK_UPDATED",
      ];
      for (const kind of supportKinds) {
        const subject = supportTicketResponseSubject({
          kind,
          reference: "ST-2026-0099",
          statusLabel: "Resolved",
        });
        const html = renderToStaticMarkup(
          React.createElement(SupportTicketResponseEmail, {
            kind,
            recipientName: "Neha",
            reference: "ST-2026-0099",
            title: "Billing question",
            statusLabel: "Resolved",
            replyText: "Fixed your receipt.",
            nextStepText: "No further action needed.",
            ticketUrl: "https://familiarisenow.com/support",
          }),
        );
        expect(html).toContain(subject);
      }

      const verStatuses: VerificationDecidedStatus[] = [
        "VERIFIED",
        "REJECTED",
        "PENDING_VERIFICATION",
        "UNDER_REVIEW",
        "NEEDS_INFO_REMINDER",
      ];
      for (const status of verStatuses) {
        const subject = verificationDecidedSubject(status);
        const html = renderToStaticMarkup(
          React.createElement(VerificationDecidedEmail, {
            status,
            reason: "Please upload clear ID",
            daysLeft: 7,
            dashboardUrl: "https://familiarisenow.com/dashboard",
            supportEmail: "support@familiarisenow.com",
          }),
        );
        expect(html).toContain(subject);
      }

      const reschedOutcomes: RescheduleEmailOutcome[] = [
        "PROPOSED",
        "MOVED",
        "DECLINED",
        "WITHDRAWN",
        "EXPIRED",
        "RELEASED",
      ];
      for (const outcome of reschedOutcomes) {
        const html = renderToStaticMarkup(
          React.createElement(AppointmentRescheduledEmail, {
            outcome,
            recipientName: "Kiran",
            appointmentType: "1-on-1 Consultation",
            oldStartsAtText: "Tue, 13 Oct, 5:00 PM IST",
            newStartsAtText: "Wed, 14 Oct, 5:00 PM IST",
            dashboardUrl: "https://familiarisenow.com/dashboard",
          }),
        );
        expect(html).toContain("Kiran");
      }

      const memberKinds: OrgMembershipChangeKind[] = [
        "ROLE_CHANGED",
        "REMOVED",
        "MEMBER_JOINED",
      ];
      for (const kind of memberKinds) {
        const subject = orgMembershipChangedSubject({
          kind,
          orgName: "Acme Corp",
          actorName: "Priya",
        });
        const html = renderToStaticMarkup(
          React.createElement(OrgMembershipChangedEmail, {
            kind,
            orgName: "Acme Corp",
            roleBefore: "MEMBER",
            roleAfter: "ADMIN",
            memberEmail: "member@acme.example",
            actorName: "Priya",
            dashboardUrl: "https://familiarisenow.com/dashboard/org",
            supportEmail: "support@familiarisenow.com",
          }),
        );
        expect(html).toContain(subject);
      }

      const platformComplianceHtml = renderToStaticMarkup(
        React.createElement(OrgContractAndSeatEmail, {
          kind: "COMPLIANCE_ALERT",
          title: "Statutory TDS Return",
          dueDateText: "31 Oct 2026",
          dashboardUrl: "https://familiarisenow.com/dashboard/staff/compliance",
        }),
      );
      expect(platformComplianceHtml).not.toContain("for your organisation");
      expect(platformComplianceHtml).toContain(
        "<strong>Statutory TDS Return</strong> is due",
      );

      const rejectedSsoSubject = ssoProviderSubject("REJECTED", "Acme Corp");
      const revokedSsoSubject = ssoProviderSubject("REVOKED", "Acme Corp");
      expect(rejectedSsoSubject).toContain("was not approved");
      expect(revokedSsoSubject).toContain("was revoked");

      const ssoKinds: SsoProviderEmailKind[] = [
        "SUBMITTED",
        "APPROVED",
        "REJECTED",
        "REVOKED",
        "DELETED",
      ];
      for (const kind of ssoKinds) {
        const subject = ssoProviderSubject(kind, "Acme Corp");
        const html = renderToStaticMarkup(
          React.createElement(SsoProviderEmail, {
            kind,
            recipientName: "Owner",
            orgName: "Acme Corp",
            providerId: "oidc-acme",
            domains: ["acme.example"],
            issuer: "https://idp.acme.example",
            deletedByName: "Admin",
            reason: "Policy compliance",
            actionUrl: "https://familiarisenow.com/dashboard/org/security",
          }),
        );
        expect(html).toContain(subject);
      }
    });
  });

  describe("3. Dual-Channel Transactional & Post-Commit Staging Parity", () => {
    it("stages moderation content removal & report outcome across BOTH bell and email inside tx", async () => {
      const mockTx = {
        user: {
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue(null),
        },
        session: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        consultantReview: {
          findUnique: jest.fn().mockResolvedValue(null),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        supportTicket: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        moderationAction: {
          count: jest.fn().mockResolvedValue(1),
        },
        consultantProfile: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      };

      const txSummary = await applyTransactionalEffects(mockTx as never, {
        actionId: "act-1",
        actionType: "CONTENT_REMOVED",
        report: {
          id: "rep-1",
          type: "REVIEW",
          reason: "SPAM_PROMOTION",
          reportedById: "reporter-1",
          targetUserId: "target-1",
          reviewId: null,
        },
        staffUserId: "staff-1",
        notes: "Spam content",
      });

      expect(txSummary.stagedBells?.length).toBeGreaterThanOrEqual(2);
      expect(mockStageBell).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          workflowId: "content-removed-notice",
          payload: expect.objectContaining({ supportUrl: "/support" }),
        }),
      );
      expect(mockStageAccountModerationEmail).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          userId: "target-1",
          kind: "CONTENT_REMOVED",
        }),
        undefined,
      );
      expect(mockStageModerationReportOutcomeEmail).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          reporterUserId: "reporter-1",
          reportId: "rep-1",
        }),
        undefined,
      );

      const bestEffort = await applyBestEffortEffects(
        {
          actionId: "act-2",
          actionType: "USER_BANNED",
          report: {
            id: "rep-1",
            type: "PROFILE",
            reason: "HARASSMENT_ABUSE",
            reportedById: "reporter-1",
            targetUserId: "target-1",
            reviewId: null,
          },
          staffUserId: "staff-1",
          notes: "Severe violation",
        },
        {
          reviewRemoved: false,
          stagedBells: [],
          stagedEmails: [],
        },
      );

      expect(mockNotifyAccountBanned).toHaveBeenCalledWith(
        "target-1",
        expect.objectContaining({
          reason: expect.stringContaining("Harassment Abuse"),
        }),
        "moderation-action:act-2",
        { deferAttempt: true },
      );
      expect(mockStageAccountModerationEmail).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: "target-1",
          kind: "BANNED",
        }),
      );
      expect(bestEffort.stagedBells).toHaveLength(1);
      expect(bestEffort.stagedEmails).toHaveLength(1);

      const unverifiedTxSummary = await applyTransactionalEffects(
        mockTx as never,
        {
          actionId: "act-3",
          actionType: "PROFILE_UNVERIFIED",
          report: {
            id: "rep-2",
            type: "PROFILE",
            reason: "IMPERSONATION",
            reportedById: "reporter-1",
            targetUserId: "target-1",
            reviewId: null,
          },
          staffUserId: "staff-1",
          notes: "Credentials unverified",
        },
      );
      const unverifiedBestEffort = await applyBestEffortEffects(
        {
          actionId: "act-3",
          actionType: "PROFILE_UNVERIFIED",
          report: {
            id: "rep-2",
            type: "PROFILE",
            reason: "IMPERSONATION",
            reportedById: "reporter-1",
            targetUserId: "target-1",
            reviewId: null,
          },
          staffUserId: "staff-1",
          notes: "Credentials unverified",
        },
        unverifiedTxSummary,
      );
      expect(unverifiedBestEffort.stagedEmails).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            emailType: "VERIFICATION_DECIDED",
            rows: [
              {
                row: { id: "fe-verif-1" },
                message: {
                  to: "u@example.com",
                  subject: "s",
                  html: "<p>h</p>",
                },
              },
            ],
          }),
        ]),
      );
    });

    it("pairs every security event email with a Novu ACCOUNT_SECURITY_NOTICE bell flush", async () => {
      await sendSecurityEventEmail(
        { id: "user-sec-1", email: "op@familiarisenow.com", name: "Operator" },
        { kind: "authenticator-added" },
      );
      await sendSecurityEventEmail(
        { id: "user-sec-1", email: "op@familiarisenow.com", name: "Operator" },
        { kind: "passkey-removed" },
      );
      await sendSecurityEventEmail(
        { id: "user-sec-1", email: "op@familiarisenow.com", name: "Operator" },
        { kind: "backup-code-used", remaining: 3 },
      );
      await sendSecurityEventEmail(
        { id: "user-sec-1", email: "op@familiarisenow.com", name: "Operator" },
        {
          kind: "two-factor-locked",
          lockedUntil: new Date("2026-10-13T12:00:00Z"),
        },
      );
      await sendSecurityEventEmail(
        { id: "user-sec-1", email: "op@familiarisenow.com", name: "Operator" },
        { kind: "backup-codes-regenerated" },
      );

      expect(mockSendSecurityNoticeEmail).toHaveBeenCalledTimes(5);
      expect(mockNotifyAccountSecurityNotice).toHaveBeenCalledWith(
        "user-sec-1",
        expect.objectContaining({ kind: "TWO_FACTOR_ENABLED" }),
        expect.stringContaining(
          "security-event:authenticator-added:user-sec-1:",
        ),
        { deferAttempt: true },
      );
      expect(mockNotifyAccountSecurityNotice).toHaveBeenCalledWith(
        "user-sec-1",
        expect.objectContaining({ kind: "PASSKEY_REMOVED" }),
        expect.stringContaining("security-event:passkey-removed:user-sec-1:"),
        { deferAttempt: true },
      );
      for (const updateKind of [
        "backup-code-used",
        "two-factor-locked",
        "backup-codes-regenerated",
      ] as const) {
        expect(mockNotifyAccountSecurityNotice).toHaveBeenCalledWith(
          "user-sec-1",
          expect.objectContaining({
            kind: "SECURITY_UPDATE",
            message: expect.stringMatching(/\S+/),
          }),
          expect.stringContaining(`security-event:${updateKind}:user-sec-1:`),
          { deferAttempt: true },
        );
      }
      expect(mockFlushNotificationsAfter).toHaveBeenCalledWith(
        expect.objectContaining({
          bells: [expect.objectContaining({ id: "sec-bell-1" })],
        }),
        "auth:security-event:authenticator-added",
      );
    });

    it("uses supplied tx in recordFlowOutcome and propagates transaction write failures", async () => {
      const nonTxId = await recordFlowOutcome({
        scope: "PLATFORM",
        flowKey: "billing-help",
        outcome: "RESOLVED",
        userId: "user-1",
      });
      expect(nonTxId).toBe("outcome-1");

      const txError = new Error("serialization conflict");
      const failingTx = {
        supportFlowOutcome: {
          create: jest.fn().mockRejectedValue(txError),
        },
      };

      await expect(
        recordFlowOutcome(
          {
            scope: "PLATFORM",
            flowKey: "billing-help",
            outcome: "RESOLVED",
            userId: "user-1",
          },
          failingTx as never,
        ),
      ).rejects.toThrow("serialization conflict");
    });
  });
});

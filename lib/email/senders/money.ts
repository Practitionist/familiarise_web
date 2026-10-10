/**
 * Money emails: refund processed and failed for the payer, and org billing
 * notices (invoice overdue, wallet low, payout failed or reversed, member
 * overage due) for the org's visibility roster.
 */

import type { ReactElement } from "react";
import { OrgInvoiceOverdueEmail } from "@/emails/orgs/OrgInvoiceOverdueEmail";
import { OrgOverageDueEmail } from "@/emails/orgs/OrgOverageDueEmail";
import { OrgPayoutFailedEmail } from "@/emails/orgs/OrgPayoutFailedEmail";
import { OrgWalletLowEmail } from "@/emails/orgs/OrgWalletLowEmail";
import { RefundFailedEmail } from "@/emails/payments/RefundFailedEmail";
import { RefundProcessedEmail } from "@/emails/payments/RefundProcessedEmail";
import { getAppUrl } from "@/lib/url";
import { goHref } from "@/lib/dashboard/go";
import { EMAIL_BUDGET_MS, SENDERS, supportEmail } from "../config";
import type { EmailRecipient } from "../preferences";
import type {
  SendToRecipientsResult,
  StagedRecipientEmail,
} from "../send-to-recipients";
import {
  dateText,
  defineBudgetedEmailSender,
  defineFixedBudgetEmailSender,
  greet,
  money,
  stageSpecGuarded,
  type Paise,
  type RecipientEmailSpec,
  type StagingTx,
} from "./shared";

export const MONEY_EMAIL_TYPES = {
  REFUND_PROCESSED: "REFUND_PROCESSED",
  REFUND_FAILED: "REFUND_FAILED",
  ORG_INVOICE_OVERDUE: "ORG_INVOICE_OVERDUE",
  ORG_WALLET_LOW: "ORG_WALLET_LOW",
  ORG_PAYOUT_FAILED: "ORG_PAYOUT_FAILED",
  ORG_PROGRAM_OVERAGE_DUE: "ORG_PROGRAM_OVERAGE_DUE",
} as const;

const NOTHING_SENT: SendToRecipientsResult = { sent: 0, skipped: 0, failed: 0 };

// ── Refund processed ────────────────────────────────────────────────────────

export interface RefundProcessedEmailArgs {
  userId: string;
  paymentId: string;
  amountPaise: Paise;
  currency: string;
  planTitle?: string;
  creditNoteNumber?: string;
}

function refundProcessedSpec(
  args: RefundProcessedEmailArgs,
): RecipientEmailSpec {
  const amountText = money(args.amountPaise, args.currency);
  const appUrl = getAppUrl();
  return {
    emailType: MONEY_EMAIL_TYPES.REFUND_PROCESSED,
    category: "payments",
    from: SENDERS.payments,
    entityRef: `payment:${args.paymentId}`,
    subject: () => `Your refund of ${amountText} is on its way`,
    render: (r: EmailRecipient): ReactElement =>
      RefundProcessedEmail({
        recipientName: greet(r),
        amountText,
        planTitle: args.planTitle,
        creditNoteNumber: args.creditNoteNumber,
        refundPolicyUrl: `${appUrl}/refund`,
        dashboardUrl: `${appUrl}${goHref("client", "payments")}`,
        unsubscribeUrl: r.unsubscribeUrl,
      }),
  };
}

export const sendRefundProcessedEmail =
  defineBudgetedEmailSender<RefundProcessedEmailArgs>(
    (args) => ({
      userIds: [args.userId],
      spec: refundProcessedSpec(args),
    }),
    NOTHING_SENT,
  );

export async function stageRefundProcessedEmail(
  tx: StagingTx,
  args: RefundProcessedEmailArgs,
): Promise<StagedRecipientEmail[]> {
  return stageSpecGuarded(refundProcessedSpec(args), [args.userId], tx);
}

// ── Refund failed ───────────────────────────────────────────────────────────

export interface RefundFailedEmailArgs {
  userId: string;
  paymentId: string;
  amountPaise: Paise;
  currency: string;
}

export const sendRefundFailedEmail =
  defineFixedBudgetEmailSender<RefundFailedEmailArgs>(
    EMAIL_BUDGET_MS.JOB,
    (args) => {
      const amountText = money(args.amountPaise, args.currency);
      const support = supportEmail();
      return {
        userIds: [args.userId],
        spec: {
          emailType: MONEY_EMAIL_TYPES.REFUND_FAILED,
          category: "payments",
          from: SENDERS.payments,
          entityRef: `payment:${args.paymentId}`,
          subject: () => "We couldn't complete your refund",
          render: (r) =>
            RefundFailedEmail({
              recipientName: greet(r),
              amountText,
              supportEmail: support,
              unsubscribeUrl: r.unsubscribeUrl,
            }),
        },
      };
    },
    NOTHING_SENT,
  );

// ── Org payout failed or reversed ───────────────────────────────────────────

export interface OrgPayoutFailedEmailArgs {
  recipientUserIds: string[];
  kind: "FAILED" | "REVERSED";
  orgName: string;
  payoutId: string;
  amountPaise: Paise;
  currency: string;
  reason: string;
  dashboardUrl: string;
  withheldText?: string;
}

export const sendOrgPayoutFailedEmail =
  defineFixedBudgetEmailSender<OrgPayoutFailedEmailArgs>(
    EMAIL_BUDGET_MS.WEBHOOK,
    (args) => {
      const amountText = money(args.amountPaise, args.currency);
      const subject =
        args.kind === "REVERSED"
          ? `A payout to ${args.orgName} was reversed`
          : `A payout to ${args.orgName} failed`;
      return {
        userIds: args.recipientUserIds,
        spec: {
          emailType: MONEY_EMAIL_TYPES.ORG_PAYOUT_FAILED,
          category: "orgBilling",
          from: SENDERS.finance,
          entityRef: `orgPayout:${args.payoutId}`,
          subject: () => subject,
          render: (r) =>
            OrgPayoutFailedEmail({
              kind: args.kind,
              orgName: args.orgName,
              amountText,
              reason: args.reason,
              dashboardUrl: args.dashboardUrl,
              unsubscribeUrl: r.unsubscribeUrl,
              withheldText: args.withheldText,
            }),
        },
      };
    },
    NOTHING_SENT,
  );

// ── Org invoice overdue ─────────────────────────────────────────────────────

export interface OrgInvoiceOverdueEmailArgs {
  recipientUserIds: string[];
  invoiceId: string;
  invoiceNumber: string;
  orgName: string;
  totalPaise: Paise;
  currency: string;
  dueDate: Date;
  daysLate: number;
  reminderStage: number;
  payUrl: string;
}

export const sendOrgInvoiceOverdueEmail =
  defineFixedBudgetEmailSender<OrgInvoiceOverdueEmailArgs>(
    EMAIL_BUDGET_MS.JOB,
    (args) => {
      const amountText = money(args.totalPaise, args.currency);
      const dayWord = args.daysLate === 1 ? "day" : "days";
      return {
        userIds: args.recipientUserIds,
        spec: {
          emailType: MONEY_EMAIL_TYPES.ORG_INVOICE_OVERDUE,
          category: "orgBilling",
          from: SENDERS.finance,
          entityRef: `orgInvoice:${args.invoiceId}`,
          subject: () =>
            `Invoice ${args.invoiceNumber} is ${args.daysLate} ${dayWord} overdue`,
          render: (r) =>
            OrgInvoiceOverdueEmail({
              orgName: args.orgName,
              invoiceNumber: args.invoiceNumber,
              amountText,
              dueDateText: dateText(args.dueDate, r.zone),
              daysLate: args.daysLate,
              reminderStage: args.reminderStage,
              payUrl: args.payUrl,
              unsubscribeUrl: r.unsubscribeUrl,
            }),
        },
      };
    },
    NOTHING_SENT,
  );

// ── Org wallet low ──────────────────────────────────────────────────────────

export interface OrgWalletLowEmailArgs {
  recipientUserIds: string[];
  organizationId: string;
  orgName: string;
  balancePaise: Paise;
  minimumPaise: Paise;
  currency: string;
  topUpUrl: string;
}

export const sendOrgWalletLowEmail =
  defineFixedBudgetEmailSender<OrgWalletLowEmailArgs>(
    EMAIL_BUDGET_MS.JOB,
    (args) => {
      const balanceText = money(args.balancePaise, args.currency);
      const floorText = money(args.minimumPaise, args.currency);
      return {
        userIds: args.recipientUserIds,
        spec: {
          emailType: MONEY_EMAIL_TYPES.ORG_WALLET_LOW,
          category: "orgBilling",
          from: SENDERS.finance,
          entityRef: `org:${args.organizationId}`,
          subject: () => `${args.orgName}'s wallet is running low`,
          render: (r) =>
            OrgWalletLowEmail({
              orgName: args.orgName,
              balanceText,
              floorText,
              topUpUrl: args.topUpUrl,
              unsubscribeUrl: r.unsubscribeUrl,
            }),
        },
      };
    },
    NOTHING_SENT,
  );

// ── Org member overage due ──────────────────────────────────────────────────

export interface OrgOverageDueEmailArgs {
  userId: string;
  overageEventId: string;
  orgName: string;
  programTitle: string;
  amountPaise: Paise;
  currency: string;
  dueBy?: Date;
  payUrl: string;
}

export const sendOrgOverageDueEmail =
  defineFixedBudgetEmailSender<OrgOverageDueEmailArgs>(
    EMAIL_BUDGET_MS.REQUEST,
    (args) => {
      const amountText = money(args.amountPaise, args.currency);
      return {
        userIds: [args.userId],
        spec: {
          emailType: MONEY_EMAIL_TYPES.ORG_PROGRAM_OVERAGE_DUE,
          category: "orgBilling",
          from: SENDERS.finance,
          entityRef: `overage:${args.overageEventId}`,
          subject: () => "Payment due for your recent booking",
          render: (r) =>
            OrgOverageDueEmail({
              recipientName: greet(r),
              orgName: args.orgName,
              programTitle: args.programTitle,
              amountText,
              dueByText: args.dueBy
                ? dateText(args.dueBy, r.zone)
                : undefined,
              payUrl: args.payUrl,
              unsubscribeUrl: r.unsubscribeUrl,
            }),
        },
      };
    },
    NOTHING_SENT,
  );

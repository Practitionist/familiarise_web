/**
 * Money emails: refund processed and failed for the payer, the digital product
 * purchase receipt, and org billing
 * notices (invoice overdue, wallet low, payout failed or reversed, member
 * overage due) for the org's visibility roster.
 */

import type { ReactElement } from "react";
import { payoutNoticeReason } from "@/lib/dashboard/earnings-state";
import {
  OrgBillingReceiptEmail,
  type OrgBillingReceiptKind,
} from "@/emails/orgs/OrgBillingReceiptEmail";
import {
  OrgInvoiceOverdueEmail,
  orgInvoiceOverdueSubject,
} from "@/emails/orgs/OrgInvoiceOverdueEmail";
import { OrgOverageDueEmail } from "@/emails/orgs/OrgOverageDueEmail";
import { OrgPayoutFailedEmail } from "@/emails/orgs/OrgPayoutFailedEmail";
import { OrgWalletLowEmail } from "@/emails/orgs/OrgWalletLowEmail";
import {
  DigitalProductPurchaseEmail,
  digitalProductPurchaseSubject,
} from "@/emails/payments/DigitalProductPurchaseEmail";
import {
  DisputeNoticeEmail,
  type DisputeNoticeKind,
} from "@/emails/payments/DisputeNoticeEmail";
import OrgDunningEmail, {
  orgOperationalEmailSubject,
  type OrgOperationalEmailKind,
} from "@/emails/payments/OrgDunningEmail";
import {
  PayoutStatusEmail,
  type PayoutStatusKind,
} from "@/emails/payments/PayoutStatusEmail";
import {
  CLAWBACK_NOTICE_SUBJECT,
  ClawbackNoticeEmail,
} from "@/emails/payments/ClawbackNoticeEmail";
import ReferralBonusEmail, {
  referralBonusSubject,
  type ReferralBonusEmailKind,
} from "@/emails/payments/ReferralBonusEmail";
import { RefundFailedEmail } from "@/emails/payments/RefundFailedEmail";
import { RefundProcessedEmail } from "@/emails/payments/RefundProcessedEmail";
import type { Tx } from "@/lib/prisma";
import { getAppUrl } from "@/lib/url";
import { goHref } from "@/lib/dashboard/go";
import { formatInvoiceDateWithZone } from "@/lib/time/invoice-date";
import { EMAIL_BUDGET_MS, SENDERS, supportEmail } from "../config";
import type { EmailRecipient } from "../preferences";
import type {
  SendToRecipientsResult,
  StagedRecipientEmail,
} from "../send-to-recipients";
import {
  absolute,
  claimAndStagePrepared,
  dateText,
  defineBudgetedEmailSender,
  defineFixedBudgetEmailSender,
  defineLifecyclePreparer,
  defineLifecycleStager,
  greet,
  money,
  prepareBuiltSpec,
  prepareSpecEmails,
  stageBuiltSpec,
  type Paise,
  type PreparedRecipientEmails,
  type PreparedSpecEmails,
  type RecipientEmailSpec,
  type StagingTx,
} from "./shared";

export {
  type DisputeNoticeKind,
  type OrgBillingReceiptKind,
  type PayoutStatusKind,
};

export const MONEY_EMAIL_TYPES = {
  REFUND_PROCESSED: "REFUND_PROCESSED",
  REFUND_FAILED: "REFUND_FAILED",
  PAYOUT_STATUS: "PAYOUT_STATUS",
  PAYOUT_CLAWBACK: "PAYOUT_CLAWBACK",
  DISPUTE_NOTICE: "DISPUTE_NOTICE",
  ORG_BILLING_RECEIPT: "ORG_BILLING_RECEIPT",
  ORG_INVOICE_OVERDUE: "ORG_INVOICE_OVERDUE",
  ORG_WALLET_LOW: "ORG_WALLET_LOW",
  ORG_PAYOUT_FAILED: "ORG_PAYOUT_FAILED",
  ORG_PROGRAM_OVERAGE_DUE: "ORG_PROGRAM_OVERAGE_DUE",
  DIGITAL_PRODUCT_PURCHASED: "DIGITAL_PRODUCT_PURCHASED",
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
  /** The other party's cancel caused this refund, so the notice is required. */
  required?: boolean;
}

function refundProcessedSpec(
  args: RefundProcessedEmailArgs,
): RecipientEmailSpec {
  const amountText = money(args.amountPaise, args.currency);
  const appUrl = getAppUrl();
  return {
    emailType: MONEY_EMAIL_TYPES.REFUND_PROCESSED,
    category: "payments",
    ...(args.required ? { requiredFor: [args.userId] } : {}),
    from: SENDERS.payments,
    entityRef: `payment:${args.paymentId}`,
    traceRenderFailure: true,
    subject: () => `Your refund of ${amountText} is on its way`,
    render: (r: EmailRecipient): ReactElement =>
      RefundProcessedEmail({
        recipientName: greet(r),
        amountText,
        planTitle: args.planTitle,
        creditNoteNumber: args.creditNoteNumber,
        refundPolicyUrl: absolute(`${appUrl}/refund`),
        dashboardUrl: absolute(goHref("client", "payments")),
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

function buildRefundProcessedEmail(args: RefundProcessedEmailArgs) {
  return { userIds: [args.userId], spec: refundProcessedSpec(args) };
}

/** Renders the refund receipt before the settling transaction opens. */
export function prepareRefundProcessedEmail(
  args: RefundProcessedEmailArgs,
): Promise<PreparedSpecEmails> {
  return prepareBuiltSpec(buildRefundProcessedEmail, args);
}

export function stageRefundProcessedEmail(
  tx: StagingTx,
  args: RefundProcessedEmailArgs,
  pre?: PreparedSpecEmails | null,
): Promise<StagedRecipientEmail[]> {
  return stageBuiltSpec(tx, buildRefundProcessedEmail, args, pre);
}

// ── Digital product purchased ───────────────────────────────────────────────

export interface DigitalProductPurchaseEmailArgs {
  purchaseId: string;
  buyerId: string;
  productTitle: string;
  creatorName: string | null;
  amountPaise: Paise;
  /** The buyer's library (or the product page); never a file URL. */
  libraryHref: string;
}

/** A claim's ttl outlives every retry of the capture that could stage it again. */
const PURCHASE_EMAIL_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A rendered receipt, ready to stage inside the settling or claiming transaction. */
export interface PreparedDigitalProductPurchaseEmail {
  purchaseId: string;
  buyerId: string;
  prepared: PreparedRecipientEmails;
}

/** Renders the receipt outside any transaction. */
export async function prepareDigitalProductPurchaseEmail(
  args: DigitalProductPurchaseEmailArgs,
): Promise<PreparedDigitalProductPurchaseEmail> {
  const free = Number(args.amountPaise) === 0;
  const amountText = free ? null : money(args.amountPaise, "INR");
  const libraryUrl = absolute(args.libraryHref);
  const spec: RecipientEmailSpec = {
    emailType: MONEY_EMAIL_TYPES.DIGITAL_PRODUCT_PURCHASED,
    // A purchase receipt is transactional, like PAYMENT_SUCCESS: no preference skips it.
    category: null,
    from: SENDERS.payments,
    entityRef: `digital-product-purchase:${args.purchaseId}`,
    subject: () => digitalProductPurchaseSubject(args.productTitle, free),
    render: (r: EmailRecipient): ReactElement =>
      DigitalProductPurchaseEmail({
        recipientName: greet(r),
        productTitle: args.productTitle,
        creatorName: args.creatorName,
        amountText,
        libraryUrl,
        unsubscribeUrl: r.unsubscribeUrl,
      }),
  };
  return {
    purchaseId: args.purchaseId,
    buyerId: args.buyerId,
    prepared: await prepareSpecEmails(spec, [args.buyerId]),
  };
}

export type ReceiptStagingTx = Pick<
  Tx,
  "idempotencyRecord" | "failedEmail" | "emailSuppression"
>;

/** Stages the receipt inside `tx` at most once per purchase; the caller attempts it after commit. */
export function stageDigitalProductPurchaseEmail(
  tx: ReceiptStagingTx,
  receipt: PreparedDigitalProductPurchaseEmail,
): Promise<StagedRecipientEmail[]> {
  return claimAndStagePrepared(
    tx,
    {
      scope: "digital-product.purchased",
      key: (userId) => `${receipt.purchaseId}:${userId}`,
      ttlMs: PURCHASE_EMAIL_CLAIM_TTL_MS,
    },
    [{ userId: receipt.buyerId, prepared: receipt.prepared }],
  );
}

// ── Refund failed ───────────────────────────────────────────────────────────

export interface RefundFailedEmailArgs {
  userId: string;
  paymentId: string;
  amountPaise: Paise;
  currency: string;
}

function refundFailedSpec(args: RefundFailedEmailArgs): RecipientEmailSpec {
  const amountText = money(args.amountPaise, args.currency);
  const support = supportEmail();
  return {
    emailType: MONEY_EMAIL_TYPES.REFUND_FAILED,
    category: "payments",
    from: SENDERS.payments,
    entityRef: `payment:${args.paymentId}`,
    traceRenderFailure: true,
    subject: () => "We couldn't complete your refund",
    render: (r) =>
      RefundFailedEmail({
        recipientName: greet(r),
        amountText,
        supportEmail: support,
        unsubscribeUrl: r.unsubscribeUrl,
      }),
  };
}

export const sendRefundFailedEmail =
  defineFixedBudgetEmailSender<RefundFailedEmailArgs>(
    EMAIL_BUDGET_MS.JOB,
    (args) => ({ userIds: [args.userId], spec: refundFailedSpec(args) }),
    NOTHING_SENT,
  );

function buildRefundFailedEmail(args: RefundFailedEmailArgs) {
  return { userIds: [args.userId], spec: refundFailedSpec(args) };
}

/** Renders the refund-failed notice before the claiming transaction opens. */
export function prepareRefundFailedEmail(
  args: RefundFailedEmailArgs,
): Promise<PreparedSpecEmails> {
  return prepareBuiltSpec(buildRefundFailedEmail, args);
}

export function stageRefundFailedEmail(
  tx: StagingTx,
  args: RefundFailedEmailArgs,
  pre?: PreparedSpecEmails | null,
): Promise<StagedRecipientEmail[]> {
  return stageBuiltSpec(tx, buildRefundFailedEmail, args, pre);
}

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
          traceRenderFailure: true,
          subject: () => subject,
          render: (r) =>
            OrgPayoutFailedEmail({
              kind: args.kind,
              orgName: args.orgName,
              amountText,
              reason: sentenceCase(payoutNoticeReason(args.kind, args.reason)),
              dashboardUrl: absolute(args.dashboardUrl),
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

function orgInvoiceOverdueSpec(
  args: OrgInvoiceOverdueEmailArgs,
): RecipientEmailSpec {
  const amountText = money(args.totalPaise, args.currency);
  return {
    emailType: MONEY_EMAIL_TYPES.ORG_INVOICE_OVERDUE,
    category: "orgBilling",
    from: SENDERS.finance,
    entityRef: `orgInvoice:${args.invoiceId}`,
    traceRenderFailure: true,
    subject: () =>
      orgInvoiceOverdueSubject({
        invoiceNumber: args.invoiceNumber,
        daysLate: args.daysLate,
        reminderStage: args.reminderStage,
      }),
    render: (r) =>
      OrgInvoiceOverdueEmail({
        orgName: args.orgName,
        invoiceNumber: args.invoiceNumber,
        amountText,
        dueDateText: formatInvoiceDateWithZone(args.dueDate),
        daysLate: args.daysLate,
        reminderStage: args.reminderStage,
        payUrl: absolute(args.payUrl),
        unsubscribeUrl: r.unsubscribeUrl,
      }),
  };
}

function buildOrgInvoiceOverdueEmail(args: OrgInvoiceOverdueEmailArgs) {
  return { userIds: args.recipientUserIds, spec: orgInvoiceOverdueSpec(args) };
}

/** Renders the overdue email before the dunning claim opens. */
export function prepareOrgInvoiceOverdueEmail(
  args: OrgInvoiceOverdueEmailArgs,
): Promise<PreparedSpecEmails> {
  return prepareBuiltSpec(buildOrgInvoiceOverdueEmail, args);
}

/** Stages the overdue email in the dunning claim's `tx`; a render failure leaves its trace row. */
export function stageOrgInvoiceOverdueEmail(
  tx: StagingTx,
  args: OrgInvoiceOverdueEmailArgs,
  pre?: PreparedSpecEmails | null,
): Promise<StagedRecipientEmail[]> {
  return stageBuiltSpec(tx, buildOrgInvoiceOverdueEmail, args, pre);
}

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
              topUpUrl: absolute(args.topUpUrl),
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
              dueByText: args.dueBy ? dateText(args.dueBy, r.zone) : undefined,
              payUrl: absolute(args.payUrl),
              unsubscribeUrl: r.unsubscribeUrl,
            }),
        },
      };
    },
    NOTHING_SENT,
  );

// ── Payout status (B2C consultant & Org) ────────────────────────────────────

function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface PayoutStatusEmailArgs {
  userId?: string;
  recipientUserIds?: string[];
  payoutId: string;
  status: PayoutStatusKind;
  amountPaise: Paise;
  currency: string;
  orgName?: string | null;
  method?: string | null;
  reason?: string | null;
  withheldText?: string | null;
  dashboardUrl?: string;
}

function payoutStatusSubject(
  status: PayoutStatusKind,
  amountText: string,
  target: string,
): string {
  switch (status) {
    case "COMPLETED":
      return `Your payout of ${amountText}${target} is complete`;
    case "REVERSED":
      return `Your payout${target} was reversed`;
    case "FAILED":
      return `Your payout${target} could not be completed`;
  }
}

function buildPayoutStatusEmail(args: PayoutStatusEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  const userIds = args.recipientUserIds ?? (args.userId ? [args.userId] : []);
  const amountText = money(args.amountPaise, args.currency);
  const target = args.orgName ? ` to ${args.orgName}` : "";
  const subject = payoutStatusSubject(args.status, amountText, target);
  const resolvedDashboardUrl = absolute(
    args.dashboardUrl ?? goHref("expert", "earnings"),
  );

  return {
    userIds,
    spec: {
      emailType: MONEY_EMAIL_TYPES.PAYOUT_STATUS,
      category: args.orgName ? "orgBilling" : "payments",
      from: SENDERS.finance,
      entityRef: args.orgName
        ? `orgPayout:${args.payoutId}`
        : `payout:${args.payoutId}`,
      traceRenderFailure: true,
      subject: () => subject,
      render: (r: EmailRecipient): ReactElement =>
        PayoutStatusEmail({
          status: args.status,
          recipientName: greet(r),
          orgName: args.orgName,
          amountText,
          payoutId: args.payoutId,
          method: args.method,
          reason:
            args.status === "COMPLETED"
              ? null
              : sentenceCase(payoutNoticeReason(args.status, args.reason)),
          withheldText: args.withheldText,
          dashboardUrl: resolvedDashboardUrl,
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
  };
}

export const stagePayoutStatusEmail =
  defineLifecycleStager<PayoutStatusEmailArgs>(buildPayoutStatusEmail);

// ── Payout clawback raised ──────────────────────────────────────────────────

export interface ClawbackNoticeEmailArgs {
  recipientUserIds: string[];
  organization: boolean;
  payoutId: string;
  journalId: string;
  amountPaise: Paise;
  dashboardUrl: string;
}

function buildClawbackNoticeEmail(args: ClawbackNoticeEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  const amountText = money(args.amountPaise, "INR");
  const dashboardUrl = absolute(args.dashboardUrl);
  return {
    userIds: args.recipientUserIds,
    spec: {
      emailType: MONEY_EMAIL_TYPES.PAYOUT_CLAWBACK,
      category: args.organization ? "orgBilling" : "payments",
      from: SENDERS.finance,
      entityRef: `clawback:${args.journalId}`,
      traceRenderFailure: true,
      subject: () => CLAWBACK_NOTICE_SUBJECT,
      render: (r: EmailRecipient): ReactElement =>
        ClawbackNoticeEmail({
          recipientName: greet(r),
          organization: args.organization,
          amountText,
          payoutId: args.payoutId,
          dashboardUrl,
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
  };
}

/** Renders inside the clawback's transaction, which computes the amount; a render failure leaves a trace row. */
export const stageClawbackNoticeEmail =
  defineLifecycleStager<ClawbackNoticeEmailArgs>(buildClawbackNoticeEmail);

// ── Dispute notice ──────────────────────────────────────────────────────────

export interface DisputeNoticeEmailArgs {
  userId?: string;
  recipientUserIds?: string[];
  disputeId: string;
  paymentId?: string | null;
  kind: DisputeNoticeKind;
  amountPaise: Paise;
  currency: string;
  reason?: string | null;
  outcome?: "WON" | "LOST" | string | null;
  respondBy?: Date | null;
  dashboardUrl?: string;
}

function buildDisputeNoticeEmail(args: DisputeNoticeEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  const userIds = args.recipientUserIds ?? (args.userId ? [args.userId] : []);
  const amountText = money(args.amountPaise, args.currency);
  const subject =
    args.kind === "OPENED"
      ? `Payment dispute opened (${amountText})`
      : `Payment dispute resolved (${amountText})`;
  const resolvedDashboardUrl = absolute(
    args.dashboardUrl ?? goHref("expert", "earnings"),
  );

  return {
    userIds,
    spec: {
      emailType: MONEY_EMAIL_TYPES.DISPUTE_NOTICE,
      category: null,
      from: SENDERS.finance,
      entityRef: `dispute:${args.disputeId}`,
      subject: () => subject,
      render: (r: EmailRecipient): ReactElement =>
        DisputeNoticeEmail({
          kind: args.kind,
          recipientName: greet(r),
          amountText,
          disputeId: args.disputeId,
          paymentId: args.paymentId,
          reason: args.reason,
          outcome: args.outcome,
          respondByText: args.respondBy
            ? dateText(args.respondBy, r.zone)
            : null,
          dashboardUrl: resolvedDashboardUrl,
        }),
    },
  };
}

export const stageDisputeNoticeEmail =
  defineLifecycleStager<DisputeNoticeEmailArgs>(buildDisputeNoticeEmail);

// ── Org billing receipts (invoice issued/paid & wallet top-up) ──────────────

export interface OrgBillingEmailArgs {
  recipientUserIds: string[];
  organizationId: string;
  orgName: string;
  kind: OrgBillingReceiptKind;
  amountPaise: Paise;
  currency: string;
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  dueDate?: Date | null;
  newBalancePaise?: Paise | null;
  /** Part of a top-up that paid down what the org owed instead of reaching the wallet. */
  receivableSettledPaise?: Paise | null;
  dashboardUrl: string;
}

function orgBillingSubject(
  kind: OrgBillingReceiptKind,
  invLabel: string,
  orgName: string,
): string {
  switch (kind) {
    case "INVOICE_ISSUED":
      return `Invoice${invLabel} issued for ${orgName}`;
    case "INVOICE_PAID":
      return `Invoice${invLabel} paid for ${orgName}`;
    case "WALLET_TOPUP_CONFIRMED":
      return `Wallet top-up confirmed for ${orgName}`;
  }
}

function buildOrgBillingEmail(args: OrgBillingEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  const amountText = money(args.amountPaise, args.currency);
  const invLabel = args.invoiceNumber ? ` ${args.invoiceNumber}` : "";
  const subject = orgBillingSubject(args.kind, invLabel, args.orgName);
  const entityRef = args.invoiceId
    ? `orgInvoice:${args.invoiceId}`
    : `org:${args.organizationId}`;
  const newBalanceText =
    args.newBalancePaise !== undefined && args.newBalancePaise !== null
      ? money(args.newBalancePaise, args.currency)
      : null;

  return {
    userIds: args.recipientUserIds,
    spec: {
      emailType: MONEY_EMAIL_TYPES.ORG_BILLING_RECEIPT,
      category: "orgBilling",
      from: SENDERS.finance,
      entityRef,
      traceRenderFailure: true,
      subject: () => subject,
      render: (r: EmailRecipient): ReactElement =>
        OrgBillingReceiptEmail({
          kind: args.kind,
          recipientName: greet(r),
          orgName: args.orgName,
          amountText,
          invoiceNumber: args.invoiceNumber,
          dueDateText: args.dueDate
            ? formatInvoiceDateWithZone(args.dueDate)
            : null,
          newBalanceText,
          settledText: args.receivableSettledPaise
            ? money(args.receivableSettledPaise, args.currency)
            : null,
          dashboardUrl: absolute(args.dashboardUrl),
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
  };
}

export function prepareOrgBillingEmail(
  args: OrgBillingEmailArgs,
): Promise<PreparedRecipientEmails> {
  const { userIds, spec } = buildOrgBillingEmail({
    ...args,
    dashboardUrl: absolute(args.dashboardUrl),
  });
  return prepareSpecEmails(spec, userIds);
}

export const sendOrgBillingEmail =
  defineBudgetedEmailSender<OrgBillingEmailArgs>(
    buildOrgBillingEmail,
    NOTHING_SENT,
    EMAIL_BUDGET_MS.WEBHOOK,
  );

export const stageOrgBillingEmail =
  defineLifecycleStager<OrgBillingEmailArgs>(buildOrgBillingEmail);

// ── Org operational & dunning threshold notices ─────────────────────────────

export interface OrgOperationalEmailArgs {
  recipientUserIds: string[];
  organizationId: string;
  orgName: string;
  kind: OrgOperationalEmailKind;
  programName?: string;
  assigneeName?: string;
  amountPaise?: Paise;
  expectedTotalPaise?: Paise;
  currency?: string;
  renewalDate?: Date | string;
  expiresAt?: Date | string;
  daysUntilRenewal?: number;
  cycle?: string;
  engagementsUsed?: number;
  cap?: number;
  usedPct?: number;
  actionUrl: string;
  entityRef?: string;
}

function buildOrgOperationalEmail(args: OrgOperationalEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  const currency = args.currency ?? "INR";
  const amountText =
    args.amountPaise !== undefined && args.amountPaise !== null
      ? money(args.amountPaise, currency)
      : undefined;
  const expectedTotalText =
    args.expectedTotalPaise !== undefined && args.expectedTotalPaise !== null
      ? money(args.expectedTotalPaise, currency)
      : undefined;
  const category =
    args.kind === "MEMBER_OVERAGE_TIMED_OUT" ? "orgBilling" : "orgProgram";

  return {
    userIds: args.recipientUserIds,
    spec: {
      emailType: `ORG_${args.kind}`,
      category,
      from: SENDERS.finance,
      entityRef:
        args.entityRef ??
        `org:${args.organizationId}:${args.kind.toLowerCase()}`,
      subject: () =>
        orgOperationalEmailSubject({
          kind: args.kind,
          orgName: args.orgName,
          programName: args.programName,
          daysUntilRenewal: args.daysUntilRenewal,
        }),
      render: (r: EmailRecipient): ReactElement =>
        OrgDunningEmail({
          kind: args.kind,
          recipientName: greet(r),
          orgName: args.orgName,
          programName: args.programName,
          assigneeName: args.assigneeName,
          amountText,
          expectedTotalText,
          renewalDateText: args.renewalDate
            ? dateText(args.renewalDate, r.zone)
            : undefined,
          expiresAtText: args.expiresAt
            ? dateText(args.expiresAt, r.zone)
            : undefined,
          daysUntilRenewal: args.daysUntilRenewal,
          cycle: args.cycle,
          engagementsUsed: args.engagementsUsed,
          cap: args.cap,
          usedPct: args.usedPct,
          actionUrl: absolute(args.actionUrl),
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
  };
}

export const sendOrgOperationalEmail =
  defineBudgetedEmailSender<OrgOperationalEmailArgs>(
    buildOrgOperationalEmail,
    NOTHING_SENT,
    EMAIL_BUDGET_MS.JOB,
  );

export const stageOrgOperationalEmail =
  defineLifecycleStager<OrgOperationalEmailArgs>(buildOrgOperationalEmail);

// ── Referral bonus & welcome credits ────────────────────────────────────────

interface ReferralBonusEmailBase {
  userId: string;
  counterpartyName?: string;
  amountPaise: Paise;
  remainingPaise?: Paise;
  currency?: string;
  appointmentType?: string;
  dashboardUrl?: string;
}

/** A reward is keyed by its referral; a redemption by the payment that used it. */
export type ReferralBonusEmailArgs = ReferralBonusEmailBase &
  (
    | {
        kind: Exclude<ReferralBonusEmailKind, "CREDITS_APPLIED">;
        referralId: string;
      }
    | { kind: "CREDITS_APPLIED"; paymentId: string }
  );

function buildReferralBonusEmail(args: ReferralBonusEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  const currency = args.currency ?? "INR";
  // The welcome discount is a cap; checkout applies the exact amount.
  const amountText =
    args.kind === "WELCOME_BONUS"
      ? `up to ${money(args.amountPaise, currency)}`
      : money(args.amountPaise, currency);
  const remainingText =
    args.remainingPaise !== undefined && args.remainingPaise !== null
      ? money(args.remainingPaise, currency)
      : undefined;
  const dashboardUrl = absolute(
    args.dashboardUrl ?? goHref("client", "payments"),
  );

  return {
    userIds: [args.userId],
    spec: {
      emailType: `REFERRAL_${args.kind}`,
      category: "payments",
      from: SENDERS.payments,
      entityRef:
        args.kind === "CREDITS_APPLIED"
          ? `payment:${args.paymentId}:referral-credits-applied`
          : `referral:${args.referralId}:${args.kind.toLowerCase()}`,
      subject: () => referralBonusSubject({ kind: args.kind, amountText }),
      render: (r: EmailRecipient): ReactElement =>
        ReferralBonusEmail({
          kind: args.kind,
          recipientName: greet(r),
          counterpartyName: args.counterpartyName,
          amountText,
          remainingText,
          appointmentType: args.appointmentType,
          dashboardUrl,
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
  };
}

export const stageReferralBonusEmail =
  defineLifecycleStager<ReferralBonusEmailArgs>(buildReferralBonusEmail);

export const prepareReferralBonusEmail =
  defineLifecyclePreparer<ReferralBonusEmailArgs>(buildReferralBonusEmail);

/**
 * #1653 — the money emails: refund processed and failed for the payer, and the
 * org billing notices (invoice overdue, wallet low, payout failed or reversed,
 * member overage due) for the org's visibility roster.
 *
 * Every sender takes user ids plus raw domain values, resolves the recipients
 * through the preference gate, and never throws: a missed email is reported
 * to Sentry and must never fail the request, the webhook or the job that
 * moved the money (ADR 21). The org senders take the roster as ids because
 * the call site computes it once with `rosterForOrg()` so the bell and the
 * email always reach the same people.
 */

import * as Sentry from "@sentry/nextjs";
import type { ReactElement } from "react";
import { OrgInvoiceOverdueEmail } from "@/emails/orgs/OrgInvoiceOverdueEmail";
import { OrgOverageDueEmail } from "@/emails/orgs/OrgOverageDueEmail";
import { OrgPayoutFailedEmail } from "@/emails/orgs/OrgPayoutFailedEmail";
import { OrgWalletLowEmail } from "@/emails/orgs/OrgWalletLowEmail";
import { RefundFailedEmail } from "@/emails/payments/RefundFailedEmail";
import { RefundProcessedEmail } from "@/emails/payments/RefundProcessedEmail";
import type { Tx } from "@/lib/prisma";
import { formatInViewerZone } from "@/lib/time/viewer-zone";
import { getAppUrl } from "@/lib/url";
import { formatCurrencyAmount } from "@/utils/formatting";
import { EMAIL_BUDGET_MS, SENDERS, supportEmail } from "../config";
import { loadEmailRecipients, type EmailRecipient } from "../preferences";
import {
  sendToRecipients,
  stageToRecipients,
  type SendToRecipientsResult,
  type StagedRecipientEmail,
} from "../send-to-recipients";

export const MONEY_EMAIL_TYPES = {
  REFUND_PROCESSED: "REFUND_PROCESSED",
  REFUND_FAILED: "REFUND_FAILED",
  ORG_INVOICE_OVERDUE: "ORG_INVOICE_OVERDUE",
  ORG_WALLET_LOW: "ORG_WALLET_LOW",
  ORG_PAYOUT_FAILED: "ORG_PAYOUT_FAILED",
  ORG_PROGRAM_OVERAGE_DUE: "ORG_PROGRAM_OVERAGE_DUE",
} as const;

const NOTHING_SENT: SendToRecipientsResult = { sent: 0, skipped: 0, failed: 0 };

/** Email-only date, rendered in the recipient's zone. */
const DATE_PATTERN = "d MMM yyyy";

/** Money columns arrive as BigInt from Prisma and as number from webhooks. */
type Paise = number | bigint;

function money(amountPaise: Paise, currency: string): string {
  return formatCurrencyAmount(Number(amountPaise), currency);
}

function greetingName(recipient: EmailRecipient): string {
  return recipient.name?.trim() || "there";
}

// One catch for every sender: report under the email subsystem and hand back
// an empty result so the caller's money path continues untouched.
async function guarded(
  emailType: string,
  run: () => Promise<SendToRecipientsResult>,
): Promise<SendToRecipientsResult> {
  try {
    return await run();
  } catch (error) {
    console.error(`[email] ${emailType} sender failed:`, error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "email", emailType } },
    );
    return NOTHING_SENT;
  }
}

// ============================================================================
// Refund processed
// ============================================================================

export interface RefundProcessedEmailArgs {
  userId: string;
  paymentId: string;
  amountPaise: Paise;
  currency: string;
  planTitle?: string;
  /** Passed only when the refund cascade's credit note is already in scope. */
  creditNoteNumber?: string;
}

function refundProcessedEnvelope(args: RefundProcessedEmailArgs) {
  const amountText = money(args.amountPaise, args.currency);
  const appUrl = getAppUrl();
  return {
    emailType: MONEY_EMAIL_TYPES.REFUND_PROCESSED,
    from: SENDERS.payments,
    entityRef: `payment:${args.paymentId}`,
    subject: () => `Your refund of ${amountText} is on its way`,
    render: (r: EmailRecipient): ReactElement =>
      RefundProcessedEmail({
        recipientName: greetingName(r),
        amountText,
        planTitle: args.planTitle,
        creditNoteNumber: args.creditNoteNumber,
        refundPolicyUrl: `${appUrl}/refund`,
        dashboardUrl: `${appUrl}/dashboard`,
        unsubscribeUrl: r.unsubscribeUrl,
      }),
  };
}

/**
 * Post-commit refund receipt. The budget is the caller's: `REQUEST` from a
 * route, `JOB` from a script.
 */
export async function sendRefundProcessedEmail(
  args: RefundProcessedEmailArgs,
  opts: { budgetMs: number },
): Promise<SendToRecipientsResult> {
  return guarded(MONEY_EMAIL_TYPES.REFUND_PROCESSED, async () => {
    const recipients = await loadEmailRecipients([args.userId], "payments");
    return sendToRecipients({
      recipients,
      ...refundProcessedEnvelope(args),
      budgetMs: opts.budgetMs,
    });
  });
}

/**
 * The transaction owner's twin (the refund webhook): every read goes through
 * `tx`, the rows are staged inside it, and the caller runs
 * `attemptStaged(list, MONEY_EMAIL_TYPES.REFUND_PROCESSED, EMAIL_BUDGET_MS.WEBHOOK)`
 * after commit. A staging failure propagates so the transaction rolls back
 * with it; a render failure is reported inside `stageToRecipients()`.
 */
export async function stageRefundProcessedEmail(
  tx: Pick<Tx, "failedEmail" | "user">,
  args: RefundProcessedEmailArgs,
): Promise<StagedRecipientEmail[]> {
  const recipients = await loadEmailRecipients([args.userId], "payments", tx);
  return stageToRecipients({
    tx,
    recipients,
    ...refundProcessedEnvelope(args),
  });
}

// ============================================================================
// Refund failed
// ============================================================================

export interface RefundFailedEmailArgs {
  userId: string;
  paymentId: string;
  amountPaise: Paise;
  currency: string;
}

/** From the reconcile job, once a refund is claimed FAILED. */
export async function sendRefundFailedEmail(
  args: RefundFailedEmailArgs,
): Promise<SendToRecipientsResult> {
  return guarded(MONEY_EMAIL_TYPES.REFUND_FAILED, async () => {
    const recipients = await loadEmailRecipients([args.userId], "payments");
    const amountText = money(args.amountPaise, args.currency);
    const support = supportEmail();
    return sendToRecipients({
      recipients,
      emailType: MONEY_EMAIL_TYPES.REFUND_FAILED,
      from: SENDERS.payments,
      entityRef: `payment:${args.paymentId}`,
      budgetMs: EMAIL_BUDGET_MS.JOB,
      subject: () => "We couldn't complete your refund",
      render: (r) =>
        RefundFailedEmail({
          recipientName: greetingName(r),
          amountText,
          supportEmail: support,
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    });
  });
}

// ============================================================================
// Org payout failed or reversed
// ============================================================================

export interface OrgPayoutFailedEmailArgs {
  /** The visibility roster, computed once by the caller with `rosterForOrg()`. */
  recipientUserIds: string[];
  kind: "FAILED" | "REVERSED";
  orgName: string;
  payoutId: string;
  amountPaise: Paise;
  currency: string;
  reason: string;
  dashboardUrl: string;
}

/** From the payout webhook, after the FAILED or REVERSED claim commits. */
export async function sendOrgPayoutFailedEmail(
  args: OrgPayoutFailedEmailArgs,
): Promise<SendToRecipientsResult> {
  return guarded(MONEY_EMAIL_TYPES.ORG_PAYOUT_FAILED, async () => {
    const recipients = await loadEmailRecipients(
      args.recipientUserIds,
      "orgBilling",
    );
    const amountText = money(args.amountPaise, args.currency);
    const subject =
      args.kind === "REVERSED"
        ? `A payout to ${args.orgName} was reversed`
        : `A payout to ${args.orgName} failed`;
    return sendToRecipients({
      recipients,
      emailType: MONEY_EMAIL_TYPES.ORG_PAYOUT_FAILED,
      from: SENDERS.finance,
      entityRef: `orgPayout:${args.payoutId}`,
      budgetMs: EMAIL_BUDGET_MS.WEBHOOK,
      subject: () => subject,
      render: (r) =>
        OrgPayoutFailedEmail({
          kind: args.kind,
          orgName: args.orgName,
          amountText,
          reason: args.reason,
          dashboardUrl: args.dashboardUrl,
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    });
  });
}

// ============================================================================
// Org invoice overdue
// ============================================================================

export interface OrgInvoiceOverdueEmailArgs {
  recipientUserIds: string[];
  invoiceId: string;
  invoiceNumber: string;
  orgName: string;
  totalPaise: Paise;
  currency: string;
  dueDate: Date;
  daysLate: number;
  /** 0 for the first notice, then the escalation reminder number. */
  reminderStage: number;
  payUrl: string;
}

/** From the dunning job, after each stage's claim commits. */
export async function sendOrgInvoiceOverdueEmail(
  args: OrgInvoiceOverdueEmailArgs,
): Promise<SendToRecipientsResult> {
  return guarded(MONEY_EMAIL_TYPES.ORG_INVOICE_OVERDUE, async () => {
    const recipients = await loadEmailRecipients(
      args.recipientUserIds,
      "orgBilling",
    );
    const amountText = money(args.totalPaise, args.currency);
    const dayWord = args.daysLate === 1 ? "day" : "days";
    return sendToRecipients({
      recipients,
      emailType: MONEY_EMAIL_TYPES.ORG_INVOICE_OVERDUE,
      from: SENDERS.finance,
      entityRef: `orgInvoice:${args.invoiceId}`,
      budgetMs: EMAIL_BUDGET_MS.JOB,
      subject: () =>
        `Invoice ${args.invoiceNumber} is ${args.daysLate} ${dayWord} overdue`,
      render: (r) =>
        OrgInvoiceOverdueEmail({
          orgName: args.orgName,
          invoiceNumber: args.invoiceNumber,
          amountText,
          dueDateText: formatInViewerZone(args.dueDate, r.zone, DATE_PATTERN),
          daysLate: args.daysLate,
          reminderStage: args.reminderStage,
          payUrl: args.payUrl,
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    });
  });
}

// ============================================================================
// Org wallet low
// ============================================================================

export interface OrgWalletLowEmailArgs {
  recipientUserIds: string[];
  organizationId: string;
  orgName: string;
  balancePaise: Paise;
  minimumPaise: Paise;
  currency: string;
  topUpUrl: string;
}

/** From the wallet job, after the cooldown claim. */
export async function sendOrgWalletLowEmail(
  args: OrgWalletLowEmailArgs,
): Promise<SendToRecipientsResult> {
  return guarded(MONEY_EMAIL_TYPES.ORG_WALLET_LOW, async () => {
    const recipients = await loadEmailRecipients(
      args.recipientUserIds,
      "orgBilling",
    );
    const balanceText = money(args.balancePaise, args.currency);
    const floorText = money(args.minimumPaise, args.currency);
    return sendToRecipients({
      recipients,
      emailType: MONEY_EMAIL_TYPES.ORG_WALLET_LOW,
      from: SENDERS.finance,
      entityRef: `org:${args.organizationId}`,
      budgetMs: EMAIL_BUDGET_MS.JOB,
      subject: () => `${args.orgName}'s wallet is running low`,
      render: (r) =>
        OrgWalletLowEmail({
          orgName: args.orgName,
          balanceText,
          floorText,
          topUpUrl: args.topUpUrl,
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    });
  });
}

// ============================================================================
// Org member overage due
// ============================================================================

export interface OrgOverageDueEmailArgs {
  userId: string;
  /** The OverageEvent row the member is asked to pay. */
  overageEventId: string;
  orgName: string;
  programTitle: string;
  amountPaise: Paise;
  currency: string;
  dueBy?: Date;
  payUrl: string;
}

/** From checkout, after the overage commits. */
export async function sendOrgOverageDueEmail(
  args: OrgOverageDueEmailArgs,
): Promise<SendToRecipientsResult> {
  return guarded(MONEY_EMAIL_TYPES.ORG_PROGRAM_OVERAGE_DUE, async () => {
    const recipients = await loadEmailRecipients([args.userId], "orgBilling");
    const amountText = money(args.amountPaise, args.currency);
    return sendToRecipients({
      recipients,
      emailType: MONEY_EMAIL_TYPES.ORG_PROGRAM_OVERAGE_DUE,
      from: SENDERS.finance,
      entityRef: `overage:${args.overageEventId}`,
      budgetMs: EMAIL_BUDGET_MS.REQUEST,
      subject: () => "Payment due for your recent booking",
      render: (r) =>
        OrgOverageDueEmail({
          recipientName: greetingName(r),
          orgName: args.orgName,
          programTitle: args.programTitle,
          amountText,
          dueByText: args.dueBy
            ? formatInViewerZone(args.dueBy, r.zone, DATE_PATTERN)
            : undefined,
          payUrl: args.payUrl,
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    });
  });
}

/**
 * What an org invoice still owes, and the one ISSUED/OVERDUE → PAID transition.
 * The gateway webhook and the admin bank-transfer door both settle through
 * `settleOrgInvoicePaid`, so the downstream of a paid invoice cannot drift.
 */
import { Prisma } from "@prisma/client";

import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { formatCurrencyAmount } from "@/utils/formatting";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { recordSystemEventSafe } from "@/lib/enterprise/system-events";
import { EMAIL_BUDGET_MS } from "@/lib/email/config";
import {
  MONEY_EMAIL_TYPES,
  stageOrgBillingEmail,
} from "@/lib/email/senders/money";
import {
  attemptStaged,
  type StagedRecipientEmail,
} from "@/lib/email/send-to-recipients";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu";
import { notifyOrgInvoicePaid } from "@/lib/novu/org-workflows";
import type { PrismaLike, Tx } from "@/lib/prisma";
import { gatewayCashAccount } from "@/lib/payments/ledger/gateway-account";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
import {
  hasUnappliedReceipt,
  postUnappliedInvoiceReceipt,
} from "@/lib/payments/ledger/unapplied-receipts";
import { sumPaise } from "@/lib/payments/utils/money";
import { getAppUrl } from "@/lib/url";

const PAYABLE_STATUSES = ["ISSUED", "OVERDUE"] as const;

/** Per invoice: total less issued credit notes and receipts, never below zero. */
export async function outstandingPaiseByInvoice(
  db: PrismaLike,
  invoices: { id: string; totalPaise: number }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (invoices.length === 0) return out;
  const ids = invoices.map((i) => i.id);
  // Aggregations bypass the money extension, hence sumPaise.
  const credits = await db.creditNote.groupBy({
    by: ["invoiceId"],
    where: { invoiceId: { in: ids }, status: "ISSUED" },
    _sum: { totalPaise: true },
  });
  const receipts = await db.organizationInvoiceReceipt.groupBy({
    by: ["invoiceId"],
    where: { invoiceId: { in: ids } },
    _sum: { amountPaise: true },
  });
  const credited = new Map(
    credits.map((c) => [c.invoiceId, sumPaise(c._sum.totalPaise)]),
  );
  const received = new Map(
    receipts.map((r) => [r.invoiceId, sumPaise(r._sum.amountPaise)]),
  );
  for (const inv of invoices) {
    const owed =
      inv.totalPaise -
      (credited.get(inv.id) ?? 0) -
      (received.get(inv.id) ?? 0);
    out.set(inv.id, Math.max(0, owed));
  }
  return out;
}

/** What `/pay` charges and what a capture must equal to settle the invoice. */
export async function invoiceOutstandingPaise(
  db: PrismaLike,
  invoiceId: string,
): Promise<number> {
  const invoice = await db.organizationInvoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { id: true, totalPaise: true },
  });
  const owed = await outstandingPaiseByInvoice(db, [invoice]);
  return owed.get(invoiceId) ?? 0;
}

/** Row-locks a payable invoice; false when it is no longer ISSUED or OVERDUE. */
export async function lockPayableInvoice(
  tx: Tx,
  invoiceId: string,
): Promise<boolean> {
  const locked = await tx.organizationInvoice.updateMany({
    where: { id: invoiceId, status: { in: [...PAYABLE_STATUSES] } },
    // A row lock must not erase the only reference to an unobserved capture.
    data: { updatedAt: new Date() },
  });
  return locked.count === 1;
}

export interface SettledOrgInvoice {
  organizationId: string;
  invoiceNumber: string;
  bells: StagedTrigger[];
  emails: StagedRecipientEmail[];
}

/**
 * ISSUED/OVERDUE → PAID with its downstream: the invoice.paid webhook, the
 * owners' bell and email (staged on `tx`), CHARGE_ORG overages → CHARGED and
 * the PENDING_TRUST release. Leaving OVERDUE lifts the dunning gate. Null when
 * another writer already moved the invoice.
 */
export async function settleOrgInvoicePaid(
  tx: Tx,
  args: {
    invoiceId: string;
    paidAt: Date;
    /** The gateway `pay_…` id, stamped on the invoice for its refunds. */
    providerPaymentId: string | null;
    /** What the invoice.paid webhook names as the payment. */
    paymentRef: string;
  },
): Promise<SettledOrgInvoice | null> {
  const { invoiceId, paidAt } = args;
  const claimed = await tx.organizationInvoice.updateMany({
    where: { id: invoiceId, status: { in: [...PAYABLE_STATUSES] } },
    data: {
      status: "PAID",
      paidAt,
      ...(args.providerPaymentId
        ? {
            providerPaymentId: args.providerPaymentId,
            providerPaymentOrderId: null,
          }
        : {}),
    },
  });
  if (claimed.count === 0) return null;

  const invoice = await tx.organizationInvoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: {
      id: true,
      invoiceNumber: true,
      totalPaise: true,
      displayCurrency: true,
      organizationId: true,
      organization: { select: { name: true } },
    },
  });
  const organizationId = invoice.organizationId;
  const received = await tx.organizationInvoiceReceipt.aggregate({
    where: { invoiceId },
    _sum: { amountPaise: true },
  });

  await dispatchWebhookEvent({
    prisma: tx,
    organizationId,
    eventType: "invoice.paid",
    payload: {
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      paidPaise: sumPaise(received._sum.amountPaise),
      paymentId: args.paymentRef,
      settledAt: paidAt.toISOString(),
    },
  });

  const orgName = invoice.organization.name;
  const dashboardUrl = `${getAppUrl()}/dashboard/organization/${organizationId}/billing`;
  const bells =
    (await notifyOrgInvoicePaid(
      organizationId,
      {
        invoiceNumber: invoice.invoiceNumber,
        orgName,
        totalPaise: invoice.totalPaise,
        currency: invoice.displayCurrency,
        paidAt: paidAt.toISOString(),
        dashboardUrl,
      },
      { tx, entityRef: `orgInvoice:${invoiceId}` },
    )) ?? [];
  const owners = await tx.membership.findMany({
    where: { organizationId, status: "ACTIVE", role: "OWNER" },
    select: { userId: true },
  });
  const emails =
    owners.length > 0
      ? await stageOrgBillingEmail(tx, {
          recipientUserIds: owners.map((o) => o.userId),
          organizationId,
          orgName,
          kind: "INVOICE_PAID",
          amountPaise: invoice.totalPaise,
          currency: invoice.displayCurrency,
          invoiceId,
          invoiceNumber: invoice.invoiceNumber,
          dashboardUrl,
        })
      : [];

  await tx.overageEvent.updateMany({
    where: {
      overageBehavior: "CHARGE_ORG",
      chargeStatus: "ACCRUED",
      invoiceLineItem: { invoiceId },
    },
    data: { chargeStatus: "CHARGED" },
  });
  const trustReleaseWhere = {
    payment: {
      organizationId,
      OR: [
        { billableToOrgInvoiceId: invoiceId },
        { billableToOrgInvoiceId: null },
      ],
    },
    status: "PENDING_TRUST" as const,
  };
  await tx.organizationEarnings.updateMany({
    where: trustReleaseWhere,
    data: { status: "PENDING" },
  });
  await tx.consultantEarnings.updateMany({
    where: trustReleaseWhere,
    data: { status: "PENDING" },
  });
  // A held row keeps its hold; it returns to PENDING, not the park, when the hold lifts.
  const heldTrustWhere = {
    payment: trustReleaseWhere.payment,
    status: "HELD" as const,
    preHoldStatus: "PENDING_TRUST" as const,
  };
  await tx.organizationEarnings.updateMany({
    where: heldTrustWhere,
    data: { preHoldStatus: "PENDING" },
  });
  await tx.consultantEarnings.updateMany({
    where: heldTrustWhere,
    data: { preHoldStatus: "PENDING" },
  });

  return {
    organizationId,
    invoiceNumber: invoice.invoiceNumber,
    bells,
    emails,
  };
}

/** After commit: attempt the paid invoice's staged bell and owner email. */
export async function attemptSettledInvoiceNotices(
  settled: SettledOrgInvoice,
  budgetMs: number = EMAIL_BUDGET_MS.WEBHOOK,
): Promise<void> {
  await Promise.allSettled([
    ...settled.bells.map((bell) => attemptTrigger(bell)),
    attemptStaged(
      settled.emails,
      MONEY_EMAIL_TYPES.ORG_BILLING_RECEIPT,
      budgetMs,
    ),
  ]);
}

export type InvoiceCaptureOutcome =
  | { kind: "PAID"; settled: SettledOrgInvoice }
  | { kind: "ALREADY_APPLIED" }
  | {
      kind: "UNAPPLIED";
      reason:
        | "INVOICE_NOT_FOUND"
        | "INVOICE_NOT_PAYABLE"
        | "AMOUNT_MISMATCH"
        | "ALREADY_UNAPPLIED";
    };

/**
 * A gateway capture against an org invoice. It settles the invoice only when
 * it equals the outstanding amount; any other capture is parked in
 * UNAPPLIED_RECEIPTS with one SystemEvent for ops, never auto-refunded.
 */
export async function applyOrgInvoiceCapture(
  tx: Tx,
  args: {
    invoiceId: string;
    gatewayPaymentId: string;
    capturedPaise: number;
    notesOrganizationId: string | null;
  },
): Promise<InvoiceCaptureOutcome> {
  const { invoiceId, gatewayPaymentId, capturedPaise } = args;
  const invoice = await tx.organizationInvoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      organizationId: true,
      status: true,
      providerPaymentId: true,
    },
  });

  const park = async (
    reason: "INVOICE_NOT_FOUND" | "INVOICE_NOT_PAYABLE" | "AMOUNT_MISMATCH",
    detail: Record<string, unknown>,
  ): Promise<InvoiceCaptureOutcome> => {
    const parked = await postUnappliedInvoiceReceipt(tx, {
      gatewayPaymentId,
      invoiceId: invoice ? invoiceId : null,
      capturedPaise,
    });
    if (parked) {
      await recordSystemEventSafe({
        db: tx,
        organizationId: invoice?.organizationId ?? args.notesOrganizationId,
        category: "INVOICE",
        severity: "ERROR",
        message: `ORG_INVOICE_CAPTURE_UNAPPLIED: ${capturedPaise}p captured as ${gatewayPaymentId} could not settle invoice ${invoiceId} (${reason}); parked in UNAPPLIED_RECEIPTS for an operator to apply or refund`,
        context: {
          invoiceId,
          gatewayPaymentId,
          capturedPaise,
          reason,
          ...detail,
        },
      });
    }
    return { kind: "UNAPPLIED", reason };
  };

  if (!invoice) return park("INVOICE_NOT_FOUND", {});
  const organizationId = invoice.organizationId;
  const alreadyApplied = async (): Promise<boolean> => {
    const current = await tx.organizationInvoice.findUniqueOrThrow({
      where: { id: invoiceId },
      select: { providerPaymentId: true },
    });
    const receipt = await tx.organizationInvoiceReceipt.findUnique({
      where: {
        organizationId_reference: {
          organizationId,
          reference: gatewayPaymentId,
        },
      },
      select: { id: true },
    });
    return receipt !== null || current.providerPaymentId === gatewayPaymentId;
  };
  if (await alreadyApplied()) return { kind: "ALREADY_APPLIED" };
  // A parked capture belongs to operator recovery until its liability is released.
  if (await hasUnappliedReceipt(tx, gatewayPaymentId)) {
    return { kind: "UNAPPLIED", reason: "ALREADY_UNAPPLIED" };
  }
  // Lock without invalidating a current checkout when this capture cannot settle.
  const locked = await tx.organizationInvoice.updateMany({
    where: { id: invoiceId, status: { in: [...PAYABLE_STATUSES] } },
    data: { updatedAt: new Date() },
  });
  if (locked.count !== 1) {
    // A concurrent delivery of this capture may have settled it while we waited on the lock.
    if (await alreadyApplied()) return { kind: "ALREADY_APPLIED" };
    return park("INVOICE_NOT_PAYABLE", { status: invoice.status });
  }
  const outstandingPaise = await invoiceOutstandingPaise(tx, invoiceId);
  if (capturedPaise !== outstandingPaise) {
    return park("AMOUNT_MISMATCH", { outstandingPaise });
  }

  const paidAt = new Date();
  await tx.organizationInvoiceReceipt.create({
    data: {
      organizationId: invoice.organizationId,
      invoiceId,
      amountPaise: capturedPaise,
      method: "GATEWAY",
      reference: gatewayPaymentId,
      receivedOn: paidAt,
    },
  });
  await postLedgerTxn(tx, {
    idempotencyKey: `invoicepaid:${invoiceId}`,
    kind: "INVOICE_PAID",
    invoiceId,
    postings: [
      {
        account: gatewayCashAccount(),
        direction: "DEBIT",
        amountPaise: capturedPaise,
      },
      {
        account: {
          kind: "ORG_RECEIVABLE",
          organizationId: invoice.organizationId,
        },
        direction: "CREDIT",
        amountPaise: capturedPaise,
      },
    ],
  });
  const settled = await settleOrgInvoicePaid(tx, {
    invoiceId,
    paidAt,
    providerPaymentId: gatewayPaymentId,
    paymentRef: gatewayPaymentId,
  });
  if (!settled) throw new Error(`Invoice ${invoiceId} left PAYABLE under lock`);
  return { kind: "PAID", settled };
}

export interface RecordedBankTransfer {
  receiptId: string;
  invoiceNumber: string;
  amountPaise: number;
  outstandingAfterPaise: number;
  settled: SettledOrgInvoice | null;
}

/**
 * Record a bank transfer against an ISSUED/OVERDUE invoice: one receipt row,
 * `Dr CASH / Cr ORG_RECEIVABLE`, and PAID once the outstanding reaches zero.
 * A part-payment leaves the invoice ISSUED or OVERDUE.
 */
export async function recordBankTransferReceipt(
  tx: Tx,
  args: {
    organizationId: string;
    invoiceId: string;
    utr: string;
    amountPaise: number;
    receivedOn: Date;
    recordedById: string;
    actorMembershipId: string;
  },
): Promise<RecordedBankTransfer> {
  const { organizationId, invoiceId, utr, amountPaise } = args;
  const invoice = await tx.organizationInvoice.findFirst({
    where: { id: invoiceId, organizationId },
    select: { id: true, status: true, invoiceNumber: true },
  });
  if (!invoice) {
    throw new OpsRefusal(
      "INVOICE_NOT_FOUND",
      "No such invoice for this organisation.",
      404,
    );
  }
  if (invoice.status === "PAID" || invoice.status === "REFUNDED") {
    throw new OpsRefusal(
      "INVOICE_ALREADY_PAID",
      "This invoice is already paid.",
    );
  }
  const duplicate = await tx.organizationInvoiceReceipt.findUnique({
    where: { organizationId_reference: { organizationId, reference: utr } },
    select: { invoiceId: true },
  });
  if (duplicate) {
    throw new OpsRefusal(
      "RECEIPT_DUPLICATE_UTR",
      "This UTR is already recorded for this organisation.",
    );
  }
  if (!(await lockPayableInvoice(tx, invoiceId))) {
    throw new OpsRefusal(
      "INVOICE_NOT_PAYABLE",
      `Only an issued or overdue invoice takes a payment; this one is ${invoice.status}.`,
    );
  }
  const outstandingPaise = await invoiceOutstandingPaise(tx, invoiceId);
  if (amountPaise > outstandingPaise) {
    throw new OpsRefusal(
      "RECEIPT_EXCEEDS_OUTSTANDING",
      `The invoice has ${outstandingPaise} paise outstanding; record at most that.`,
    );
  }

  let receiptId: string;
  try {
    receiptId = (
      await tx.organizationInvoiceReceipt.create({
        data: {
          organizationId,
          invoiceId,
          amountPaise,
          method: "BANK_TRANSFER",
          reference: utr,
          receivedOn: args.receivedOn,
          recordedById: args.recordedById,
        },
        select: { id: true },
      })
    ).id;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new OpsRefusal(
        "RECEIPT_DUPLICATE_UTR",
        "This UTR is already recorded for this organisation.",
      );
    }
    throw err;
  }
  await postLedgerTxn(tx, {
    idempotencyKey: `invoicereceipt:${receiptId}`,
    kind: "INVOICE_PAID",
    invoiceId,
    description: "Bank transfer received against an org invoice",
    postings: [
      { account: { kind: "CASH" }, direction: "DEBIT", amountPaise },
      {
        account: { kind: "ORG_RECEIVABLE", organizationId },
        direction: "CREDIT",
        amountPaise,
      },
    ],
  });
  await tx.orgAuditLog.create({
    data: {
      organizationId,
      actorMembershipId: args.actorMembershipId,
      category: "INVOICE",
      action: AUDIT_ACTIONS.INVOICE.INVOICE_RECEIPT_RECORDED,
      description: `Bank transfer ${utr} of ${formatCurrencyAmount(amountPaise, "INR")} recorded against invoice ${invoice.invoiceNumber}`,
      details: { invoiceId, receiptId, utr, amountPaise },
    },
  });

  const outstandingAfterPaise = outstandingPaise - amountPaise;
  const settled =
    outstandingAfterPaise === 0
      ? await settleOrgInvoicePaid(tx, {
          invoiceId,
          paidAt: new Date(),
          providerPaymentId: null,
          paymentRef: utr,
        })
      : null;
  if (settled) {
    await tx.orgAuditLog.create({
      data: {
        organizationId,
        actorMembershipId: args.actorMembershipId,
        category: "INVOICE",
        action: AUDIT_ACTIONS.INVOICE.INVOICE_PAID,
        description: `Invoice ${invoice.invoiceNumber} paid by bank transfer`,
        details: { invoiceId, receiptId, utr },
      },
    });
  }
  return {
    receiptId,
    invoiceNumber: invoice.invoiceNumber,
    amountPaise,
    outstandingAfterPaise,
    settled,
  };
}

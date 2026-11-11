import type { Currency } from "@prisma/client";
import { z } from "zod";

import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { deriveGstBreakdown, orgBuyerCountry } from "@/lib/compliance/gst";
import { lutNumberForSupply } from "@/lib/compliance/lut";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { notifyOrgInvoiceIssued } from "@/lib/novu/org-workflows";
import { sendOrgBillingEmail } from "@/lib/email/senders/money";
import { reportSentryError } from "@/lib/observability/report";
import prisma, { type Tx } from "@/lib/prisma";
import {
  supplierStateCode,
  SupplierStateMismatchError,
} from "@/lib/payments/billing/consumer-invoice";
import { generateOrgInvoiceNumber } from "@/lib/payments/billing/invoice-numbering";
import { postInvoiceIssuedJournal } from "@/lib/payments/billing/org-invoice-journal";
import { transitionOrgInvoice } from "@/lib/enterprise/transitions";
import { drawPurchaseOrder } from "@/lib/payments/billing/purchase-order-draw";
import { isPlatformGstRegistered } from "@/lib/pdf/supplier";
import {
  GST_REGISTRATION_REQUIRED,
  GST_INVOICE_REGISTRATION_MESSAGE,
} from "@/lib/payments/tax/gst-regime";

const LineItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.coerce.number().int().min(1).max(100_000),
  // Paise; ₹10 crore per unit.
  unitPrice: z.coerce.number().int().min(0).max(10_000_000_000),
});

export const CreateOrgInvoiceSchema = z.object({
  purchaseOrderId: z.string().min(1).nullable().optional(),
  contractId: z.string().min(1).nullable().optional(),
  displayCurrency: z.enum(["INR", "USD", "EUR", "GBP"]).default("INR"),
  items: z.array(LineItemSchema).min(1),
  // Caller-provided so the composer can render NET-30 or NET-60 per contract terms.
  dueDate: z.coerce.date(),
  billingCycleStart: z.coerce.date().nullable().optional(),
  billingCycleEnd: z.coerce.date().nullable().optional(),
  // A DRAFT invoice isn't billed; some callers review before issuing.
  issueImmediately: z.boolean().default(false),
});

export type CreateOrgInvoiceInput = z.infer<typeof CreateOrgInvoiceSchema>;

/** Refuses a PO the org's invoice may not draw on: foreign, not ACTIVE, or in another currency. */
async function assertInvoiceablePurchaseOrder(
  tx: Tx,
  args: { orgId: string; purchaseOrderId: string; currency: Currency },
): Promise<void> {
  const po = await tx.purchaseOrder.findUnique({
    where: { id: args.purchaseOrderId },
    select: { organizationId: true, status: true, currency: true },
  });
  if (po?.organizationId !== args.orgId) {
    throw new OpsRefusal(
      "PO_FOREIGN",
      "PurchaseOrder does not belong to this organization",
      400,
    );
  }
  if (po.status !== "ACTIVE") {
    throw new OpsRefusal(
      "PO_NOT_ACTIVE",
      `PurchaseOrder is ${po.status}; only ACTIVE POs can be invoiced against`,
    );
  }
  // The draw-down spends paise-for-paise, so the currencies must match.
  if (po.currency !== args.currency) {
    throw new OpsRefusal(
      "PO_CURRENCY_MISMATCH",
      `PurchaseOrder is denominated in ${po.currency}; this invoice is in ${args.currency}. A PO can only be drawn down by an invoice in its own currency.`,
    );
  }
}

/**
 * Manually raise an org invoice inside `tx`. Refusals throw `OpsRefusal`
 * with the HTTP status and code each caller answers with.
 */
export async function createOrgInvoice(
  tx: Tx,
  args: {
    orgId: string;
    actorMembershipId: string;
    input: CreateOrgInvoiceInput;
  },
) {
  const { orgId, actorMembershipId, input } = args;

  const org = await tx.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      slug: true,
      taxInfo: {
        select: { gstStateCode: true, gstin: true, hsnDefault: true },
      },
      dataResidencyRegion: true,
      billingAccountId: true,
      invoiceNumberPrefix: true,
      requiresPO: true,
    },
  });
  if (!org?.billingAccountId) {
    throw new OpsRefusal(
      "NO_BILLING_ACCOUNT",
      "Organization does not have a BillingAccount",
      404,
    );
  }
  const billingAccountId = org.billingAccountId;
  if (org.requiresPO && !input.purchaseOrderId) {
    throw new OpsRefusal(
      "PO_REQUIRED",
      "This organisation needs a purchase order on every invoice. Choose an active purchase order and try again.",
    );
  }
  // A domestic B2B invoice needs the buyer's declared GST state for its place of supply.
  const buyerStateCode = org.taxInfo?.gstStateCode ?? null;
  if (org.dataResidencyRegion === "IN" && !buyerStateCode) {
    throw new OpsRefusal(
      "GST_STATE_REQUIRED",
      "Add your organisation's GST state in billing settings before raising an invoice.",
    );
  }

  if (input.purchaseOrderId) {
    await assertInvoiceablePurchaseOrder(tx, {
      orgId,
      purchaseOrderId: input.purchaseOrderId,
      currency: input.displayCurrency,
    });
  }
  if (input.contractId) {
    const contract = await tx.contract.findUnique({
      where: { id: input.contractId },
      select: { organizationId: true },
    });
    if (!contract || contract.organizationId !== orgId) {
      throw new OpsRefusal(
        "CONTRACT_FOREIGN",
        "Contract does not belong to this organization",
        400,
      );
    }
  }

  // INR-only: the GST breakdown below sums in displayCurrency with no FX conversion.
  if (input.displayCurrency !== "INR") {
    throw new OpsRefusal(
      "CURRENCY_UNSUPPORTED",
      "Non-INR invoices are not yet supported.",
      400,
    );
  }

  const subtotal = input.items.reduce(
    (sum, item) => sum + item.quantity * item.unitPrice,
    0,
  );

  // GSTIN-first supplier state, fail-closed on a mismatch: an ambiguous state
  // would put IGST on an intra-state supply.
  let supplierState: string;
  try {
    supplierState = supplierStateCode();
  } catch (err) {
    if (!(err instanceof SupplierStateMismatchError)) throw err;
    // The mismatch names the GSTIN and registered state: ops detail, not caller copy.
    reportSentryError(err, { subsystem: "billing", op: "createOrgInvoice" });
    throw new OpsRefusal(
      "INVOICE_SERVICE_UNAVAILABLE",
      "Invoice service is temporarily unavailable.",
      503,
    );
  }
  // An unregistered supplier issues no GST invoice.
  if (!isPlatformGstRegistered()) {
    throw new OpsRefusal(
      GST_REGISTRATION_REQUIRED,
      GST_INVOICE_REGISTRATION_MESSAGE,
      403,
    );
  }
  const gst = deriveGstBreakdown({
    subtotalPaise: subtotal,
    supplierStateCode: supplierState,
    buyerStateCode,
    buyerGstin: org.taxInfo?.gstin ?? null,
    buyerCountry: orgBuyerCountry(org),
    hsnCode: org.taxInfo?.hsnDefault,
  });
  if (
    !Number.isSafeInteger(subtotal) ||
    !Number.isSafeInteger(gst.totalPaise)
  ) {
    throw new OpsRefusal(
      "INVOICE_AMOUNT_TOO_LARGE",
      "The invoice total is too large. Split it into smaller invoices.",
      400,
    );
  }

  const issuedAt = new Date();
  // The counter row reserves the next seq under (org, fiscal year).
  const { invoiceNumber, fiscalYear } = await generateOrgInvoiceNumber(
    tx,
    {
      id: org.id,
      slug: org.slug,
      invoiceNumberPrefix: org.invoiceNumberPrefix,
    },
    issuedAt,
  );

  if (input.purchaseOrderId) {
    const drawn = await drawPurchaseOrder(tx, {
      purchaseOrderId: input.purchaseOrderId,
      organizationId: orgId,
      currency: input.displayCurrency,
      amountPaise: gst.totalPaise,
      now: issuedAt,
    });
    if (!drawn) {
      throw new OpsRefusal(
        "PO_BALANCE_EXCEEDED",
        "PurchaseOrder balance insufficient or no longer ACTIVE",
      );
    }
  }

  const created = await tx.organizationInvoice.create({
    data: {
      billingAccountId,
      organizationId: orgId,
      purchaseOrderId: input.purchaseOrderId ?? null,
      contractId: input.contractId ?? null,
      invoiceNumber,
      fiscalYear,
      status: input.issueImmediately ? "ISSUED" : "DRAFT",
      displayCurrency: input.displayCurrency,
      inrEquivalentPaise: gst.totalPaise,
      subtotalPaise: gst.subtotalPaise,
      igstPaise: gst.igstPaise,
      cgstPaise: gst.cgstPaise,
      sgstPaise: gst.sgstPaise,
      totalPaise: gst.totalPaise,
      taxRate: gst.igstPaise + gst.cgstPaise + gst.sgstPaise > 0 ? 0.18 : 0,
      hsnCode: gst.hsnCode,
      placeOfSupply: gst.placeOfSupply,
      reverseCharge: gst.reverseCharge,
      gstin: org.taxInfo?.gstin ?? null,
      lutNumber: lutNumberForSupply(gst.reason),
      irpStatus: "PENDING",
      autoGenerated: false,
      issuedAt: input.issueImmediately ? issuedAt : null,
      dueDate: input.dueDate,
      billingCycleStart: input.billingCycleStart ?? null,
      billingCycleEnd: input.billingCycleEnd ?? null,
      lineItems: {
        create: input.items.map((item, idx) => ({
          position: idx,
          description: item.description,
          quantity: item.quantity,
          unitPricePaise: item.unitPrice,
        })),
      },
    },
  });

  if (input.issueImmediately) {
    await postInvoiceIssuedJournal(tx, created.id);
  }

  await tx.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId,
      category: "INVOICE",
      action: AUDIT_ACTIONS.INVOICE.INVOICE_GENERATED,
      description: `${input.issueImmediately ? "Issued" : "Drafted"} invoice ${invoiceNumber}`,
      details: {
        invoiceId: created.id,
        invoiceNumber,
        totalPaise: created.totalPaise,
        status: created.status,
        placeOfSupply: created.placeOfSupply,
      },
    },
  });

  // Integrators only see invoices they must act on; a DRAFT fires on its later ISSUED PATCH.
  if (input.issueImmediately) {
    await dispatchWebhookEvent({
      prisma: tx,
      organizationId: orgId,
      eventType: "invoice.issued",
      payload: {
        invoiceId: created.id,
        invoiceNumber: created.invoiceNumber,
        totalPaise: created.totalPaise,
        displayCurrency: created.displayCurrency,
        dueDate: created.dueDate.toISOString(),
        purchaseOrderId: created.purchaseOrderId,
        contractId: created.contractId,
      },
    });
  }

  return { invoice: created, orgName: org.name };
}

export type CreatedOrgInvoice = Awaited<ReturnType<typeof createOrgInvoice>>;

/** After commit: tell the org's OWNERs an invoice was issued on creation. Run via `scheduleAfter`. */
export async function notifyCreatedOrgInvoice(
  origin: string,
  orgId: string,
  created: CreatedOrgInvoice,
  input: CreateOrgInvoiceInput,
): Promise<void> {
  if (!input.issueImmediately) return;
  await notifyIssuedOrgInvoice(origin, orgId, {
    invoiceId: created.invoice.id,
    invoiceNumber: created.invoice.invoiceNumber,
    totalPaise: created.invoice.totalPaise,
    currency: input.displayCurrency,
    dueDate: input.dueDate,
    orgName: created.orgName,
  });
}

export interface IssuedOrgInvoiceNotice {
  invoiceId: string;
  invoiceNumber: string;
  totalPaise: number;
  currency: Currency;
  dueDate: Date;
  orgName: string;
}

/** After commit: the owners' invoice-issued bell and email. Never throws. */
export async function notifyIssuedOrgInvoice(
  origin: string,
  orgId: string,
  notice: IssuedOrgInvoiceNotice,
): Promise<void> {
  try {
    const dashboardUrl = `${origin}/dashboard/organization/${orgId}/billing`;
    const ownerRows = await prisma.membership.findMany({
      where: { organizationId: orgId, status: "ACTIVE", role: "OWNER" },
      select: { userId: true },
    });
    await Promise.all([
      Promise.resolve(
        notifyOrgInvoiceIssued(orgId, {
          invoiceNumber: notice.invoiceNumber,
          orgName: notice.orgName,
          totalPaise: notice.totalPaise,
          currency: notice.currency,
          dueDate: notice.dueDate.toISOString(),
          dashboardUrl,
          pdfUrl: `${origin}/api/organizations/${orgId}/billing-account/invoices/${notice.invoiceId}/pdf`,
        }),
      ).catch((err) => {
        console.error("[org-invoice] notifyOrgInvoiceIssued failed:", err);
        return [];
      }),
      Promise.resolve(
        sendOrgBillingEmail({
          recipientUserIds: ownerRows.map((r) => r.userId),
          organizationId: orgId,
          orgName: notice.orgName,
          kind: "INVOICE_ISSUED",
          amountPaise: notice.totalPaise,
          currency: notice.currency,
          invoiceId: notice.invoiceId,
          invoiceNumber: notice.invoiceNumber,
          dueDate: notice.dueDate,
          dashboardUrl,
        }),
      ).catch((err) => {
        console.error("[org-invoice] sendOrgBillingEmail failed:", err);
      }),
    ]);
  } catch (notifyErr) {
    console.error("[org-invoice] post-commit notify failed:", notifyErr);
  }
}

/**
 * Issue a DRAFT org invoice, drawing a PO when one is given; an org that
 * requires a PO must name one unless the draft already drew it. The due date
 * keeps the draft's payment terms, counted from now.
 */
export async function issueDraftOrgInvoice(
  tx: Tx,
  args: {
    orgId: string;
    invoiceId: string;
    purchaseOrderId: string | null;
    actorMembershipId: string;
  },
): Promise<IssuedOrgInvoiceNotice & { purchaseOrderId: string | null }> {
  const { orgId, invoiceId } = args;
  const invoice = await tx.organizationInvoice.findFirst({
    where: { id: invoiceId, organizationId: orgId },
    select: {
      id: true,
      status: true,
      invoiceNumber: true,
      totalPaise: true,
      displayCurrency: true,
      purchaseOrderId: true,
      dueDate: true,
      createdAt: true,
      contractId: true,
      organization: { select: { name: true, requiresPO: true } },
    },
  });
  if (!invoice) {
    throw new OpsRefusal(
      "INVOICE_NOT_FOUND",
      "No such invoice for this organisation.",
      404,
    );
  }
  if (invoice.status !== "DRAFT") {
    throw new OpsRefusal(
      "INVOICE_NOT_DRAFT",
      `Only a draft invoice can be issued; this one is ${invoice.status}.`,
    );
  }
  if (
    invoice.purchaseOrderId &&
    args.purchaseOrderId &&
    args.purchaseOrderId !== invoice.purchaseOrderId
  ) {
    throw new OpsRefusal(
      "PO_ALREADY_DRAWN",
      "This draft already draws on another purchase order.",
    );
  }
  const drawNew = !invoice.purchaseOrderId && args.purchaseOrderId !== null;
  const purchaseOrderId = invoice.purchaseOrderId ?? args.purchaseOrderId;
  if (invoice.organization.requiresPO && !purchaseOrderId) {
    throw new OpsRefusal(
      "PO_REQUIRED",
      "This organisation needs a purchase order on every invoice. Choose an active purchase order and try again.",
    );
  }

  const issuedAt = new Date();
  if (drawNew && purchaseOrderId) {
    await assertInvoiceablePurchaseOrder(tx, {
      orgId,
      purchaseOrderId,
      currency: invoice.displayCurrency,
    });
    const drawn = await drawPurchaseOrder(tx, {
      purchaseOrderId,
      organizationId: orgId,
      currency: invoice.displayCurrency,
      amountPaise: invoice.totalPaise,
      now: issuedAt,
    });
    if (!drawn) {
      throw new OpsRefusal(
        "PO_BALANCE_EXCEEDED",
        "PurchaseOrder balance insufficient or no longer ACTIVE",
      );
    }
  }

  const dueDate = new Date(
    issuedAt.getTime() +
      Math.max(0, invoice.dueDate.getTime() - invoice.createdAt.getTime()),
  );
  await transitionOrgInvoice(tx, {
    where: { id: invoiceId, organizationId: orgId },
    to: "ISSUED",
    data: { issuedAt, dueDate, purchaseOrderId },
    audit: {
      organizationId: orgId,
      actorMembershipId: args.actorMembershipId,
      category: "INVOICE",
      action: AUDIT_ACTIONS.INVOICE.INVOICE_ISSUED,
      description: `Issued draft invoice ${invoice.invoiceNumber}`,
      details: { invoiceId, purchaseOrderId },
    },
  });
  await postInvoiceIssuedJournal(tx, invoiceId);
  await dispatchWebhookEvent({
    prisma: tx,
    organizationId: orgId,
    eventType: "invoice.issued",
    payload: {
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      totalPaise: invoice.totalPaise,
      displayCurrency: invoice.displayCurrency,
      dueDate: dueDate.toISOString(),
      purchaseOrderId,
      contractId: invoice.contractId,
    },
  });
  return {
    invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    totalPaise: invoice.totalPaise,
    currency: invoice.displayCurrency,
    dueDate,
    orgName: invoice.organization.name,
    purchaseOrderId,
  };
}

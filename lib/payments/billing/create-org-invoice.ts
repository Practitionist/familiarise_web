import { z } from "zod";

import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { deriveGstBreakdown, orgBuyerCountry } from "@/lib/compliance/gst";
import { lutNumberForSupply } from "@/lib/compliance/lut";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { notifyOrgInvoiceIssued } from "@/lib/novu/org-workflows";
import { reportSentryError } from "@/lib/observability/report";
import type { Tx } from "@/lib/prisma";
import {
  supplierStateCode,
  SupplierStateMismatchError,
} from "@/lib/payments/billing/consumer-invoice";
import { generateOrgInvoiceNumber } from "@/lib/payments/billing/invoice-numbering";
import { postInvoiceIssuedJournal } from "@/lib/payments/billing/org-invoice-journal";
import { drawPurchaseOrder } from "@/lib/payments/billing/purchase-order-draw";

const LineItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.coerce.number().int().min(1),
  unitPrice: z.coerce.number().int().min(0),
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
  issueImmediately: z.coerce.boolean().default(false),
});

export type CreateOrgInvoiceInput = z.infer<typeof CreateOrgInvoiceSchema>;

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
    const po = await tx.purchaseOrder.findUnique({
      where: { id: input.purchaseOrderId },
      select: { organizationId: true, status: true, currency: true },
    });
    if (!po || po.organizationId !== orgId) {
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
    // The draw-down below spends paise-for-paise, so the currencies must match.
    if (po.currency !== input.displayCurrency) {
      throw new OpsRefusal(
        "PO_CURRENCY_MISMATCH",
        `PurchaseOrder is denominated in ${po.currency}; this invoice is in ${input.displayCurrency}. A PO can only be drawn down by an invoice in its own currency.`,
      );
    }
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
    // The mismatch names the GSTIN and env value — ops detail, not caller copy.
    reportSentryError(err, { subsystem: "billing", op: "createOrgInvoice" });
    throw new OpsRefusal(
      "INVOICE_SERVICE_UNAVAILABLE",
      "Invoice service is temporarily unavailable.",
      503,
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
        dueDate: created.dueDate,
        purchaseOrderId: created.purchaseOrderId,
        contractId: created.contractId,
      },
    });
  }

  return { invoice: created, orgName: org.name };
}

export type CreatedOrgInvoice = Awaited<ReturnType<typeof createOrgInvoice>>;

/** After commit: tell the org's OWNERs an invoice was issued on creation. */
export function notifyCreatedOrgInvoice(
  origin: string,
  orgId: string,
  created: CreatedOrgInvoice,
  input: CreateOrgInvoiceInput,
): void {
  if (!input.issueImmediately) return;
  const { invoice, orgName } = created;
  notifyOrgInvoiceIssued(orgId, {
    invoiceNumber: invoice.invoiceNumber,
    orgName,
    totalPaise: invoice.totalPaise,
    currency: input.displayCurrency,
    dueDate: input.dueDate.toISOString(),
    dashboardUrl: `${origin}/dashboard/organization/${orgId}/billing`,
    pdfUrl: `${origin}/api/organizations/${orgId}/billing-account/invoices/${invoice.id}/pdf`,
  }).catch((err) => console.error("[notifyOrgInvoiceIssued] failed:", err));
}

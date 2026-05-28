/**
 * GET  /api/organizations/[orgId]/billing-account/invoices
 * POST /api/organizations/[orgId]/billing-account/invoices
 *
 * POST manually generates an invoice (vs the daily cron at
 * jobs/billing/generate-subscription-invoices.ts which auto-generates
 * from BillingSubscription.nextInvoiceDate). Useful for one-off line
 * items or for re-issuing a voided invoice.
 *
 * Every invoice carries its GST breakdown + IRN placeholder. The IRN
 * stays PENDING until the IRP uploader cron (stubbed) populates it.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
// Why: invoice creation is the canonical finance-team mutation; downgrade
// from OWNER-only so BILLING_ADMIN can issue invoices without escalation.
// MAINTAINER is intentionally excluded — see `lib/auth/billing-admin-gate.ts`.
import { requireOrgBillingAdminOrOwner } from "@/lib/auth/billing-admin-gate";
import { deriveGstBreakdown } from "@/lib/compliance/gst";
import { generateOrgInvoiceNumber } from "@/lib/payments/billing/invoice-numbering";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { notifyOrgInvoiceIssued } from "@/lib/novu/org-workflows";

const CurrencySchema = z.enum(["INR", "USD", "EUR", "GBP"]);

const InvoiceStatusSchema = z.enum([
  "DRAFT",
  "ISSUED",
  "PAID",
  "OVERDUE",
  "VOID",
  "CANCELLED",
]);

const LineItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.coerce.number().int().min(1),
  unitPrice: z.coerce.number().int().min(0),
  paymentId: z.string().optional(),
});

const CreateBodySchema = z.object({
  purchaseOrderId: z.string().min(1).nullable().optional(),
  contractId: z.string().min(1).nullable().optional(),
  displayCurrency: CurrencySchema.default("INR"),
  items: z.array(LineItemSchema).min(1),
  // Due date is caller-provided so the /billing page can render NET-60
  // or NET-30 depending on contract terms. Server uses it verbatim.
  dueDate: z.coerce.date(),
  billingCycleStart: z.coerce.date().nullable().optional(),
  billingCycleEnd: z.coerce.date().nullable().optional(),
  // Issued-vs-draft is explicit: a DRAFT invoice isn't billed, an
  // ISSUED one is. We don't auto-transition on POST because some
  // callers want to review before sending.
  issueImmediately: z.coerce.boolean().default(false),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { minimumRole: "MANAGER", canSponsor: true });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const rawStatus = url.searchParams.get("status");
  const status = rawStatus ? InvoiceStatusSchema.safeParse(rawStatus) : null;
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const perPage = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("perPage") ?? 20)),
  );

  const where = {
    organizationId: orgId,
    ...(status?.success ? { status: status.data } : {}),
  };

  const [total, invoices] = await prisma.$transaction([
    prisma.organizationInvoice.count({ where }),
    prisma.organizationInvoice.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        purchaseOrder: { select: { id: true, poNumber: true } },
      },
    }),
  ]);

  return NextResponse.json({ data: invoices, meta: { total, page, perPage } });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgBillingAdminOrOwner(orgId, { canSponsor: true });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      slug: true,
      gstStateCode: true,
      gstin: true,
      hsnDefault: true,
      dataResidencyRegion: true,
      billingAccountId: true,
      invoiceNumberPrefix: true,
    },
  });
  if (!org?.billingAccountId) {
    return NextResponse.json(
      { error: "Organization does not have a BillingAccount" },
      { status: 404 },
    );
  }

  if (body.purchaseOrderId) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: body.purchaseOrderId },
      select: { organizationId: true, status: true },
    });
    if (!po || po.organizationId !== orgId) {
      return NextResponse.json(
        { error: "PurchaseOrder does not belong to this organization" },
        { status: 400 },
      );
    }
    if (po.status !== "ACTIVE") {
      return NextResponse.json(
        { error: `PurchaseOrder is ${po.status}; only ACTIVE POs can be invoiced against` },
        { status: 409 },
      );
    }
  }
  if (body.contractId) {
    const contract = await prisma.contract.findUnique({
      where: { id: body.contractId },
      select: { organizationId: true },
    });
    if (!contract || contract.organizationId !== orgId) {
      return NextResponse.json(
        { error: "Contract does not belong to this organization" },
        { status: 400 },
      );
    }
  }

  const subtotal = body.items.reduce(
    (sum, item) => sum + item.quantity * item.unitPrice,
    0,
  );

  // GST breakdown delegates to the compliance stub. In production the
  // stub is replaced with the live resolver (place-of-supply + IGST
  // vs CGST+SGST split); either way we store the numbers at invoice
  // creation so retroactive tax-rule changes don't rewrite history.
  const gst = deriveGstBreakdown({
    subtotalPaise: subtotal,
    // Env-overridable; see jobs/billing/generate-subscription-invoices.ts
    // for the same pattern. Falls back to KA when unset.
    supplierStateCode: process.env.SUPPLIER_STATE_CODE ?? "KA",
    buyerStateCode: org.gstStateCode,
    buyerCountry: org.dataResidencyRegion === "IN" ? "IN" : "US",
    hsnCode: org.hsnDefault,
  });

  const issuedAt = body.issueImmediately ? new Date() : new Date();

  let invoice;
  try {
    invoice = await prisma.$transaction(async (tx) => {
    // Per-org sequential numbering: counter row atomically reserves the
    // next seq under (org, fiscal-year) so two concurrent POSTs can't
    // collide on the @@unique([organizationId, invoiceNumber]) constraint.
    const { invoiceNumber, fiscalYear } = await generateOrgInvoiceNumber(
      tx,
      { id: org.id, slug: org.slug, invoiceNumberPrefix: org.invoiceNumberPrefix },
      issuedAt,
    );

    // PO balance enforcement (race-safe). When the invoice is linked to
    // a PO, atomically decrement `remainingAmountPaise` and fail closed
    // (409 `PO_BALANCE_EXCEEDED`) if the PO is no longer ACTIVE or has
    // insufficient remaining budget. Mirrors the wallet-debit pattern
    // in `lib/api/organizations/wallet.ts`. Restoration on VOID /
    // CANCELLED is handled in the PATCH route at
    // `[invoiceId]/route.ts`.
    if (body.purchaseOrderId) {
      const claim = await tx.purchaseOrder.updateMany({
        where: {
          id: body.purchaseOrderId,
          organizationId: orgId,
          status: "ACTIVE",
          remainingAmountPaise: { gte: gst.totalPaise },
        },
        data: { remainingAmountPaise: { decrement: gst.totalPaise } },
      });
      if (claim.count !== 1) {
        const err = new Error(
          "PurchaseOrder balance insufficient or no longer ACTIVE",
        );
        Object.assign(err, {
          httpStatus: 409,
          code: "PO_BALANCE_EXCEEDED",
        });
        throw err;
      }
    }

    const created = await tx.organizationInvoice.create({
      data: {
        billingAccountId: org.billingAccountId!,
        organizationId: orgId,
        purchaseOrderId: body.purchaseOrderId ?? null,
        contractId: body.contractId ?? null,
        invoiceNumber,
        fiscalYear,
        status: body.issueImmediately ? "ISSUED" : "DRAFT",
        displayCurrency: body.displayCurrency,
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
        gstin: org.gstin,
        irpStatus: "PENDING",
        autoGenerated: false,
        issuedAt: body.issueImmediately ? new Date() : null,
        dueDate: body.dueDate,
        billingCycleStart: body.billingCycleStart ?? null,
        billingCycleEnd: body.billingCycleEnd ?? null,
        // #768 — line items as typed children (createMany inside the
        // same transaction so a failed write rolls back atomically).
        lineItems: {
          create: body.items.map((item, idx) => ({
            position: idx,
            description: item.description,
            quantity: item.quantity,
            unitPricePaise: item.unitPrice,
            paymentId: item.paymentId ?? null,
          })),
        },
      },
    });

    if (body.issueImmediately) {
      await tx.settlementLedgerEntry.create({
        data: {
          organizationId: orgId,
          invoiceId: created.id,
          kind: "INVOICE_ISSUED",
          amountPaise: created.totalPaise,
          currency: body.displayCurrency,
        },
      });
    }

    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "INVOICE",
        action: AUDIT_ACTIONS.INVOICE.INVOICE_GENERATED,
        description: `${body.issueImmediately ? "Issued" : "Drafted"} invoice ${invoiceNumber}`,
        details: {
          invoiceId: created.id,
          invoiceNumber,
          totalPaise: created.totalPaise,
          status: created.status,
          placeOfSupply: created.placeOfSupply,
        },
      },
    });

    // Outbound webhook only on ISSUED transitions; a DRAFT invoice
    // hasn't been "sent" yet — integrators should only see invoices
    // they need to act on (booking entries, AP queues). Resending on
    // a later DRAFT→ISSUED PATCH happens in the [invoiceId] route.
    if (body.issueImmediately) {
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

    return created;
    });
  } catch (err) {
    const httpStatus =
      err && typeof err === "object" && "httpStatus" in err
        ? (err as { httpStatus: number }).httpStatus
        : null;
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code: string }).code
        : null;
    if (httpStatus && code) {
      return NextResponse.json(
        { error: (err as Error).message, code },
        { status: httpStatus },
      );
    }
    throw err;
  }

  // Side-effect: if the invoice was issued on creation, fire the Novu
  // bell workflow so OWNERs see it immediately (email delivery is via
  // the `billingEmail` channel configured on the workflow in Novu).
  if (body.issueImmediately) {
    const origin = new URL(req.url).origin;
    notifyOrgInvoiceIssued(orgId, {
      invoiceNumber: invoice.invoiceNumber,
      orgName: org.name,
      totalPaise: invoice.totalPaise,
      currency: body.displayCurrency,
      dueDate: body.dueDate.toISOString(),
      dashboardUrl: `${origin}/dashboard/organization/${orgId}/billing`,
    }).catch((err) =>
      console.error("[notifyOrgInvoiceIssued] failed:", err),
    );
  }

  return NextResponse.json({ invoice }, { status: 201 });
}

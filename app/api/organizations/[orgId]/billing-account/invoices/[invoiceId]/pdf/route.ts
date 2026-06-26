/**
 * GET /api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pdf
 *
 * Lazy invoice-PDF endpoint. On the first request, renders the invoice
 * via `@react-pdf/renderer`, uploads to Supabase Storage, caches the
 * path + timestamp on `OrganizationInvoice.pdfStoragePath` /
 * `pdfGeneratedAt`, and redirects the caller to a 24h signed URL.
 * Subsequent requests reuse the cache.
 *
 * Cache invalidation: when the invoice transitions to REFUNDED / VOID /
 * CANCELLED, the status-change route clears both cache columns so the
 * next download regenerates against the new state. We also treat a
 * cached PDF older than the signed-URL TTL (24h) as stale and force
 * regeneration so the signed URL handed back is always fresh.
 *
 * Auth: MAINTAINER+ per the billing-account pattern used elsewhere in
 * the org routes — any member with billing visibility can download.
 * OWNER-only isn't required because the PDF doesn't expose new data —
 * the contents are the same invoice row already readable via the
 * existing /invoices list endpoint.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  renderOrgInvoicePdf,
  type OrgInvoicePdfData,
  type OrgInvoiceLineItem,
} from "@/lib/pdf/invoice-renderer";
import {
  pdfStoragePathFor,
  uploadInvoicePdf,
  createInvoicePdfSignedUrl,
} from "@/lib/pdf/storage";

const PDF_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — matches signed-URL TTL

// Platform-side supplier info for the invoice PDF. Kept here (not in
// .env) so it's diffable in the repo; swap for an env-driven lookup
// when we need per-region suppliers (RTN INDIA vs platform entity in
// a future GCC expansion).
const SUPPLIER = {
  name: "Familiarise Technologies Private Limited",
  gstin: process.env.PLATFORM_GSTIN ?? "29AAFCF1234Q1ZN",
  address:
    "Koramangala 1st Block, Bangalore, Karnataka 560034, India",
  email: "billing@familiarise.com",
} as const;

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; invoiceId: string }>;
  },
) {
  const { orgId, invoiceId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  const invoice = await prisma.organizationInvoice.findFirst({
    where: { id: invoiceId, organizationId: orgId },
    include: {
      organization: {
        select: {
          name: true,
          billingEmail: true,
          taxInfo: { select: { gstin: true } },
        },
      },
      lineItems: { orderBy: { position: "asc" } },
    },
  });
  if (!invoice) {
    return NextResponse.json(
      { error: "Invoice not found" },
      { status: 404 },
    );
  }

  // DRAFT invoices aren't legally issued — refuse the PDF until ISSUED
  // or later. Otherwise a finance team could circulate an unissued PDF
  // that we'd later have to reconcile.
  if (invoice.status === "DRAFT") {
    return NextResponse.json(
      {
        error:
          "Invoice is still in DRAFT. Issue the invoice before generating a PDF.",
        code: "INVOICE_NOT_ISSUED",
      },
      { status: 409 },
    );
  }

  const now = Date.now();
  const cachedIsFresh =
    invoice.pdfStoragePath &&
    invoice.pdfGeneratedAt &&
    now - invoice.pdfGeneratedAt.getTime() < PDF_CACHE_TTL_MS;

  try {
    if (cachedIsFresh && invoice.pdfStoragePath) {
      // Re-sign the URL without re-rendering. `createSignedUrl` is cheap
      // (single Supabase API call, no storage write).
      const url = await createInvoicePdfSignedUrl(invoice.pdfStoragePath);
      return NextResponse.redirect(url, { status: 302 });
    }

    // Render path — assemble data, render, upload, cache, redirect.
    const items: OrgInvoiceLineItem[] = invoice.lineItems.map((row) => ({
      description: row.description,
      quantity: row.quantity,
      unitPrice: row.unitPricePaise,
      paymentId: row.paymentId,
      hsnCode: row.hsnCode,
    }));
    const data: OrgInvoicePdfData = {
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      displayCurrency: invoice.displayCurrency,
      subtotalPaise: invoice.subtotalPaise,
      igstPaise: invoice.igstPaise,
      cgstPaise: invoice.cgstPaise,
      sgstPaise: invoice.sgstPaise,
      totalPaise: invoice.totalPaise,
      hsnCode: invoice.hsnCode,
      placeOfSupply: invoice.placeOfSupply,
      gstin: invoice.gstin,
      reverseCharge: invoice.reverseCharge,
      issuedAt: invoice.issuedAt,
      dueDate: invoice.dueDate,
      paidAt: invoice.paidAt,
      billingCycleStart: invoice.billingCycleStart,
      billingCycleEnd: invoice.billingCycleEnd,
      items,
      org: {
        name: invoice.organization.name,
        gstin: invoice.organization.taxInfo?.gstin ?? null,
        billingEmail: invoice.organization.billingEmail,
      },
      supplier: SUPPLIER,
      irn: {
        value: invoice.irn,
        ackNumber: invoice.ackNumber,
        ackDate: invoice.ackDate,
        irpStatus: invoice.irpStatus,
      },
    };

    const buffer = await renderOrgInvoicePdf(data);
    const storagePath = pdfStoragePathFor(orgId, invoiceId);
    await uploadInvoicePdf({ storagePath, buffer });

    await prisma.organizationInvoice.update({
      where: { id: invoiceId },
      data: {
        pdfStoragePath: storagePath,
        pdfGeneratedAt: new Date(),
      },
    });

    const url = await createInvoicePdfSignedUrl(storagePath);
    return NextResponse.redirect(url, { status: 302 });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "invoice_pdf_render_failed",
        invoiceId,
        orgId,
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "organizations" } });
    return NextResponse.json(
      {
        error: "Failed to generate invoice PDF",
        details: err instanceof Error ? err.message : undefined,
      },
      { status: 500 },
    );
  }
}


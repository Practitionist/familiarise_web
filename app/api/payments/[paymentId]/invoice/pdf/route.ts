/**
 * GET /api/payments/[paymentId]/invoice/pdf — #1365
 *
 * The buyer's copy of their B2C tax invoice. Cloned from the org invoice PDF
 * route and kept on the same contract: render lazily on the first request,
 * upload to the private bucket, cache the path plus timestamp on the row, and
 * hand back a 24h signed URL by 302. A cached PDF older than that TTL is
 * treated as stale so the URL handed out is always freshly signed.
 *
 * Auth: the payment's own buyer, or an ADMIN/STAFF operator handling a support
 * request. There is no org membership to lean on here, so ownership is the
 * whole rule.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import { applyRateLimit, moneyOpsLimiter } from "@/lib/rate-limit";
import {
  renderConsumerInvoicePdf,
  type ConsumerInvoicePdfData,
} from "@/lib/pdf/invoice-renderer";
import {
  consumerPdfStoragePathFor,
  uploadInvoicePdf,
  createInvoicePdfSignedUrl,
} from "@/lib/pdf/storage";
import { getPlatformSupplier } from "@/lib/pdf/supplier";

const PDF_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — matches signed-URL TTL

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  const { paymentId } = await params;

  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate-limited per actor: rendering a PDF is expensive, and the bucket is
  // shared with the other money operations this user can trigger.
  const limited = await applyRateLimit(moneyOpsLimiter, session.user.id);
  if (limited) return limited;

  // Fail closed on supplier identity (#1132/#1230): a tax invoice carrying a
  // fabricated GSTIN is worse than no download at all.
  const supplier = getPlatformSupplier();
  if (!supplier) {
    return NextResponse.json(
      {
        error:
          "PLATFORM_GSTIN is not configured; the platform cannot issue statutory documents.",
        code: "SUPPLIER_GSTIN_UNCONFIGURED",
      },
      { status: 503 },
    );
  }

  const invoice = await prisma.consumerInvoice.findUnique({
    where: { paymentId },
    select: {
      id: true,
      userId: true,
      invoiceNumber: true,
      issuedAt: true,
      supplyDate: true,
      currency: true,
      sacCode: true,
      taxRateBps: true,
      taxableValuePaise: true,
      cgstPaise: true,
      sgstPaise: true,
      igstPaise: true,
      totalPaise: true,
      placeOfSupply: true,
      placeOfSupplySource: true,
      supplierName: true,
      supplierGstin: true,
      supplierAddress: true,
      supplierStateCode: true,
      buyerName: true,
      buyerEmail: true,
      buyerAddress: true,
      buyerStateCode: true,
      pdfStoragePath: true,
      pdfGeneratedAt: true,
    },
  });

  if (!invoice) {
    return NextResponse.json(
      {
        error: "No tax invoice has been issued for this payment.",
        code: "INVOICE_NOT_ISSUED",
      },
      { status: 404 },
    );
  }

  if (invoice.userId !== session.user.id && !isPrivileged(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const now = Date.now();
  const cachedIsFresh =
    invoice.pdfStoragePath &&
    invoice.pdfGeneratedAt &&
    now - invoice.pdfGeneratedAt.getTime() < PDF_CACHE_TTL_MS;

  try {
    if (cachedIsFresh && invoice.pdfStoragePath) {
      const url = await createInvoicePdfSignedUrl(invoice.pdfStoragePath);
      return NextResponse.redirect(url, { status: 302 });
    }

    // The document is rendered from its own stored snapshot, not from live
    // supplier/buyer rows — a tax invoice must keep saying what it said on the
    // day it was issued.
    const data: ConsumerInvoicePdfData = {
      invoiceNumber: invoice.invoiceNumber,
      issuedAt: invoice.issuedAt,
      supplyDate: invoice.supplyDate,
      currency: invoice.currency,
      sacCode: invoice.sacCode,
      taxRateBps: invoice.taxRateBps,
      taxableValuePaise: invoice.taxableValuePaise,
      cgstPaise: invoice.cgstPaise,
      sgstPaise: invoice.sgstPaise,
      igstPaise: invoice.igstPaise,
      totalPaise: invoice.totalPaise,
      placeOfSupply: invoice.placeOfSupply,
      placeOfSupplySource: invoice.placeOfSupplySource,
      supplier: {
        name: invoice.supplierName,
        gstin: invoice.supplierGstin,
        address: invoice.supplierAddress,
        stateCode: invoice.supplierStateCode,
      },
      buyer: {
        name: invoice.buyerName,
        email: invoice.buyerEmail,
        address: invoice.buyerAddress,
        stateCode: invoice.buyerStateCode,
      },
    };

    const buffer = await renderConsumerInvoicePdf(data);
    const storagePath = consumerPdfStoragePathFor(invoice.userId, invoice.id);
    await uploadInvoicePdf({ storagePath, buffer });

    await prisma.consumerInvoice.update({
      where: { id: invoice.id },
      data: { pdfStoragePath: storagePath, pdfGeneratedAt: new Date() },
    });

    const url = await createInvoicePdfSignedUrl(storagePath);
    return NextResponse.redirect(url, { status: 302 });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "consumer_invoice_pdf_render_failed",
        paymentId,
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "payments" } },
    );
    return NextResponse.json(
      { error: "Failed to generate the tax invoice PDF" },
      { status: 500 },
    );
  }
}

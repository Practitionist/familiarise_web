/**
 * GET /api/payments/[paymentId]/credit-note/[creditNoteId]/pdf — #1365
 *
 * The buyer's copy of the s.34 credit note that reverses their tax invoice
 * after a refund or a lost chargeback. Same contract as the invoice route it
 * is cloned from: owner-or-operator auth, rate limit, fail-closed supplier
 * identity, 24h render cache, 302 to a signed URL.
 *
 * The credit note is nested under the payment so the caller cannot enumerate
 * documents by id alone — the note must belong to the invoice for that payment.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import { applyRateLimit, moneyOpsLimiter } from "@/lib/rate-limit";
import {
  renderConsumerCreditNotePdf,
  type ConsumerCreditNotePdfData,
} from "@/lib/pdf/credit-note-renderer";
import {
  consumerPdfStoragePathFor,
  uploadInvoicePdf,
  createInvoicePdfSignedUrl,
} from "@/lib/pdf/storage";
import { getPlatformSupplier } from "@/lib/pdf/supplier";

const PDF_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — matches signed-URL TTL

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ paymentId: string; creditNoteId: string }> },
) {
  const { paymentId, creditNoteId } = await params;

  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await applyRateLimit(moneyOpsLimiter, session.user.id);
  if (limited) return limited;

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

  const creditNote = await prisma.consumerCreditNote.findFirst({
    where: { id: creditNoteId, consumerInvoice: { paymentId } },
    select: {
      id: true,
      creditNoteNumber: true,
      issuedAt: true,
      reason: true,
      taxableValuePaise: true,
      cgstPaise: true,
      sgstPaise: true,
      igstPaise: true,
      totalPaise: true,
      pdfStoragePath: true,
      pdfGeneratedAt: true,
      consumerInvoice: {
        select: {
          userId: true,
          invoiceNumber: true,
          issuedAt: true,
          currency: true,
          sacCode: true,
          placeOfSupply: true,
          supplierName: true,
          supplierGstin: true,
          supplierAddress: true,
          supplierStateCode: true,
          buyerName: true,
          buyerEmail: true,
          buyerAddress: true,
          buyerStateCode: true,
        },
      },
    },
  });

  if (!creditNote) {
    return NextResponse.json(
      {
        error: "No credit note has been issued for this payment.",
        code: "INVOICE_NOT_ISSUED",
      },
      { status: 404 },
    );
  }

  const invoice = creditNote.consumerInvoice;
  if (invoice.userId !== session.user.id && !isPrivileged(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const now = Date.now();
  const cachedIsFresh =
    creditNote.pdfStoragePath &&
    creditNote.pdfGeneratedAt &&
    now - creditNote.pdfGeneratedAt.getTime() < PDF_CACHE_TTL_MS;

  try {
    if (cachedIsFresh && creditNote.pdfStoragePath) {
      const url = await createInvoicePdfSignedUrl(creditNote.pdfStoragePath);
      return NextResponse.redirect(url, { status: 302 });
    }

    const data: ConsumerCreditNotePdfData = {
      creditNoteNumber: creditNote.creditNoteNumber,
      issuedAt: creditNote.issuedAt,
      reason: creditNote.reason,
      currency: invoice.currency,
      taxableValuePaise: creditNote.taxableValuePaise,
      cgstPaise: creditNote.cgstPaise,
      sgstPaise: creditNote.sgstPaise,
      igstPaise: creditNote.igstPaise,
      totalPaise: creditNote.totalPaise,
      originalInvoiceNumber: invoice.invoiceNumber,
      originalInvoiceDate: invoice.issuedAt,
      placeOfSupply: invoice.placeOfSupply,
      sacCode: invoice.sacCode,
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

    const buffer = await renderConsumerCreditNotePdf(data);
    const storagePath = consumerPdfStoragePathFor(
      invoice.userId,
      creditNote.id,
    );
    await uploadInvoicePdf({ storagePath, buffer });

    await prisma.consumerCreditNote.update({
      where: { id: creditNote.id },
      data: { pdfStoragePath: storagePath, pdfGeneratedAt: new Date() },
    });

    const url = await createInvoicePdfSignedUrl(storagePath);
    return NextResponse.redirect(url, { status: 302 });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "consumer_credit_note_pdf_render_failed",
        paymentId,
        creditNoteId,
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "payments" } },
    );
    return NextResponse.json(
      { error: "Failed to generate the credit note PDF" },
      { status: 500 },
    );
  }
}

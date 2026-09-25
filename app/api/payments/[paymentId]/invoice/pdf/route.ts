/**
 * GET /api/payments/[paymentId]/invoice/pdf — #1365
 *
 * The buyer's copy of their B2C tax invoice. Auth, rate limiting, the
 * fail-closed supplier gate, the 24-hour render cache and the redirect to a
 * signed URL all live in `serveConsumerPdf`, which the credit-note route
 * shares; this file only says which row to load, how to render it, and where
 * to stamp the cache.
 *
 * Access is the payment's own buyer, or an ADMIN/STAFF operator handling a
 * support request. There is no org membership to lean on here, so ownership is
 * the whole rule.
 */

import { type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  renderConsumerInvoicePdf,
  type ConsumerInvoicePdfData,
} from "@/lib/pdf/invoice-renderer";
import { serveConsumerPdf } from "@/lib/pdf/serve-consumer-pdf";
import { sessionsBoughtLabel } from "@/lib/booking/class-enrolment";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  const { paymentId } = await params;

  return serveConsumerPdf({
    event: "consumer_invoice_pdf_render_failed",
    logContext: { paymentId },
    failureMessage: "Failed to generate the tax invoice PDF",
    load: async () => {
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
          // #1819 — a class seat's line names the sessions it bought.
          payment: {
            select: {
              appointment: {
                select: {
                  class: {
                    select: {
                      classPlan: {
                        select: { title: true, totalSessions: true },
                      },
                    },
                  },
                },
              },
              appointmentParticipants: {
                where: { sessionsPurchased: { not: null } },
                select: { sessionsPurchased: true },
                take: 1,
              },
            },
          },
        },
      });
      return invoice ? { ...invoice, ownerUserId: invoice.userId } : null;
    },
    render: (invoice) => {
      // Rendered from the row's own stored snapshot, not from live supplier or
      // buyer records — a tax invoice must keep saying what it said on the day
      // it was issued.
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
        description: classLineDescription(invoice.payment),
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
      return renderConsumerInvoicePdf(data);
    },
    stamp: async ({ id, pdfStoragePath, pdfGeneratedAt }) => {
      await prisma.consumerInvoice.update({
        where: { id },
        data: { pdfStoragePath, pdfGeneratedAt },
      });
    },
  });
}

type InvoicePaymentLine = {
  appointment: {
    class: { classPlan: { title: string; totalSessions: number } } | null;
  } | null;
  appointmentParticipants: { sessionsPurchased: number | null }[];
};

/** "Yoga basics — Sessions 3–8 of 8"; null keeps the generic supply line. */
function classLineDescription(payment: InvoicePaymentLine): string | null {
  const plan = payment.appointment?.class?.classPlan;
  const bought = payment.appointmentParticipants[0]?.sessionsPurchased;
  if (!plan || !bought) return null;
  return `${plan.title} — ${sessionsBoughtLabel(bought, plan.totalSessions)}`;
}

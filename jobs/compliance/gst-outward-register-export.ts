/**
 * Outward-supplies register export (#1370) — the monthly GSTR-1 working file.
 *
 * Runs in hourly slices on the 2nd of each month for the previous IST calendar
 * month, ahead of the 11th filing deadline. Three things happen, in order:
 *
 *   1. A healer mints the consumer tax invoice for up to `limit` SUCCEEDED
 *      payments in the period that never got one, because a mint is
 *      deliberately allowed to fail silently at checkout rather than roll back
 *      a confirmed booking.
 *   2. Every invoice and credit note issued in the period, B2B and B2C, is
 *      read and shaped into one register, and the CSV is uploaded to the
 *      private finance bucket at a path fixed by the period, so a re-run
 *      overwrites it.
 *   3. Only after that upload succeeds, the reported documents are stamped
 *      with `gstr1ExportedAt` so a re-run does not re-stamp them. The CSV is
 *      always a full-period snapshot, so the stamp is a reporting marker,
 *      never a filter on what gets exported.
 *
 * The output carries no PAN, no bank detail and no buyer address — only what
 * a GSTR-1 line needs.
 */

import prisma from "@/lib/prisma";
import * as Sentry from "@sentry/nextjs";
import {
  GST_UNREGISTERED_SKIP,
  reportConfigSkip,
  type ConfigSkip,
} from "@/lib/cron/config-skip";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import {
  buildOutwardRegister,
  buildOutwardRegisterCsv,
  gstOutwardRegisterCsvStoragePath,
  type OutwardRegisterRow,
} from "@/lib/compliance/gst-outward-register";
import {
  CONSUMER_INVOICEABLE_PAYMENT_WHERE,
  mintConsumerInvoice,
} from "@/lib/payments/billing/consumer-invoice";
import { uploadPrivateFinanceObject } from "@/lib/storage/private-finance-object";
import { isUniqueViolationOn } from "@/lib/db/unique-violation";
import { platformSupplierForJob } from "@/lib/pdf/supplier";
import {
  previousIstCalendarMonthStart,
  nextMonthStart,
  istMonthStart,
} from "@/lib/compliance/ist-period";

/** Statuses that mean the org invoice was never actually issued to a buyer, so
 *  it is not an outward supply for the period. */
const UNISSUED_ORG_INVOICE_STATUSES = ["DRAFT", "VOID", "CANCELLED"] as const;

/** The requested `YYYY-MM` month, else the previous calendar month in IST. */
function resolvePeriod(period?: string): {
  periodStart: Date;
  periodEnd: Date;
} {
  const periodStart = period
    ? istMonthStart(period)
    : previousIstCalendarMonthStart();
  return { periodStart, periodEnd: nextMonthStart(periodStart) };
}

/**
 * Mint the consumer invoice for up to `limit` SUCCEEDED, non-deleted payments
 * in the period that still have none, oldest first. A minted payment leaves the
 * cohort, so successive slices drain it. Each mint runs in its own short
 * transaction so one unmintable payment cannot abort the rest of the sweep.
 */
async function ensureConsumerInvoicesForPeriod(
  periodStart: Date,
  periodEnd: Date,
  limit: number,
): Promise<{ minted: number; skipped: number }> {
  const candidates = await prisma.payment.findMany({
    where: {
      ...CONSUMER_INVOICEABLE_PAYMENT_WHERE,
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
      createdAt: { gte: periodStart, lt: periodEnd },
      consumerInvoice: null,
    },
    select: { id: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
  });

  let minted = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    try {
      const result = await prisma.$transaction((tx) =>
        mintConsumerInvoice(tx, { paymentId: candidate.id }),
      );
      if (result.consumerInvoiceId) minted += 1;
      else skipped += 1;
    } catch (error) {
      // Another minter won this payment; its number rolled back with the loser.
      if (!isUniqueViolationOn(error, "paymentId")) throw error;
    }
  }
  return { minted, skipped };
}

async function collectRows(
  periodStart: Date,
  periodEnd: Date,
): Promise<OutwardRegisterRow[]> {
  const [consumerInvoices, orgInvoices, consumerCreditNotes, orgCreditNotes] =
    await Promise.all([
      prisma.consumerInvoice.findMany({
        where: { issuedAt: { gte: periodStart, lt: periodEnd } },
        select: {
          invoiceNumber: true,
          issuedAt: true,
          supplyDate: true,
          placeOfSupply: true,
          taxableValuePaise: true,
          cgstPaise: true,
          sgstPaise: true,
          igstPaise: true,
          totalPaise: true,
          sacCode: true,
          paymentId: true,
          needsBuyerAddress: true,
        },
        orderBy: { issuedAt: "asc" },
      }),
      prisma.organizationInvoice.findMany({
        where: {
          issuedAt: { gte: periodStart, lt: periodEnd },
          status: { notIn: [...UNISSUED_ORG_INVOICE_STATUSES] },
        },
        select: {
          invoiceNumber: true,
          issuedAt: true,
          placeOfSupply: true,
          gstin: true,
          subtotalPaise: true,
          cgstPaise: true,
          sgstPaise: true,
          igstPaise: true,
          totalPaise: true,
          hsnCode: true,
          paymentId: true,
        },
        orderBy: { issuedAt: "asc" },
      }),
      prisma.consumerCreditNote.findMany({
        where: {
          issuedAt: { gte: periodStart, lt: periodEnd },
          isCommercial: false,
        },
        select: {
          creditNoteNumber: true,
          issuedAt: true,
          taxableValuePaise: true,
          cgstPaise: true,
          sgstPaise: true,
          igstPaise: true,
          totalPaise: true,
          consumerInvoice: {
            select: {
              invoiceNumber: true,
              supplyDate: true,
              placeOfSupply: true,
              sacCode: true,
              paymentId: true,
              needsBuyerAddress: true,
            },
          },
        },
        orderBy: { issuedAt: "asc" },
      }),
      prisma.creditNote.findMany({
        where: {
          status: "ISSUED",
          issuedAt: { gte: periodStart, lt: periodEnd },
          isCommercial: false,
        },
        select: {
          creditNoteNumber: true,
          issuedAt: true,
          subtotalPaise: true,
          cgstPaise: true,
          sgstPaise: true,
          igstPaise: true,
          totalPaise: true,
          invoice: {
            select: {
              invoiceNumber: true,
              issuedAt: true,
              placeOfSupply: true,
              gstin: true,
              hsnCode: true,
              paymentId: true,
            },
          },
        },
        orderBy: { issuedAt: "asc" },
      }),
    ]);

  const rows: OutwardRegisterRow[] = [];

  for (const inv of consumerInvoices) {
    rows.push({
      docType: "INVOICE",
      docNumber: inv.invoiceNumber,
      docDate: inv.issuedAt,
      supplyDate: inv.supplyDate,
      buyerType: "B2C",
      buyerGstin: null,
      placeOfSupply: inv.placeOfSupply,
      taxablePaise: inv.taxableValuePaise,
      cgstPaise: inv.cgstPaise,
      sgstPaise: inv.sgstPaise,
      igstPaise: inv.igstPaise,
      totalPaise: inv.totalPaise,
      sacCode: inv.sacCode,
      originalInvoiceNumber: null,
      paymentId: inv.paymentId,
      needsBuyerAddress: inv.needsBuyerAddress,
    });
  }

  for (const inv of orgInvoices) {
    rows.push({
      docType: "INVOICE",
      docNumber: inv.invoiceNumber,
      // An issued invoice always carries `issuedAt`; the column is nullable
      // only because DRAFT rows exist, and those are filtered out above.
      docDate: inv.issuedAt ?? new Date(0),
      supplyDate: inv.issuedAt,
      buyerType: "B2B",
      buyerGstin: inv.gstin,
      placeOfSupply: inv.placeOfSupply,
      taxablePaise: inv.subtotalPaise,
      cgstPaise: inv.cgstPaise,
      sgstPaise: inv.sgstPaise,
      igstPaise: inv.igstPaise,
      totalPaise: inv.totalPaise,
      sacCode: inv.hsnCode,
      originalInvoiceNumber: null,
      paymentId: inv.paymentId,
      needsBuyerAddress: false,
    });
  }

  for (const note of consumerCreditNotes) {
    rows.push({
      docType: "CREDIT_NOTE",
      docNumber: note.creditNoteNumber,
      docDate: note.issuedAt,
      supplyDate: note.consumerInvoice.supplyDate,
      buyerType: "B2C",
      buyerGstin: null,
      placeOfSupply: note.consumerInvoice.placeOfSupply,
      taxablePaise: note.taxableValuePaise,
      cgstPaise: note.cgstPaise,
      sgstPaise: note.sgstPaise,
      igstPaise: note.igstPaise,
      totalPaise: note.totalPaise,
      sacCode: note.consumerInvoice.sacCode,
      originalInvoiceNumber: note.consumerInvoice.invoiceNumber,
      paymentId: note.consumerInvoice.paymentId,
      needsBuyerAddress: note.consumerInvoice.needsBuyerAddress,
    });
  }

  for (const note of orgCreditNotes) {
    rows.push({
      docType: "CREDIT_NOTE",
      docNumber: note.creditNoteNumber,
      docDate: note.issuedAt ?? new Date(0),
      supplyDate: note.invoice?.issuedAt ?? null,
      buyerType: "B2B",
      buyerGstin: note.invoice?.gstin ?? null,
      placeOfSupply: note.invoice?.placeOfSupply ?? null,
      taxablePaise: note.subtotalPaise,
      cgstPaise: note.cgstPaise,
      sgstPaise: note.sgstPaise,
      igstPaise: note.igstPaise,
      totalPaise: note.totalPaise,
      sacCode: note.invoice?.hsnCode ?? "999293",
      originalInvoiceNumber: note.invoice?.invoiceNumber ?? null,
      paymentId: note.invoice?.paymentId ?? null,
      needsBuyerAddress: false,
    });
  }

  return rows;
}

export interface GstOutwardRegisterExportResult {
  success: boolean;
  period: string;
  storagePath: string;
  mintedByHealer: number;
  skippedByHealer: number;
  documentCount: number;
  warnings: number;
  skipped?: ConfigSkip;
}

/**
 * The locked export, driven by the `/api/cleanup/gst-outward-register-export`
 * twin; `cleanupRoute` applies the maintenance guard.
 *
 * @param opts.limit Payments the invoice healer may mint in this run.
 * @param opts.period Optional `YYYY-MM` IST month; defaults to the previous one.
 */
export async function runGstOutwardRegisterExport(opts: {
  limit: number;
  period?: string;
}): Promise<GstOutwardRegisterExportResult> {
  // Without a supplier no consumer invoice can be minted, so a register would
  // understate B2C supplies: an unset GSTIN skips, an unusable one throws.
  if (!platformSupplierForJob()) {
    const skipped = GST_UNREGISTERED_SKIP;
    reportConfigSkip("gst-outward-register-export", skipped);
    return {
      success: true,
      period: "",
      storagePath: "",
      mintedByHealer: 0,
      skippedByHealer: 0,
      documentCount: 0,
      warnings: 0,
      skipped,
    };
  }
  // Fail-CLOSED, unlike the read-only compliance drafts. The healer inside
  // allocates numbers from a gapless statutory series, and two concurrent
  // runs would both probe a payment as un-invoiced, both take a number, and
  // one would lose the unique — leaving a permanent gap in the series. Not
  // producing the register is recoverable; a gap is not.
  return await withCronLock(
    "gst-outward-register-export",
    { failMode: "closed" },
    async () => {
      const { periodStart, periodEnd } = resolvePeriod(opts.period);

      const healed = await ensureConsumerInvoicesForPeriod(
        periodStart,
        periodEnd,
        opts.limit,
      );
      if (healed.minted > 0) {
        console.warn(
          `[gst-register] WARN minted ${healed.minted} consumer invoice(s) that checkout did not — ` +
            `investigate the mint path if this count stays non-zero.`,
        );
        Sentry.logger.warn("job:gst-register-healed-invoices", {
          minted: healed.minted,
        });
      }

      const rows = await collectRows(periodStart, periodEnd);
      const register = buildOutwardRegister(rows, periodStart, periodEnd);

      // Commercial notes reverse no tax, so they are not GSTR-1 documents.
      const periodIssued = { gte: periodStart, lt: periodEnd };
      const commercialNotes =
        (await prisma.consumerCreditNote.count({
          where: { issuedAt: periodIssued, isCommercial: true },
        })) +
        (await prisma.creditNote.count({
          where: {
            status: "ISSUED",
            issuedAt: periodIssued,
            isCommercial: true,
          },
        }));
      if (commercialNotes > 0) {
        console.warn(
          `[gst-register] WARN ${commercialNotes} commercial credit note(s) issued past the s.34(2) cutoff were left out of the register`,
        );
      }

      const storagePath = gstOutwardRegisterCsvStoragePath(
        periodStart,
        periodEnd,
      );
      await uploadPrivateFinanceObject({
        storagePath,
        body: Buffer.from(buildOutwardRegisterCsv(register.rows), "utf8"),
        contentType: "text/csv; charset=utf-8",
      });

      for (const warning of register.warnings) {
        console.warn(`[gst-register] WARN ${warning}`);
      }
      if (register.warnings.length > 0) {
        Sentry.logger.warn("job:gst-register-warnings", {
          period: register.periodLabel,
          count: register.warnings.length,
        });
      }

      // Stamp what was uploaded, in one transaction, guarded on the stamp being
      // null — so a second run in the same month reports the same documents
      // again without moving anyone's first-reported timestamp.
      const stampedAt = new Date();
      const periodWindow = { gte: periodStart, lt: periodEnd };
      await prisma.$transaction([
        prisma.consumerInvoice.updateMany({
          where: { issuedAt: periodWindow, gstr1ExportedAt: null },
          data: { gstr1ExportedAt: stampedAt },
        }),
        prisma.organizationInvoice.updateMany({
          where: {
            issuedAt: periodWindow,
            status: { notIn: [...UNISSUED_ORG_INVOICE_STATUSES] },
            gstr1ExportedAt: null,
          },
          data: { gstr1ExportedAt: stampedAt },
        }),
        prisma.consumerCreditNote.updateMany({
          where: {
            issuedAt: periodWindow,
            isCommercial: false,
            gstr1ExportedAt: null,
          },
          data: { gstr1ExportedAt: stampedAt },
        }),
        prisma.creditNote.updateMany({
          where: {
            status: "ISSUED",
            issuedAt: periodWindow,
            isCommercial: false,
            gstr1ExportedAt: null,
          },
          data: { gstr1ExportedAt: stampedAt },
        }),
      ]);

      // One summary line, no PII: counts and totals only.
      console.log(
        JSON.stringify({
          event: "gst_outward_register_exported",
          period: register.periodLabel,
          storagePath,
          mintedByHealer: healed.minted,
          skippedByHealer: healed.skipped,
          ...register.totals,
          commercialNotesExcluded: commercialNotes,
          warnings: register.warnings.length,
        }),
      );

      return {
        success: true,
        period: register.periodLabel,
        storagePath,
        mintedByHealer: healed.minted,
        skippedByHealer: healed.skipped,
        documentCount: register.totals.documentCount,
        warnings: register.warnings.length,
      };
    },
  );
}

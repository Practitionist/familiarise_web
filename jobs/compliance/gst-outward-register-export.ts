/**
 * Outward-supplies register export (#1370) — the monthly GSTR-1 working file.
 *
 * Runs on the 3rd of each month for the previous IST calendar month, ahead of
 * the 11th filing deadline. Three things happen, in order:
 *
 *   1. A healer mints the consumer tax invoice for any SUCCEEDED payment in
 *      the period that never got one, because a mint is deliberately allowed
 *      to fail silently at checkout rather than roll back a confirmed booking.
 *   2. Every invoice and credit note issued in the period, B2B and B2C, is
 *      read and shaped into one register, and the CSV is written to disk for
 *      the workflow to upload as an artifact.
 *   3. The reported documents are stamped with `gstr1ExportedAt` so a re-run
 *      does not re-stamp them. The CSV is always a full-period snapshot, so
 *      the stamp is a reporting marker, never a filter on what gets exported.
 *
 * The output carries no PAN, no bank detail and no buyer address — only what
 * a GSTR-1 line needs.
 */

import fs from "node:fs";

import { runJob } from "@/lib/observability/job-sentry";
import prisma from "@/lib/prisma";
import * as Sentry from "@sentry/nextjs";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import {
  buildOutwardRegister,
  buildOutwardRegisterCsv,
  type OutwardRegisterRow,
} from "@/lib/compliance/gst-outward-register";
import { mintConsumerInvoice } from "@/lib/payments/billing/consumer-invoice";

/** Statuses that mean the org invoice was never actually issued to a buyer, so
 *  it is not an outward supply for the period. */
const UNISSUED_ORG_INVOICE_STATUSES = ["DRAFT", "VOID", "CANCELLED"] as const;

/**
 * Parse a `YYYY-MM-DD` override into a UTC instant, rejecting anything else.
 * A silently-misparsed boundary would export the wrong month and the error
 * would only surface at filing time.
 */
function parsePeriodOverride(raw: string, envName: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${envName} must be a YYYY-MM-DD date; got "${raw}"`);
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${envName} is not a real date; got "${raw}"`);
  }
  return parsed;
}

function resolvePeriod(): { periodStart: Date; periodEnd: Date } {
  const startRaw = process.env.GST_REGISTER_PERIOD_START;
  const endRaw = process.env.GST_REGISTER_PERIOD_END;
  if (startRaw && endRaw) {
    const periodStart = parsePeriodOverride(
      startRaw,
      "GST_REGISTER_PERIOD_START",
    );
    const periodEnd = parsePeriodOverride(endRaw, "GST_REGISTER_PERIOD_END");
    if (periodEnd <= periodStart) {
      throw new Error(
        "GST_REGISTER_PERIOD_END must be after GST_REGISTER_PERIOD_START",
      );
    }
    return { periodStart, periodEnd };
  }
  if (startRaw || endRaw) {
    throw new Error(
      "GST_REGISTER_PERIOD_START and GST_REGISTER_PERIOD_END must be set together",
    );
  }
  // Default: the previous calendar month, reckoned in IST.
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const periodStart = new Date(
    Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth() - 1, 1),
  );
  const periodEnd = new Date(
    Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1),
  );
  return { periodStart, periodEnd };
}

/**
 * Mint the consumer invoice for every SUCCEEDED, non-deleted payment in the
 * period that still has none. Each mint runs in its own short transaction so
 * one unmintable payment cannot abort the rest of the sweep.
 */
async function ensureConsumerInvoicesForPeriod(
  periodStart: Date,
  periodEnd: Date,
): Promise<{ minted: number; skipped: number }> {
  const candidates = await prisma.payment.findMany({
    where: {
      paymentStatus: "SUCCEEDED",
      deletedAt: null,
      createdAt: { gte: periodStart, lt: periodEnd },
      consumerInvoice: null,
    },
    select: { id: true },
  });

  let minted = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const result = await prisma.$transaction((tx) =>
      mintConsumerInvoice(tx, { paymentId: candidate.id }),
    );
    if (result.consumerInvoiceId) minted += 1;
    else skipped += 1;
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
        where: { issuedAt: { gte: periodStart, lt: periodEnd } },
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

async function main() {
  runJob("gst-outward-register-export", async () => {
    await abortIfMaintenance("gst-outward-register-export");
    // Fail-CLOSED, unlike the read-only compliance drafts. The healer inside
    // allocates numbers from a gapless statutory series, and two concurrent
    // runs would both probe a payment as un-invoiced, both take a number, and
    // one would lose the unique — leaving a permanent gap in the series. Not
    // producing the register is recoverable; a gap is not.
    await withCronLock(
      "gst-outward-register-export",
      { failMode: "closed" },
      async () => {
        const { periodStart, periodEnd } = resolvePeriod();

        const healed = await ensureConsumerInvoicesForPeriod(
          periodStart,
          periodEnd,
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

        const outPath =
          process.env.GST_REGISTER_CSV_OUT ?? "gst-outward-register.csv";
        fs.writeFileSync(
          outPath,
          buildOutwardRegisterCsv(register.rows),
          "utf8",
        );

        for (const warning of register.warnings) {
          console.warn(`[gst-register] WARN ${warning}`);
        }
        if (register.warnings.length > 0) {
          Sentry.logger.warn("job:gst-register-warnings", {
            period: register.periodLabel,
            count: register.warnings.length,
          });
        }

        // Stamp what was reported, in one transaction, guarded on the stamp being
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
            where: { issuedAt: periodWindow, gstr1ExportedAt: null },
            data: { gstr1ExportedAt: stampedAt },
          }),
          prisma.creditNote.updateMany({
            where: {
              status: "ISSUED",
              issuedAt: periodWindow,
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
            csvPath: outPath,
            mintedByHealer: healed.minted,
            skippedByHealer: healed.skipped,
            ...register.totals,
            warnings: register.warnings.length,
          }),
        );
      },
    );
  });
}

main().catch((err) => {
  console.error("[gst-register] fatal:", err);
  process.exit(1);
});

/**
 * Cron: IRP (Invoice Registration Portal) uploader — Issue #681.
 *
 * STATUS: body live, env-gated. The cron iterates eligible invoices and
 * calls `lib/compliance/irp.generateIrn`. When `CLEARTAX_API_KEY`,
 * `CLEARTAX_GSP_TOKEN`, and `PLATFORM_GSTIN` are configured, the
 * connector posts the invoice payload to ClearTax GSP and persists
 * `irn`, `ackNumber`, `signedQrPayload`, `irpStatus`, plus retry
 * telemetry (`irpRetryCount`, `irpLastError`, `irpLastAttemptAt`).
 * When `PLATFORM_GSTIN` or any `CLEARTAX_*` setting is absent, the run
 * touches no invoice and returns `skipped: "<NAME> not configured"`; a set
 * but malformed or wrong-state `PLATFORM_GSTIN` throws.
 *
 * Production approval requires:
 *   1. Sandbox credentials provisioned and end-to-end tested
 *   2. Payload mapping validated against CBIC schema (HSN, GSTIN, amounts)
 *   3. 24-hour IRN cancellation window behaviour proven
 *   4. Accountant / legal sign-off on IRN format and invoice sequence
 *   5. Retry dashboard and ops runbook in place (see docs/enterprise/50-operations/02-runbooks.md)
 *
 * Schedule: the ticker's daily window from 03:00 UTC, in `limit`-sized slices.
 * Scope: B2B OrganizationInvoice (buyer GSTIN on the document) with
 *        irpStatus=PENDING, issuedAt within 30d (CBIC cut-off for retroactive
 *        IRN generation). B2C is exempt from e-invoicing. A windowed run skips
 *        invoices already attempted since the window start, so a retry is
 *        spent at most once a day.
 */

import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { generateIrn } from "@/lib/compliance/irp";
import { buildIrpPayload } from "@/lib/compliance/irp-payload";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import {
  GST_UNREGISTERED_SKIP,
  reportConfigSkip,
  type ConfigSkip,
} from "@/lib/cron/config-skip";
import * as Sentry from "@sentry/nextjs";
import { REGISTERED_OFFICE } from "@/lib/company";
import { platformSupplierForJob } from "@/lib/pdf/supplier";

/** The seller block: the legal entity in lib/company.ts with the gated GSTIN. */
type SellerIdentity = {
  gstin: string;
  legalName: string;
  address1: string;
  location: string;
  pincode: string;
  stateCode: string;
};

// #476 — entry-level cron lock, fail-closed: an IRN is a statutory object
// registered with the government and cancellable only inside a 24-hour window,
// so two runners both believing they hold the lock while Redis is unreachable
// is the one outcome this job may never risk.
export interface IrpUploaderResult {
  processed: number;
  failed: number;
  skippedRows: number;
  skipped?: ConfigSkip;
}

export async function runIrpUploader(opts: {
  limit?: number;
  windowStart?: Date;
}): Promise<IrpUploaderResult> {
  return withCronLock("irp-uploader", { failMode: "closed" }, () =>
    runIrpUploaderUnlocked(opts),
  );
}

/**
 * S3776 — NIC payload assembly extracted from the run loop. The candidate is
 * the fetched invoice row (with organization + lineItems); mapping failures
 * are the caller's concern.
 */
function buildPayloadFor(
  candidate: Awaited<ReturnType<typeof fetchIrpCandidates>>[number],
  seller: SellerIdentity,
) {
  return buildIrpPayload({
    invoice: {
      invoiceNumber: candidate.invoiceNumber,
      issuedAt: candidate.issuedAt,
      reverseCharge: candidate.reverseCharge,
      lutNumber: candidate.lutNumber,
      subtotalPaise: candidate.subtotalPaise,
      cgstPaise: candidate.cgstPaise,
      sgstPaise: candidate.sgstPaise,
      igstPaise: candidate.igstPaise,
      totalPaise: candidate.totalPaise,
      hsnCode: candidate.hsnCode,
      placeOfSupply: candidate.placeOfSupply,
    },
    lineItems: candidate.lineItems,
    buyer: {
      name: candidate.organization.name,
      gstin: candidate.organization.taxInfo?.gstin ?? null,
      stateCode: candidate.organization.taxInfo?.gstStateCode ?? null,
      hsnDefault: candidate.organization.taxInfo?.hsnDefault ?? "999293",
    },
    seller,
  });
}

/**
 * E-invoicing covers B2B supplies only: an invoice without the buyer's GSTIN is
 * B2C and exempt, so it is never submitted to the IRP.
 */
export function irpCandidateWhere(
  thirtyDaysAgo: Date,
): Prisma.OrganizationInvoiceWhereInput {
  return {
    irpStatus: "PENDING",
    issuedAt: { gte: thirtyDaysAgo, not: null },
    gstin: { not: null },
  };
}

function fetchIrpCandidates(
  thirtyDaysAgo: Date,
  opts: { limit?: number; windowStart?: Date },
) {
  return prisma.organizationInvoice.findMany({
    where: opts.windowStart
      ? {
          AND: [
            irpCandidateWhere(thirtyDaysAgo),
            {
              OR: [
                { irpLastAttemptAt: null },
                { irpLastAttemptAt: { lt: opts.windowStart } },
              ],
            },
          ],
        }
      : irpCandidateWhere(thirtyDaysAgo),
    // #703 — widen to everything the payload mapper needs (split paise,
    // place-of-supply, line items, buyer tax info). The mapper is pure;
    // the cron does the fetch.
    select: {
      id: true,
      invoiceNumber: true,
      issuedAt: true,
      reverseCharge: true,
      lutNumber: true,
      subtotalPaise: true,
      cgstPaise: true,
      sgstPaise: true,
      igstPaise: true,
      totalPaise: true,
      hsnCode: true,
      placeOfSupply: true,
      irpRetryCount: true,
      organization: {
        select: {
          name: true,
          taxInfo: {
            select: { gstin: true, gstStateCode: true, hsnDefault: true },
          },
        },
      },
      lineItems: {
        orderBy: { position: "asc" },
        select: {
          position: true,
          description: true,
          quantity: true,
          unitPricePaise: true,
          hsnCode: true,
        },
      },
    },
    // #1584 P2-P0-03 — oldest first so a backlog cannot starve an invoice
    // out of the 30-day window; the window and requeue policy are #1366's.
    orderBy: { issuedAt: "asc" },
    take: opts.limit ?? 50,
  });
}

/**
 * S3776 (CR #1234 r5) — one candidate's full lifecycle: map to NIC payload
 * (permanent failure on unmappable data), call the IRP, and persist the
 * resulting state. Returns the counter bucket for the caller's aggregates.
 */
async function processIrpCandidate(
  candidate: Awaited<ReturnType<typeof fetchIrpCandidates>>[number],
  seller: SellerIdentity,
): Promise<"processed" | "failed" | "skipped"> {
  const mapped = buildPayloadFor(candidate, seller);

  if (!mapped.ok) {
    await prisma.organizationInvoice.update({
      where: { id: candidate.id },
      data: {
        irpStatus: "FAILED", // permanent — do not loop
        irpLastError: `MAP: ${mapped.reason}`.slice(0, 500),
        irpLastAttemptAt: new Date(),
      },
    });
    return "failed";
  }

  const result = await generateIrn({
    invoiceId: candidate.id,
    payload: mapped.payload,
  });

  if (result.status === "GENERATED" && result.irn) {
    await prisma.organizationInvoice.update({
      where: { id: candidate.id },
      data: {
        irn: result.irn,
        ackNumber: result.ackNumber,
        ackDate: result.ackDate,
        signedQrPayload: result.signedQrPayload,
        irpStatus: "GENERATED",
        irpUploadedAt: new Date(),
        irpLastError: null,
        irpLastAttemptAt: new Date(),
      },
    });
    return "processed";
  }

  // Retryable failure: stay PENDING with bounded attempts (≈12 daily ticks)
  // before flipping FAILED past the 30-day IRN hard cut-off.
  if (result.status === "FAILED") {
    const MAX_RETRIES = 12;
    const nextRetryCount = (candidate.irpRetryCount ?? 0) + 1;
    const exhausted = nextRetryCount >= MAX_RETRIES;

    await prisma.organizationInvoice.update({
      where: { id: candidate.id },
      data: {
        irpStatus: exhausted ? "FAILED" : "PENDING",
        irpLastError: result.reason.slice(0, 500),
        irpLastAttemptAt: new Date(),
        irpRetryCount: nextRetryCount,
      },
    });
    return exhausted ? "failed" : "skipped";
  }

  return "skipped";
}

function configSkip(skipped: ConfigSkip): IrpUploaderResult {
  reportConfigSkip("irp-uploader", skipped);
  return { processed: 0, failed: 0, skippedRows: 0, skipped };
}

async function runIrpUploaderUnlocked(opts: {
  limit?: number;
  windowStart?: Date;
}): Promise<IrpUploaderResult> {
  console.log("[cron][irp-uploader] starting");
  Sentry.logger.info("job:irp-uploader started");

  // Config gate before any invoice is touched: an unset PLATFORM_GSTIN skips the
  // run and a malformed or wrong-state one throws, so every row stays PENDING.
  const supplier = platformSupplierForJob();
  if (!supplier) {
    return configSkip(GST_UNREGISTERED_SKIP);
  }
  const seller: SellerIdentity = {
    gstin: supplier.gstin,
    legalName: supplier.name,
    address1: REGISTERED_OFFICE.line1,
    location: REGISTERED_OFFICE.city,
    pincode: REGISTERED_OFFICE.pincode,
    stateCode: REGISTERED_OFFICE.stateCode,
  };
  // CR #1234 r5 — preflight the FULL provider configuration. generateIrn
  // marks rows FAILED on a missing CLEARTAX_* credential, so an auth outage
  // would burn all twelve retries per pending invoice and permanently fail
  // them before the environment is fixed. A missing setting is an ENV
  // outage: skip the run, leave every row PENDING, recover automatically.
  const missingCleartax = ["CLEARTAX_API_KEY", "CLEARTAX_GSP_TOKEN"].filter(
    (k) => !process.env[k]?.trim(),
  );
  if (missingCleartax.length > 0) {
    return configSkip(`${missingCleartax.join(", ")} not configured`);
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const candidates = await fetchIrpCandidates(thirtyDaysAgo, opts);

  let processed = 0;
  let failed = 0;
  let skippedRows = 0;

  for (const candidate of candidates) {
    // CR #1234 r5 — per-candidate mapping/submission/state-update lives in
    // processIrpCandidate; this loop keeps only the aggregate counters.
    const outcome = await processIrpCandidate(candidate, seller);
    if (outcome === "processed") processed++;
    else if (outcome === "failed") failed++;
    else skippedRows++;
  }

  console.log(
    `[IRP] uploader finished — processed=${processed} failed=${failed} skipped=${skippedRows}`,
  );
  Sentry.logger.info("job:irp-uploader finished", {
    processed,
    failed,
    skippedRows,
  });
  return { processed, failed, skippedRows };
}

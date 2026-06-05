/**
 * Cron: IRP (Invoice Registration Portal) uploader — Issue #681.
 *
 * STATUS: body live, env-gated. The cron iterates eligible invoices and
 * calls `lib/compliance/irp.generateIrn`. When `CLEARTAX_API_KEY`,
 * `CLEARTAX_GSP_TOKEN`, and `CLEARTAX_GSTIN` are configured, the
 * connector posts the invoice payload to ClearTax GSP and persists
 * `irn`, `ackNumber`, `signedQrPayload`, `irpStatus`, plus retry
 * telemetry (`irpRetryCount`, `irpLastError`, `irpLastAttemptAt`).
 * When env vars are absent, `generateIrn` returns
 * `{ status: "FAILED", reason: "STUB" }` and the uploader records that
 * as a normal retry — the cron does not crash on missing credentials.
 *
 * Production approval requires:
 *   1. Sandbox credentials provisioned and end-to-end tested
 *   2. Payload mapping validated against CBIC schema (HSN, GSTIN, amounts)
 *   3. 24-hour IRN cancellation window behaviour proven
 *   4. Accountant / legal sign-off on IRN format and invoice sequence
 *   5. Retry dashboard and ops runbook in place (see docs/enterprise/50-operations/03-runbooks.md)
 *
 * Schedule: daily at 02:30 UTC (08:00 IST).
 * GH Actions: `.github/workflows/irp-uploader.yml`.
 * Scope: OrganizationInvoice with irpStatus=PENDING, issuedAt within 30d
 *        (CBIC cut-off for retroactive IRN generation). Batch size: 50.
 */

// Why: tsx does not auto-load .env when this script runs outside the
// Next.js runtime. Without dotenv/config, DATABASE_URL is undefined and
// PrismaClient throws on the first query. See
// docs/enterprise/50-operations/03-runbooks.md "Running cron jobs locally".
import "dotenv/config";
import prisma from "@/lib/prisma";
import { generateIrn } from "@/lib/compliance/irp";
import { buildIrpPayload } from "@/lib/compliance/irp-payload";

// #703 — platform-side seller constants. GSTIN mirrors the invoice-PDF
// route (PLATFORM_GSTIN); the rest are env-overridable for a future
// per-region supplier. Seller state code is derived from the GSTIN prefix
// inside the mapper, SUPPLIER_STATE_CODE is the fallback.
const SELLER = {
  gstin: process.env.PLATFORM_GSTIN ?? "29AAFCF1234Q1ZN",
  legalName:
    process.env.SUPPLIER_LEGAL_NAME ??
    "Familiarise Technologies Private Limited",
  address1: process.env.SUPPLIER_ADDR1 ?? "Koramangala 1st Block",
  location: process.env.SUPPLIER_LOCATION ?? "Bangalore",
  pincode: process.env.SUPPLIER_PINCODE ?? "560034",
  stateCode: process.env.SUPPLIER_STATE_CODE ?? "KA",
};

export async function runIrpUploader(): Promise<{
  processed: number;
  failed: number;
  skipped: number;
}> {
  console.log("[cron][irp-uploader] starting");

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const candidates = await prisma.organizationInvoice.findMany({
    where: {
      irpStatus: "PENDING",
      issuedAt: { gte: thirtyDaysAgo, not: null },
    },
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
    take: 50, // batch size
  });

  let processed = 0;
  let failed = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    // #703 — build the NIC e-invoice payload from the fetched row. A
    // mapping failure is PERMANENT (missing GSTIN / no line items / bad
    // seller env): stamp the reason and flip straight to FAILED — retrying
    // can't fix structurally-unmappable data, and the 30-day IRN window
    // shouldn't be burned looping on it.
    const mapped = buildIrpPayload({
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
      seller: SELLER,
    });

    if (!mapped.ok) {
      await prisma.organizationInvoice.update({
        where: { id: candidate.id },
        data: {
          irpStatus: "FAILED", // permanent — do not loop
          irpLastError: `MAP: ${mapped.reason}`.slice(0, 500),
          irpLastAttemptAt: new Date(),
        },
      });
      failed++;
      continue;
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
      processed++;
      continue;
    }

    // Persist the failure so operators can see which invoices are
    // stuck and WHY. Previously we silently dropped these and the
    // cron would just keep re-hitting the same rows indefinitely.
    // `irpStatus` stays PENDING so the next cron tick retries; we only
    // flip to FAILED after a bounded number of attempts (tracked via
    // `irpRetryCount`). Past the threshold the admin UI surfaces these
    // for manual review — IRN generation has a 30-day hard cut-off.
    if (result.status === "FAILED") {
      const MAX_RETRIES = 12; // ≈ 12 days of daily retries before giving up
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
      if (exhausted) {
        failed++;
      } else {
        skipped++;
      }
      continue;
    }

    skipped++;
  }

  console.log(
    `[IRP] uploader finished — processed=${processed} failed=${failed} skipped=${skipped}`,
  );
  return { processed, failed, skipped };
}

// Self-execute when invoked directly via `npx tsx`. Allows imports for
// unit tests without triggering the cron body. Mirrors the pattern in
// jobs/contracts/expire-contracts.ts.
if (require.main === module) {
  runIrpUploader()
    .catch((err) => {
      console.error("[IRP] uploader failed:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

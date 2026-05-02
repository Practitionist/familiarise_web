/**
 * Cron: IRP (Invoice Registration Portal) uploader — Issue #681.
 *
 * STATUS: This cron job is scaffolded but not yet wired to invoke
 * lib/compliance/irp.ts. It returns { processed: 0 } today; no invoices
 * receive an IRN from this job until the wiring PR ships.
 *
 * NOTE: lib/compliance/irp.ts (`generateIrn`) is NOT a stub — it makes
 * real HTTP calls to the ClearTax GSP API when CLEARTAX_API_KEY,
 * CLEARTAX_GSP_TOKEN, and CLEARTAX_GSTIN env vars are configured.
 * Production approval requires all of the following:
 *   1. Sandbox credentials provisioned and end-to-end tested
 *   2. Payload mapping validated against CBIC schema (HSN, GSTIN, amounts)
 *   3. 24-hour IRN cancellation window behaviour proven
 *   4. Accountant / legal sign-off on IRN format and invoice sequence
 *   5. Retry dashboard and ops runbook in place (see docs/enterprise/23-runbooks.md)
 *
 * Schedule: daily at 02:00 IST.
 * Scope: OrganizationInvoice with irpStatus=PENDING, issuedAt within 30d
 *        (CBIC cut-off for retroactive IRN generation).
 */

import prisma from "@/lib/prisma";
import { generateIrn } from "@/lib/compliance/irp";

export async function runIrpUploader(): Promise<{
  processed: number;
  failed: number;
  skipped: number;
}> {
  console.log("[cron][arch4-stub] IRP uploader invoked; no live IRP wired");

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const candidates = await prisma.organizationInvoice.findMany({
    where: {
      irpStatus: "PENDING",
      issuedAt: { gte: thirtyDaysAgo, not: null },
    },
    select: { id: true, invoiceNumber: true },
    take: 50, // batch size
  });

  let processed = 0;
  let failed = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const result = await generateIrn({ invoiceId: candidate.id, payload: {} });

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
      const invoice = await prisma.organizationInvoice.findUnique({
        where: { id: candidate.id },
        select: { irpRetryCount: true },
      });
      const nextRetryCount = (invoice?.irpRetryCount ?? 0) + 1;
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

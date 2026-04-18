/**
 * Cron: IRP (Invoice Registration Portal) uploader — STUB (Issue #681).
 *
 * STATUS: stub. Returns `{ processed: 0 }` without hitting any IRP.
 * Live connector lands in a follow-up PR.
 *
 * Schedule: daily at 02:00 IST.
 * Scope: every `OrganizationInvoice` with `irpStatus = PENDING` and
 *        `issuedAt` within the last 30 days (IRP cut-off per CBIC).
 *
 * See lib/compliance/irp.ts header docblock for the live-implementation
 * plan (IRIS / ClearTax connectors, retry semantics, 24-hour cancellation
 * window).
 */

import prisma from "@/lib/prisma";
import { generateIrn } from "@/lib/compliance/irp";

export async function runIrpUploader(): Promise<{ processed: number }> {
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
        },
      });
      processed++;
    }
  }

  return { processed };
}

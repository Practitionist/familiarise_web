/**
 * #771 / #749 — cycle-close cron: roll each org's unbilled INVOICE_ACCRUAL
 * bookings into an OrganizationInvoice. Thin wrapper over
 * `rollupOrgInvoiceAccruals`. Schedule monthly alongside
 * `generate-subscription-invoices`. Should run as a singleton (same lock
 * discipline as the other billing crons) so concurrent runs can't double-bill;
 * the rollup's `billableToOrgInvoiceId: null` guard is the secondary defence.
 */
import prisma from "@/lib/prisma";
import { rollupOrgInvoiceAccruals } from "@/lib/payments/billing/invoice-rollup";

export async function settleInvoiceAccruals(): Promise<{
  orgsProcessed: number;
  invoicesCreated: number;
}> {
  // Distinct orgs with at least one unbilled accrual. Include
  // OVERAGE_INVOICE_ACCRUAL: an org whose base bookings are all LICENSE-covered
  // (₹0 legs) but has CHARGE_ORG overage would otherwise be skipped here and
  // never billed for the overage (the rollup itself already bills both sources).
  const rows = await prisma.payment.findMany({
    where: {
      billableToOrgInvoiceId: null,
      paymentStatus: "SUCCEEDED",
      organizationId: { not: null },
      legs: {
        some: { source: { in: ["INVOICE_ACCRUAL", "OVERAGE_INVOICE_ACCRUAL"] } },
      },
    },
    select: { organizationId: true },
    distinct: ["organizationId"],
  });

  let invoicesCreated = 0;
  for (const row of rows) {
    if (!row.organizationId) continue;
    try {
      const r = await rollupOrgInvoiceAccruals({
        organizationId: row.organizationId,
        issueImmediately: true,
      });
      if (r.invoiceId) {
        invoicesCreated++;
        console.log(
          `[settle-invoice-accruals] org ${row.organizationId}: invoice ${r.invoiceNumber} for ${r.billedPaymentCount} bookings (₹${(r.totalPaise / 100).toFixed(2)})`,
        );
      }
    } catch (err) {
      console.error(
        `[settle-invoice-accruals] org ${row.organizationId} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { orgsProcessed: rows.length, invoicesCreated };
}

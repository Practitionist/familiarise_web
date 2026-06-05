/**
 * #771 / #749 — monthly consolidated rollup cron: roll each org's unbilled
 * INVOICE_ACCRUAL / OVERAGE_INVOICE_ACCRUAL bookings into one
 * OrganizationInvoice per org. Thin wrapper over `rollupOrgInvoiceAccruals`,
 * mirroring `jobs/billing/settle-invoice-accruals.ts`. Runs monthly (the cron
 * is a one-shot per cycle); the rollup's `billableToOrgInvoiceId: null` guard
 * is the secondary defence so a re-run can't double-bill. Gated by
 * ENABLE_CONSOLIDATED_INVOICE so the monthly job is a no-op until enabled.
 */
import prisma from "@/lib/prisma";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import { rollupOrgInvoiceAccruals } from "@/lib/payments/billing/invoice-rollup";

export async function consolidatedInvoiceRollup(): Promise<{
  orgsProcessed: number;
  invoicesCreated: number;
}> {
  await abortIfMaintenance("consolidated-invoice-rollup");

  if (process.env.ENABLE_CONSOLIDATED_INVOICE !== "true") {
    console.log(
      "[consolidated-invoice-rollup] ENABLE_CONSOLIDATED_INVOICE != \"true\" — skipping",
    );
    return { orgsProcessed: 0, invoicesCreated: 0 };
  }

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
          `[consolidated-invoice-rollup] org ${row.organizationId}: invoice ${r.invoiceNumber} for ${r.billedPaymentCount} bookings (₹${(r.totalPaise / 100).toFixed(2)})`,
        );
      }
    } catch (err) {
      console.error(
        `[consolidated-invoice-rollup] org ${row.organizationId} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { orgsProcessed: rows.length, invoicesCreated };
}

async function main() {
  console.log(
    `[consolidated-invoice-rollup] Starting at ${new Date().toISOString()}`,
  );
  const r = await consolidatedInvoiceRollup();
  console.log(
    `[consolidated-invoice-rollup] Done. orgsProcessed=${r.orgsProcessed} invoicesCreated=${r.invoicesCreated}`,
  );
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error("[consolidated-invoice-rollup] Failed:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

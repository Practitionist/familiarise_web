/**
 * #771 / #749 — monthly consolidated rollup cron: roll each org's unbilled
 * INVOICE_ACCRUAL / OVERAGE_INVOICE_ACCRUAL bookings into one
 * OrganizationInvoice per org. Thin wrapper over `rollupOrgInvoiceAccruals`,
 * scheduled monthly alongside `generate-subscription-invoices`. Gated by
 * ENABLE_CONSOLIDATED_INVOICE so the monthly job is a no-op until enabled.
 *
 * #813 — two real defences against double-billing, not the unimplemented
 * "lock discipline" the old docstring claimed: (1) the workflow `concurrency`
 * block serialises job-level runs, and (2) `rollupOrgInvoiceAccruals` reads
 * the unstamped set inside a Serializable tx, so overlapping per-org runs
 * either abort (P2034, treated as a benign skip below) or see the empty set.
 */
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { abortIfMaintenance } from "@/lib/maintenance-cron";
import { rollupOrgInvoiceAccruals } from "@/lib/payments/billing/invoice-rollup";
import { withCronLock, CronLockHeldError, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";

export async function settleInvoiceAccruals(): Promise<{
  orgsProcessed: number;
  invoicesCreated: number;
}> {
  await abortIfMaintenance("settle-invoice-accruals");

  if (process.env.ENABLE_CONSOLIDATED_INVOICE !== "true") {
    console.log(
      "[settle-invoice-accruals] ENABLE_CONSOLIDATED_INVOICE != \"true\" — skipping",
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
          `[settle-invoice-accruals] org ${row.organizationId}: invoice ${r.invoiceNumber} for ${r.billedPaymentCount} bookings (₹${(r.totalPaise / 100).toFixed(2)})`,
        );
      }
    } catch (err) {
      // #813 — a serialization failure (P2034) means an overlapping run won the
      // race for this org's accruals; degrade gracefully and skip, don't error.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2034"
      ) {
        console.log(
          `[settle-invoice-accruals] org ${row.organizationId}: serialization conflict (P2034) — skipping, claimed by an overlapping run`,
        );
        continue;
      }
      console.error(
        `[settle-invoice-accruals] org ${row.organizationId} failed:`,
        err instanceof Error ? err.message : err,
      );
      Sentry.captureException(err, { tags: { subsystem: "jobs", job: "settle-invoice-accruals" } });
    }
  }

  return { orgsProcessed: rows.length, invoicesCreated };
}

async function main() {
  console.log(
    `[settle-invoice-accruals] Starting at ${new Date().toISOString()}`,
  );
  Sentry.logger.info("job:settle-invoice-accruals started");
  const r = await withCronLock(
    "settle-invoice-accruals",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => settleInvoiceAccruals(),
  );
  console.log(
    `[settle-invoice-accruals] Done. orgsProcessed=${r.orgsProcessed} invoicesCreated=${r.invoicesCreated}`,
  );
  Sentry.logger.info("job:settle-invoice-accruals finished", { orgsProcessed: r.orgsProcessed, invoicesCreated: r.invoicesCreated });
}

if (require.main === module) {
  main()
    .catch((err) => {
      // #476 — lock held = another run is live; skip cleanly (exit 0).
      if (err instanceof CronLockHeldError) {
        console.log(`⏭️  ${err.message}`);
        Sentry.logger.info("job:settle-invoice-accruals skipped — lock held");
        return;
      }
      console.error("[settle-invoice-accruals] Failed:", err);
      Sentry.captureException(err, { tags: { subsystem: "jobs", job: "settle-invoice-accruals" } });
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

/**
 * #771 / #749 — monthly consolidated rollup cron: roll each org's unbilled
 * INVOICE_ACCRUAL / OVERAGE_INVOICE_ACCRUAL bookings into one
 * OrganizationInvoice per org. Thin wrapper over `rollupOrgInvoiceAccruals`,
 * run by the ticker in a monthly window from the 1st, 04:00 UTC.
 *
 * E2E-audit P0 fix — this job is now ENABLED BY DEFAULT (opt-out via
 * ENABLE_CONSOLIDATED_INVOICE="false"). It shipped default-off while being
 * the ONLY path from INVOICE_ACCRUAL legs to an actual invoice, so with the
 * shipped config org INVOICE-rail bookings and CHARGE_ORG overages accrued
 * forever, grew unbounded credit-limit exposure in checkout, and produced no
 * GST document — a money black hole.
 *
 * Two defences against double-billing: (1) the `withCronLock` lease
 * serialises runs, and (2) `rollupOrgInvoiceAccruals` reads the unstamped set
 * inside a Serializable tx, so overlapping per-org runs either abort (P2034)
 * or see the empty set.
 *
 * #1347 — the rollup now retries a P2034 itself. One reaching this job means
 * the retries were exhausted, which is no longer a benign skip: the org goes
 * unbilled for the cycle, so it is recorded as a SystemEvent (and thereby
 * Sentry) rather than logged. The job still continues to the next org — one
 * contended org must not strand every other org's invoice.
 */
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { rollupOrgInvoiceAccruals } from "@/lib/payments/billing/invoice-rollup";
import {
  recordSystemError,
  recordSystemEvent,
} from "@/lib/enterprise/system-events";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import * as Sentry from "@sentry/nextjs";

export interface SettleInvoiceAccrualsResult {
  orgsProcessed: number;
  invoicesCreated: number;
  failed: number;
  remaining: number;
}

/**
 * `limit` caps the invoices issued plus failures per run; an org the rollup
 * skips does not count. With `windowStart`, only orgs holding an accrual from
 * before it are selected, so a later slice never re-invoices a billed org.
 */
export async function settleInvoiceAccruals(
  opts: { limit?: number; windowStart?: Date } = {},
): Promise<SettleInvoiceAccrualsResult> {
  if (process.env.ENABLE_CONSOLIDATED_INVOICE === "false") {
    console.log(
      '[settle-invoice-accruals] ENABLE_CONSOLIDATED_INVOICE === "false" — skipping (explicit opt-out)',
    );
    // The rollup is the ONLY path from accrual legs to an invoice: silently
    // skipping re-opens unbounded unbilled accrual. Report the opt-out so the
    // skip is a visible decision, not a quiet black hole.
    await recordSystemError({
      category: "INVOICE",
      summary:
        "Consolidated invoice rollup explicitly skipped (ENABLE_CONSOLIDATED_INVOICE=false) — unbilled INVOICE_ACCRUAL legs keep accumulating until the flag is re-enabled",
      err: new Error("ENABLE_CONSOLIDATED_INVOICE=false explicit opt-out"),
      context: { flag: "ENABLE_CONSOLIDATED_INVOICE=false" },
    });
    return { orgsProcessed: 0, invoicesCreated: 0, failed: 0, remaining: 0 };
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
      ...(opts.windowStart ? { createdAt: { lt: opts.windowStart } } : {}),
      // #1744 row 6 — a wound-down org is never billed again.
      organization: { status: { not: "DEACTIVATED" }, deletedAt: null },
      legs: {
        some: {
          source: { in: ["INVOICE_ACCRUAL", "OVERAGE_INVOICE_ACCRUAL"] },
        },
      },
    },
    select: { organizationId: true },
    distinct: ["organizationId"],
    orderBy: { organizationId: "asc" },
  });

  let invoicesCreated = 0;
  let failed = 0;
  let visited = 0;
  const unbackedPo: { organizationId: string; invoiceNumber: string }[] = [];
  const noGstState: string[] = [];
  for (const row of rows) {
    if (opts.limit !== undefined && invoicesCreated + failed >= opts.limit) {
      break;
    }
    visited += 1;
    if (!row.organizationId) continue;
    try {
      const r = await rollupOrgInvoiceAccruals({
        organizationId: row.organizationId,
        issueImmediately: true,
      });
      if (r.skippedNoGstState) noGstState.push(row.organizationId);
      if (r.unbackedPo && r.invoiceNumber) {
        unbackedPo.push({
          organizationId: row.organizationId,
          invoiceNumber: r.invoiceNumber,
        });
      }
      if (r.invoiceId) {
        invoicesCreated++;
        console.log(
          `[settle-invoice-accruals] org ${row.organizationId}: invoice ${r.invoiceNumber} for ${r.billedPaymentCount} bookings (₹${(r.totalPaise / 100).toFixed(2)})`,
        );
      }
    } catch (err) {
      // #1347 — a P2034 that survived the rollup's bounded retries. Skip
      // semantics are kept (the next org still runs) but the org is left
      // unbilled for this cycle, so it is reported, not logged away.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2034"
      ) {
        failed++;
        await recordSystemError({
          organizationId: row.organizationId,
          category: "INVOICE",
          summary: `Consolidated invoice rollup exhausted its serialization retries for org ${row.organizationId} — its unbilled accruals were NOT invoiced this cycle and will be retried on the next run`,
          err,
          context: { organizationId: row.organizationId, prismaCode: "P2034" },
        });
        continue;
      }
      failed++;
      console.error(
        `[settle-invoice-accruals] org ${row.organizationId} failed:`,
        err instanceof Error ? err.message : err,
      );
      Sentry.captureException(err, {
        tags: { subsystem: "jobs", job: "settle-invoice-accruals" },
      });
    }
  }

  // One row per run for each expected gap; ops fixes the org, not the cron.
  if (noGstState.length > 0) {
    await recordSystemEvent({
      category: "INVOICE",
      severity: "WARN",
      message: `ROLLUP_GST_STATE_MISSING: ${noGstState.length} domestic org(s) have no GST state or GSTIN, so their accruals were not invoiced this cycle`,
      context: { organizationIds: noGstState.slice(0, 50) },
    });
  }
  if (unbackedPo.length > 0) {
    await recordSystemEvent({
      category: "INVOICE",
      severity: "WARN",
      message: `ROLLUP_PO_NOT_COVERED: ${unbackedPo.length} invoice(s) issued without a covering purchase order on orgs that require one`,
      context: { invoices: unbackedPo.slice(0, 50) },
    });
  }

  return {
    orgsProcessed: visited,
    invoicesCreated,
    failed,
    remaining: rows.length - visited,
  };
}

/** The locked core the `/api/cleanup/settle-invoice-accruals` twin runs. */
export async function runSettleInvoiceAccruals(opts: {
  limit?: number;
  windowStart?: Date;
}): Promise<SettleInvoiceAccrualsResult> {
  return withCronLock(
    "settle-invoice-accruals",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => settleInvoiceAccruals(opts),
  );
}

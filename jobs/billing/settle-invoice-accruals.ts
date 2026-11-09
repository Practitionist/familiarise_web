/** Monthly invoice rollup; the lease and Serializable invoice writer prevent double billing. */
import prisma from "@/lib/prisma";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import {
  rollupOrgInvoiceAccruals,
  type RollupResult,
} from "@/lib/payments/billing/invoice-rollup";
import {
  recordSystemError,
  recordSystemEvent,
} from "@/lib/enterprise/system-events";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import {
  GST_UNREGISTERED_SKIP,
  reportConfigSkip,
  type ConfigSkip,
} from "@/lib/cron/config-skip";
import { platformSupplierForJob } from "@/lib/pdf/supplier";

export interface SettleInvoiceAccrualsResult {
  orgsProcessed: number;
  invoicesCreated: number;
  failed: number;
  /** Lower bound from the extra organization peek, not a full backlog count. */
  remaining: number;
  /** Set while the platform is not GST-registered: one config skip per run, no rollup. */
  skipped?: ConfigSkip;
}

interface RollupGaps {
  heldForPo: { organizationId: string; invoiceNumber: string }[];
  noGstState: string[];
}

/** Records the expected gaps a rollup reported; true when it issued an invoice. */
function noteRollupResult(
  organizationId: string,
  r: RollupResult,
  gaps: RollupGaps,
): boolean {
  if (r.skippedNoGstState) gaps.noGstState.push(organizationId);
  if (r.heldForPo && r.invoiceNumber) {
    gaps.heldForPo.push({ organizationId, invoiceNumber: r.invoiceNumber });
  }
  if (!r.invoiceId) return false;
  console.log(
    `[settle-invoice-accruals] org ${organizationId}: invoice ${r.invoiceNumber} for ${r.billedPaymentCount} bookings (₹${(r.totalPaise / 100).toFixed(2)})`,
  );
  return true;
}

type RollupFailure = {
  organizationId: string;
  phase: "rollup" | "cursor";
  error: unknown;
};

/** Collect failures into one event so a cohort outage cannot exhaust telemetry quota. */
async function reportRollupFailures(failures: RollupFailure[]): Promise<void> {
  if (failures.length === 0) return;
  const organizations = [
    ...new Set(failures.map((failure) => failure.organizationId)),
  ];
  await recordSystemError({
    ...(organizations.length === 1 ? { organizationId: organizations[0] } : {}),
    category: "INVOICE",
    summary: `Invoice rollup or polling cursor failed for ${organizations.length} organization(s); inspect the failed cohort before the next window`,
    err: new AggregateError(
      failures.map((failure) => failure.error),
      "Invoice rollup failures",
    ),
    context: {
      organizations,
      failures: failures.slice(0, 50).map((failure) => ({
        organizationId: failure.organizationId,
        phase: failure.phase,
        message: (failure.error instanceof Error
          ? failure.error.message
          : String(failure.error)
        ).slice(0, 500),
        code:
          failure.error instanceof Prisma.PrismaClientKnownRequestError
            ? failure.error.code
            : null,
      })),
    },
  });
}

/** One row per run for each expected gap; ops fixes the org, not the cron. */
async function reportRollupGaps(gaps: RollupGaps): Promise<void> {
  if (gaps.noGstState.length > 0) {
    await recordSystemEvent({
      category: "INVOICE",
      severity: "WARN",
      message: `ROLLUP_GST_STATE_MISSING: ${gaps.noGstState.length} domestic org(s) have no GST state or GSTIN, so their accruals were not invoiced this cycle`,
      context: { organizationIds: gaps.noGstState.slice(0, 50) },
    });
  }
  if (gaps.heldForPo.length > 0) {
    await recordSystemEvent({
      category: "INVOICE",
      severity: "WARN",
      message: `ROLLUP_PO_NOT_COVERED: ${gaps.heldForPo.length} invoice(s) held as DRAFT because no active purchase order covers them; issue each with a PO from the admin console`,
      context: { invoices: gaps.heldForPo.slice(0, 50) },
    });
  }
}

/**
 * `limit` caps all examined organizations, including skipped rollups. With `windowStart`, only orgs holding an accrual from
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
  // No GST invoice while unregistered; a malformed or wrong-state GSTIN throws here.
  if (!platformSupplierForJob()) {
    const skipped = GST_UNREGISTERED_SKIP;
    reportConfigSkip("settle-invoice-accruals", skipped);
    return {
      orgsProcessed: 0,
      invoicesCreated: 0,
      failed: 0,
      remaining: 0,
      skipped,
    };
  }

  const limit = z.number().int().min(1).max(500).default(10).parse(opts.limit);
  const rows = await prisma.organization.findMany({
    where: {
      status: { not: "DEACTIVATED" },
      deletedAt: null,
      payments: {
        some: {
          billableToOrgInvoiceId: null,
          paymentStatus: "SUCCEEDED",
          gstRegime: "REGISTERED",
          ...(opts.windowStart ? { createdAt: { lt: opts.windowStart } } : {}),
          legs: {
            some: {
              source: { in: ["INVOICE_ACCRUAL", "OVERAGE_INVOICE_ACCRUAL"] },
            },
          },
        },
      },
    },
    select: { id: true },
    orderBy: [
      { lastAccrualRollupAt: { sort: "asc", nulls: "first" } },
      { id: "asc" },
    ],
    take: limit + 1,
  });

  let invoicesCreated = 0;
  let failed = 0;
  let visited = 0;
  const gaps: RollupGaps = { heldForPo: [], noGstState: [] };
  const failures: RollupFailure[] = [];
  for (const row of rows) {
    if (visited >= limit) {
      break;
    }
    visited += 1;
    let orgFailed = false;
    try {
      const r = await rollupOrgInvoiceAccruals({
        organizationId: row.id,
        issueImmediately: true,
      });
      if (noteRollupResult(row.id, r, gaps)) invoicesCreated++;
    } catch (error) {
      orgFailed = true;
      failures.push({
        organizationId: row.id,
        phase: "rollup",
        error,
      });
    } finally {
      try {
        await prisma.$executeRaw`UPDATE "organizations" SET "lastAccrualRollupAt" = now() WHERE id = ${row.id}`;
      } catch (error) {
        orgFailed = true;
        failures.push({
          organizationId: row.id,
          phase: "cursor",
          error,
        });
      }
    }
    if (orgFailed) failed++;
  }
  await reportRollupFailures(failures);
  await reportRollupGaps(gaps);

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

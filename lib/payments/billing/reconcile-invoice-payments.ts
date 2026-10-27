import { z } from "zod";
import { Prisma } from "@prisma/client";

import {
  LONG_JOB_TTL_MS,
  readJobCheckpoint,
  withCronLock,
} from "@/lib/cron/with-cron-lock";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { reportSentryError } from "@/lib/observability/report";
import { reportStandingFinding } from "@/lib/observability/standing-finding";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { applyOrgInvoiceCapture } from "@/lib/payments/billing/org-invoice-settlement";
import { readRazorpayOrderHolding } from "@/lib/payments/core/razorpay";
import prisma from "@/lib/prisma";

const JOB_NAME = "reconcile-org-invoice-payments";
const MAX_LIMIT = 5;
const PROVIDER_READ_TIMEOUT_MS = 5_000;
const ADMISSION_BUDGET_MS = 10_000;
const checkpointSchema = z.string().min(1).max(128);

export interface ReconcileOrgInvoicePaymentsOptions {
  limit?: number;
  startedAt?: number;
}

export interface ReconcileOrgInvoicePaymentsResult {
  success: boolean;
  scanned: number;
  captured: number;
  paid: number;
  unapplied: number;
  live: number;
  empty: number;
  failed: number;
  checkpoint: string | null;
  errors: string[];
  timestamp: string;
}

type InvoiceCandidate = {
  id: string;
  organizationId: string;
  providerPaymentOrderId: string;
};

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

async function findCandidates(
  afterId: string | null,
  limit: number,
): Promise<InvoiceCandidate[]> {
  const rows = await prisma.organizationInvoice.findMany({
    where: {
      status: { in: ["ISSUED", "OVERDUE"] },
      providerPaymentOrderId: { not: null },
      ...(afterId ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: "asc" },
    take: limit,
    select: { id: true, organizationId: true, providerPaymentOrderId: true },
  });
  return rows.flatMap((row) =>
    row.providerPaymentOrderId
      ? [
          {
            id: row.id,
            organizationId: row.organizationId,
            providerPaymentOrderId: row.providerPaymentOrderId,
          },
        ]
      : [],
  );
}

/**
 * Recover captured organization invoice orders whose payment webhook was lost.
 * The execution trail checkpoint rotates bounded keyset pages without adding
 * polling state to statutory invoice rows.
 */
export async function reconcileOrgInvoicePayments(
  options: ReconcileOrgInvoicePaymentsOptions = {},
): Promise<ReconcileOrgInvoicePaymentsResult> {
  return withCronLock(
    "reconcile-org-invoice-payments",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => reconcileOrgInvoicePaymentsUnlocked(options),
  );
}

async function reconcileOrgInvoicePaymentsUnlocked(
  options: ReconcileOrgInvoicePaymentsOptions,
): Promise<ReconcileOrgInvoicePaymentsResult> {
  const startedAt = options.startedAt ?? Date.now();
  const pastDeadline = () => Date.now() >= startedAt + ADMISSION_BUDGET_MS;
  const limit = boundedLimit(options.limit);
  const errors: string[] = [];
  let scanned = 0;
  let captured = 0;
  let paid = 0;
  let unapplied = 0;
  let live = 0;
  let empty = 0;
  let failed = 0;
  const unappliedIds: string[] = [];
  const processingErrors: string[] = [];
  let checkpoint = await readJobCheckpoint(JOB_NAME);
  if (checkpoint !== null && !checkpointSchema.safeParse(checkpoint).success) {
    checkpoint = null;
  }

  let candidates = await findCandidates(checkpoint, limit);
  if (candidates.length === 0 && checkpoint !== null) {
    checkpoint = null;
    candidates = await findCandidates(null, limit);
  }

  // Limit admissions and bound each provider read within the worker budget.
  for (const invoice of candidates) {
    if (pastDeadline()) break;
    scanned++;
    try {
      const holding = await readRazorpayOrderHolding(
        invoice.providerPaymentOrderId,
        PROVIDER_READ_TIMEOUT_MS,
      );
      if (holding.kind === "live") {
        live++;
      } else if (holding.kind === "empty") {
        empty++;
      } else {
        captured++;
        const outcome = await withSerializableRetry(() =>
          prisma.$transaction(
            async (tx) => {
              const result = await applyOrgInvoiceCapture(tx, {
                invoiceId: invoice.id,
                gatewayPaymentId: holding.paymentId,
                capturedPaise: holding.amountPaise,
                notesOrganizationId: invoice.organizationId,
              });
              if (result.kind === "PAID") {
                await tx.orgAuditLog.create({
                  data: {
                    organizationId: result.settled.organizationId,
                    actorMembershipId: null,
                    category: "INVOICE",
                    action: AUDIT_ACTIONS.INVOICE.INVOICE_PAID,
                    description: `Invoice ${result.settled.invoiceNumber} paid by gateway recovery`,
                    details: {
                      invoiceId: invoice.id,
                      providerPaymentId: holding.paymentId,
                    },
                  },
                });
              }
              return result;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );

        if (outcome.kind === "PAID") {
          // Settlement stages durable outbox rows; their relays own delivery.
          paid++;
        } else if (outcome.kind === "UNAPPLIED") {
          unapplied++;
          unappliedIds.push(invoice.id);
          errors.push(
            `Invoice ${invoice.id} capture ${holding.paymentId} was parked as ${outcome.reason}`,
          );
        }
      }
    } catch (error) {
      failed++;
      const message = `Invoice ${invoice.id} order ${invoice.providerPaymentOrderId}: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(message);
      processingErrors.push(message);
    }
    // Failures, live orders and empty orders rotate too; the next cycle wraps
    // back through them so one unreachable order cannot pin the cohort.
    checkpoint = invoice.id;
  }

  if (candidates.length > 0 && scanned === 0) {
    const message = "Invoice recovery budget elapsed before any order was read";
    errors.push(message);
    processingErrors.push(message);
  }

  if (processingErrors.length > 0) {
    reportSentryError(
      new Error(
        `${JOB_NAME}: ${processingErrors.length} invoice recovery issue(s)`,
      ),
      {
        subsystem: "payments",
        tags: { job: JOB_NAME },
        extra: { errors: processingErrors.slice(0, 10) },
      },
    );
  }
  await reportStandingFinding(
    {
      key: JOB_NAME,
      ids: unappliedIds,
      message: "Captured invoice payments need operator review",
    },
    () =>
      reportSentryError(
        new Error(
          `${JOB_NAME}: captured invoice payments need operator review`,
        ),
        {
          subsystem: "payments",
          tags: { job: JOB_NAME },
          extra: { invoiceIds: unappliedIds.slice(0, 10) },
        },
      ),
  );

  return {
    success: processingErrors.length === 0,
    scanned,
    captured,
    paid,
    unapplied,
    live,
    empty,
    failed,
    checkpoint,
    errors,
    timestamp: new Date().toISOString(),
  };
}

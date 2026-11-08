/**
 * Mints the consumer tax invoice for SUCCEEDED payments the capture path left
 * un-invoiced (a crash after commit), within a bounded lookback. While the
 * platform is unregistered it mints nothing.
 */

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import prisma from "@/lib/prisma";
import { reportConfigSkip, type ConfigSkip } from "@/lib/cron/config-skip";
import { startDeadline } from "@/lib/cron/run-deadline";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { isUniqueViolationOn } from "@/lib/db/unique-violation";
import { createRunFailureReporter } from "@/lib/observability/run-failures";
import {
  CONSUMER_INVOICEABLE_PAYMENT_WHERE,
  CREDIT_NOTE_REFUND_STATUSES,
  mintConsumerInvoice,
} from "@/lib/payments/billing/consumer-invoice";
import { platformSupplierForJob } from "@/lib/pdf/supplier";

/** Payments created before this lookback are not healed automatically. */
export const CONSUMER_INVOICE_LOOKBACK_DAYS = 90;

/** Leaves the capture path's own post-commit mint time to land first. */
const CAPTURE_GRACE_MS = 15 * 60 * 1000;

export interface HealConsumerInvoicesResult {
  scanned: number;
  minted: number;
  /** Payments the mint declined, such as a zero-value supply. */
  declined: number;
  failed: number;
  skipped?: ConfigSkip;
}

/**
 * Bounded slice: payments are read from a random id pivot and wrap around, so
 * rows the mint keeps declining cannot starve the rest of the cohort.
 */
export async function healConsumerInvoices(opts: {
  limit: number;
  startedAt?: number;
  now?: Date;
  pivot?: string;
}): Promise<HealConsumerInvoicesResult> {
  // An unset GSTIN skips before any row is read; a malformed or wrong-state one throws.
  if (!platformSupplierForJob()) {
    const skipped: ConfigSkip = "PLATFORM_GSTIN not configured";
    reportConfigSkip("heal-consumer-invoices", skipped);
    return { scanned: 0, minted: 0, declined: 0, failed: 0, skipped };
  }
  // Fail-closed: every mint takes a number from the gapless Rule 46 series.
  return withCronLock(
    "heal-consumer-invoices",
    { failMode: "closed" },
    async () => {
      const now = opts.now ?? new Date();
      const pastDeadline = startDeadline(opts.startedAt);
      const ids = await readCohort(now, opts.limit, opts.pivot ?? randomUUID());
      const failures = createRunFailureReporter("payments");
      const result: HealConsumerInvoicesResult = {
        scanned: ids.length,
        minted: 0,
        declined: 0,
        failed: 0,
      };
      for (const paymentId of ids) {
        if (pastDeadline()) break;
        try {
          // The mint re-checks refunds inside this transaction before taking a number.
          const { consumerInvoiceId } = await prisma.$transaction((tx) =>
            mintConsumerInvoice(tx, { paymentId }),
          );
          if (consumerInvoiceId) result.minted += 1;
          else result.declined += 1;
        } catch (error) {
          // The capture path minted it first; the loser's number rolled back with it.
          if (isUniqueViolationOn(error, "paymentId")) continue;
          result.failed += 1;
          failures.add("consumer-invoice.heal", error, { paymentId });
        }
      }
      failures.flush();
      return result;
    },
  );
}

async function readCohort(
  now: Date,
  limit: number,
  pivot: string,
): Promise<string[]> {
  const where = {
    ...CONSUMER_INVOICEABLE_PAYMENT_WHERE,
    paymentStatus: "SUCCEEDED",
    deletedAt: null,
    consumerInvoice: null,
    // A refunded supply needs its invoice and credit note together; ops mint those.
    refunds: { none: { status: { in: CREDIT_NOTE_REFUND_STATUSES } } },
    createdAt: {
      gte: new Date(
        now.getTime() - CONSUMER_INVOICE_LOOKBACK_DAYS * 86_400_000,
      ),
    },
    updatedAt: { lt: new Date(now.getTime() - CAPTURE_GRACE_MS) },
  } satisfies Prisma.PaymentWhereInput;
  const read = (id: { gte: string } | { lt: string }, take: number) =>
    prisma.payment.findMany({
      where: { ...where, id },
      select: { id: true },
      orderBy: { id: "asc" },
      take,
    });
  const head = await read({ gte: pivot }, limit);
  const tail =
    head.length < limit ? await read({ lt: pivot }, limit - head.length) : [];
  return [...head, ...tail].map((p) => p.id);
}

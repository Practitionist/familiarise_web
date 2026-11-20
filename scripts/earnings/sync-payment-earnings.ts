/**
 * Payment-Earning Sync - Core Logic
 *
 * Syncs ConsultantEarnings records with Payment records.
 * Finds all payments where status = SUCCEEDED but no corresponding earnings exists.
 *
 * This catches cases where:
 * - App crash after payment succeeded but before earnings created
 * - Webhook was missed or delayed
 * - Manual payment processing at gateway
 *
 * This module exports the core sync function.
 * It is imported by:
 * - jobs/sync-payment-earnings.ts (GitHub Actions)
 * - app/api/cleanup/sync-payment-earnings/route.ts (API endpoint)
 *
 * GitHub Issue: #303
 * Schedule: Hourly
 */

import prisma, { type PrismaLike } from "../../lib/prisma";
import { PaymentStatus, AppointmentsType, type Prisma } from "@prisma/client";
import { AppointmentType } from "../../lib/payments/payouts/constants";
import {
  createEarningsFromPayment,
  ParkedCaptureEarningsError,
} from "../../lib/payments/payouts/earnings-service";
import {
  MANUAL_RECOVERY_PREFIX,
  notSettledElsewhereWhere,
} from "@/lib/payments/webhooks/auto-refund-marker";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import { reportSentryMessage } from "@/lib/observability/report";

// Batch size for processing payments to prevent memory issues
const BATCH_SIZE = 100;

/**
 * #1319 — the cohort has no age window any more, so the run needs a ceiling.
 *
 * The cohort is the gateway captures whose Phase-1 earnings write rolled back
 * to its savepoint and whose post-commit retry also failed; the synchronous
 * rails (org-funded, credit-funded, mock) write earnings inside the checkout
 * transaction and never land here. There is no age at which money stops being
 * owed, so there is no window. The ceiling bounds the runtime instead, and the
 * ordering is oldest-first because the payments that have gone unaccrued
 * longest are the ones somebody has been waiting on.
 *
 * Refunded and charged-back money is out of the cohort (#1583 C-P0-05): the
 * money already left, and the refund cascade ran before any earning existed,
 * so healing such a payment would mint an earning nothing will ever claw back.
 */
const MAX_PAYMENTS_PER_RUN = 500;

/** Refund rows that have taken money out, or are about to (refund.ts:237). */
const RETURNED_REFUND_STATUSES = ["PENDING", "SUCCEEDED"] as const;
/** Dispute verdicts where the bank has already pulled the funds (refund.ts:248). */
const RETURNED_DISPUTE_STATUSES = ["LOST", "CHARGE_REFUNDED"] as const;

/** #1583 C-P0-05 — the money that left, so the cohort must never re-accrue it. */
const REFUNDED_OR_DISPUTED: Prisma.PaymentWhereInput = {
  OR: [
    { refunds: { some: { status: { in: [...RETURNED_REFUND_STATUSES] } } } },
    { disputes: { some: { status: { in: [...RETURNED_DISPUTE_STATUSES] } } } },
  ],
};

/**
 * No earnings of either kind. A seat on a plan an organisation owns settles
 * into organisation earnings alone, and every row of a payment is written in
 * one transaction, so either kind means the payment is settled.
 */
const NO_EARNINGS = {
  earnings: { none: {} },
  organizationEarnings: { none: {} },
} satisfies Prisma.PaymentWhereInput;

/** The cohort the sweep accrues; shared with the ticker's idle probe. */
const UNEARNED_PAYMENT_WHERE: Prisma.PaymentWhereInput = {
  paymentStatus: PaymentStatus.SUCCEEDED,
  // Synchronous rails carry the flag and settle earnings in their own tx.
  isMockPayment: false,
  // An appointment-less row is never healed here, so it must not hold a cohort slot.
  appointmentId: { not: null },
  ...NO_EARNINGS,
  refunds: { none: { status: { in: [...RETURNED_REFUND_STATUSES] } } },
  disputes: { none: { status: { in: [...RETURNED_DISPUTE_STATUSES] } } },
  // A parked capture's cash sits in UNAPPLIED_RECEIPTS; booking it would count CASH twice.
  AND: [notSettledElsewhereWhere],
};

/** Unearned payments whose money already left; the run reports them every time while any exist. */
const REFUNDED_UNEARNED_PAYMENT_WHERE: Prisma.PaymentWhereInput = {
  paymentStatus: PaymentStatus.SUCCEEDED,
  appointmentId: { not: null },
  ...NO_EARNINGS,
  ...REFUNDED_OR_DISPUTED,
};

/** True when the run would accrue a payment or report a refunded unearned one. */
export async function hasPaymentEarningsSyncWork(
  db: PrismaLike,
  _now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const row = await db.payment.findFirst({
    where: { OR: [UNEARNED_PAYMENT_WHERE, REFUNDED_UNEARNED_PAYMENT_WHERE] },
    select: { id: true },
  });
  return row !== null;
}

/**
 * How long a SUCCEEDED payment may sit without earnings before the sweep pages
 * a human about it. Under this the settlement may simply still be in flight.
 */
const UNACCRUED_ALERT_AFTER_HOURS = 24;

export interface PaymentEarningSyncResult {
  success: boolean;
  totalProcessed: number;
  createdCount: number;
  skippedCount: number;
  errorCount: number;
  /** #1319 — payments escalated as permanently unaccruable this run. */
  pagedCount: number;
  /** Paged unaccruable payments stamped out of the cohort this run. */
  retiredCount: number;
  errors: string[];
  timestamp: string;
}

export interface SyncPaymentEarningsOptions {
  /** #1356 — overrides MAX_PAYMENTS_PER_RUN for the Netlify ticker; undefined
   * keeps the 500-row GitHub Actions ceiling. */
  limit?: number;
}

/** A payment that has a booking but no consultant anyone could ever pay. */
type UnaccruablePayment = {
  id: string;
  appointmentId: string | null;
  organizationId: string | null;
  amountPaise: string;
  createdAt: Date;
  description: string | null;
};

/**
 * One alert per payment per UTC day. `SystemEvent.correlationId` is indexed and
 * carries no meaning of its own for this category, so folding the date into it
 * makes "have we already paged for this today?" a single indexed read for the
 * whole batch instead of a per-payment round trip.
 */
function unaccruedAlertKey(paymentId: string, now: Date): string {
  return `earnings-unaccrued:${paymentId}:${now.toISOString().slice(0, 10)}`;
}

/**
 * Escalate the payments this sweep can never heal (#1319).
 *
 * `createEarningsFromPayment` returns null with a `console.warn` when it cannot
 * resolve a consultant, and the sweep counted that as "skipped" — so a payment
 * that no run will ever accrue was re-read every hour, forever, and said so
 * only into a log nobody reads. A booking that exists but resolves no
 * consultant is unambiguous: nobody can be paid for it, and the data needs a
 * human.
 *
 * A payment with no appointment AT ALL is deliberately not paged here. That
 * cohort belongs to `scripts/alerts/alert-orphaned-payments.ts`, and it legally
 * contains rows that will never accrue by design — the overage side-charge is
 * created with `appointmentId: null` precisely to dodge the
 * `@@unique([userId, appointmentId])` clash.
 */
async function pageUnaccruablePayments(
  candidates: UnaccruablePayment[],
  now: Date,
): Promise<{ paged: number; known: UnaccruablePayment[] }> {
  if (candidates.length === 0) return { paged: 0, known: [] };

  const keys = candidates.map((p) => unaccruedAlertKey(p.id, now));
  // Best-effort throughout: the sweep's money repair must never fail because
  // its alerting could not read or write.
  let seen: Set<string | null>;
  try {
    const alreadyPaged = await prisma.systemEvent.findMany({
      where: { correlationId: { in: keys } },
      select: { correlationId: true },
    });
    seen = new Set(alreadyPaged.map((e) => e.correlationId));
  } catch (err) {
    console.error(
      "[sync-payment-earnings] dedupe lookup failed; skipping paging this run:",
      err,
    );
    return { paged: 0, known: [] };
  }

  let paged = 0;
  const newlyPagedIds: string[] = [];
  const known: UnaccruablePayment[] = [];
  for (const payment of candidates) {
    const key = unaccruedAlertKey(payment.id, now);
    if (seen.has(key)) {
      known.push(payment);
      continue;
    }

    const ageHours = Math.floor(
      (now.getTime() - payment.createdAt.getTime()) / 3_600_000,
    );
    // The durable per-payment row is the dedupe key; Sentry hears once per run.
    try {
      await recordSystemEvent({
        organizationId: payment.organizationId,
        category: "PAYMENT",
        severity: "ERROR",
        message:
          `Payment ${payment.id} has been SUCCEEDED for ${ageHours}h with no ` +
          `consultant earnings and no consultant to accrue them to; the sync ` +
          `sweep cannot heal it: EARNINGS_UNACCRUABLE_NO_CONSULTANT`,
        context: {
          paymentId: payment.id,
          appointmentId: payment.appointmentId,
          amountPaise: payment.amountPaise,
          paymentCreatedAt: payment.createdAt.toISOString(),
          ageHours,
        },
        correlationId: key,
        strict: true,
      });
    } catch (err) {
      console.error(
        `[sync-payment-earnings] failed to page for ${payment.id}:`,
        err,
      );
      continue;
    }
    paged++;
    newlyPagedIds.push(payment.id);
    known.push(payment);
  }

  if (newlyPagedIds.length > 0) {
    reportSentryMessage(
      "EARNINGS_UNACCRUABLE_NO_CONSULTANT: SUCCEEDED payment(s) with no consultant to accrue earnings to",
      {
        subsystem: "payments",
        op: "sync-payment-earnings.unaccruable",
        level: "error",
        extra: {
          count: newlyPagedIds.length,
          paymentIds: newlyPagedIds.slice(0, 20),
        },
      },
    );
  }
  return { paged, known };
}

/**
 * Stamps each paged unaccruable payment with the marker the cohort already
 * excludes, so rows no run can heal never fill the bounded read. CAS on the
 * cohort's own predicate: a payment that grew earnings or a marker is left alone.
 */
async function retireUnaccruablePayments(
  payments: UnaccruablePayment[],
  errors: string[],
): Promise<number> {
  let retired = 0;
  for (const payment of payments) {
    try {
      const { count } = await prisma.payment.updateMany({
        where: {
          id: payment.id,
          paymentStatus: PaymentStatus.SUCCEEDED,
          ...NO_EARNINGS,
          AND: [notSettledElsewhereWhere],
        },
        data: {
          description: [
            `${MANUAL_RECOVERY_PREFIX} EARNINGS_UNACCRUABLE_NO_CONSULTANT; no consultant to accrue earnings to.`,
            payment.description ? `Was: ${payment.description}` : null,
          ]
            .filter(Boolean)
            .join(" "),
        },
      });
      retired += count;
    } catch (err) {
      console.error(
        `[sync-payment-earnings] failed to retire ${payment.id}:`,
        err,
      );
      errors.push(
        `Retire ${payment.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return retired;
}

/**
 * Map AppointmentsType enum to the payout constants key
 */
function mapAppointmentType(type: AppointmentsType): AppointmentType {
  switch (type) {
    case AppointmentsType.CONSULTATION:
      return "CONSULTATION";
    case AppointmentsType.WEBINAR:
      return "WEBINAR";
    case AppointmentsType.CLASS:
      return "CLASS";
    case AppointmentsType.SUBSCRIPTION:
      return "SUBSCRIPTION";
    default:
      return "CONSULTATION"; // Default to consultation hold period
  }
}

/**
 * Find succeeded payments without earnings and create them
 * Uses batch processing to handle large datasets efficiently
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function syncPaymentEarnings(
  opts: SyncPaymentEarningsOptions = {},
): Promise<PaymentEarningSyncResult> {
  return withCronLock(
    "sync-payment-earnings",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => syncPaymentEarningsUnlocked(opts),
  );
}

async function syncPaymentEarningsUnlocked(
  opts: SyncPaymentEarningsOptions = {},
): Promise<PaymentEarningSyncResult> {
  const errors: string[] = [];
  let totalProcessed = 0;
  let createdCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const maxPayments = opts.limit ?? MAX_PAYMENTS_PER_RUN;

  const now = new Date();
  const alertCutoff = new Date(
    now.getTime() - UNACCRUED_ALERT_AFTER_HOURS * 60 * 60 * 1000,
  );
  /** Collected across batches so the whole run pages in one indexed read. */
  const unaccruable: UnaccruablePayment[] = [];
  const skippedRefundedIds: string[] = [];

  // FIX #571: Use cursor-based pagination instead of skip-based.
  // Skip-based pagination on a mutating result set (earnings: { none: {} })
  // can silently skip payments when items are removed from the set mid-iteration.
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore && totalProcessed < maxPayments) {
    const take = Math.min(BATCH_SIZE, maxPayments - totalProcessed);
    // Fetch batch with cursor-based pagination
    const payments = await prisma.payment.findMany({
      where: UNEARNED_PAYMENT_WHERE,
      take,
      ...(cursor
        ? { cursor: { id: cursor }, skip: 1 } // skip the cursor item itself
        : {}),
      include: {
        appointment: {
          include: {
            consultation: {
              include: {
                consultationPlan: {
                  select: { consultantProfileId: true },
                },
              },
            },
            subscription: {
              include: {
                subscriptionPlan: {
                  select: { consultantProfileId: true },
                },
              },
            },
            webinar: {
              include: {
                webinarPlan: {
                  select: {
                    id: true,
                    consultantProfileId: true,
                    organizationId: true,
                  },
                },
              },
            },
            class: {
              include: {
                classPlan: {
                  select: {
                    id: true,
                    consultantProfileId: true,
                    organizationId: true,
                  },
                },
              },
            },
          },
        },
      },
      // Oldest first: the longest-unaccrued payment is the one somebody has
      // been waiting on. The id tie-break makes the ordering total, which is
      // what the cursor needs to be able to resume without repeating a row.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    if (payments.length < take) {
      hasMore = false;
    }
    if (payments.length > 0) {
      cursor = payments[payments.length - 1].id;
    }
    totalProcessed += payments.length;

    if (payments.length === 0) {
      break;
    }

    console.log(
      `Processing batch of ${payments.length} payments (total processed: ${totalProcessed})`,
    );

    // Batch check existing earnings (instead of N individual queries)
    const paymentIds = payments.map((p) => p.id);
    const existingEarnings = await prisma.consultantEarnings.findMany({
      where: { paymentId: { in: paymentIds } },
      select: { paymentId: true },
    });
    const existingPaymentIds = new Set(
      existingEarnings.map((e) => e.paymentId),
    );

    // #773 — delegate creation to createEarningsFromPayment, the single
    // source of truth: it resolves collaborator + HOST-org settlement, nets
    // shares, and posts the balanced booking:<paymentId> journal txn in the
    // same operation. The old local writer minted full-share collaborator
    // rows with NO journal — every synced multi-party payment was born as
    // EARNINGS_WITHOUT_BOOKING_TXN drift. Old payments get a fresh hold
    // window (the release cron flips them READY on schedule).
    for (const payment of payments) {
      if (existingPaymentIds.has(payment.id)) {
        skippedCount++;
        continue;
      }

      const appointment = payment.appointment;
      const consultantProfileId =
        appointment?.consultation?.consultationPlan?.consultantProfileId ||
        appointment?.subscription?.subscriptionPlan?.consultantProfileId ||
        appointment?.webinar?.webinarPlan?.consultantProfileId ||
        appointment?.class?.classPlan?.consultantProfileId;

      // A webinar or class plan may be owned by an organisation with no
      // consultant; its seat settles to that organisation, as at capture.
      const groupPlan =
        appointment?.webinar?.webinarPlan ?? appointment?.class?.classPlan;
      const ownerOrganizationId =
        consultantProfileId || !groupPlan
          ? null
          : (groupPlan.organizationId ?? appointment?.organizationId ?? null);

      if (!appointment || (!consultantProfileId && !ownerOrganizationId)) {
        // A booking that resolves no consultant and no owning organisation
        // will not heal on the next run either, so it is escalated rather
        // than skipped in silence. Fresh payments are left alone: settlement
        // runs post-commit and may still be in flight.
        if (appointment && payment.createdAt < alertCutoff) {
          unaccruable.push({
            id: payment.id,
            appointmentId: payment.appointmentId,
            organizationId: payment.organizationId,
            amountPaise: payment.amount.toString(),
            createdAt: payment.createdAt,
            description: payment.description,
          });
        }
        console.log(
          `⏭️ Skipping payment ${payment.id} - no consultant profile found`,
        );
        skippedCount++;
        continue;
      }

      // The cohort read is one snapshot; a refund can land between it and
      // the earnings write. Re-ask the same predicate immediately before the
      // create so the window is the write itself, not the whole batch.
      const refundedSince = await prisma.payment.findFirst({
        where: { id: payment.id, ...REFUNDED_OR_DISPUTED },
        select: { id: true },
      });
      if (refundedSince) {
        skippedRefundedIds.push(payment.id);
        skippedCount++;
        continue;
      }

      try {
        const earningsId = await createEarningsFromPayment({
          payment: {
            ...payment,
            appointment: {
              ...(consultantProfileId
                ? { consultantProfile: { id: consultantProfileId } }
                : {}),
              organizationId: ownerOrganizationId,
              webinar: appointment.webinar
                ? { webinarPlanId: appointment.webinar.webinarPlanId }
                : null,
              class: appointment.class
                ? { classPlanId: appointment.class.classPlanId }
                : null,
            },
          },
          appointmentType: mapAppointmentType(appointment.appointmentType),
          // The team as of the capture this retries, never as of this run.
          teamAt: payment.capturedAt ?? payment.createdAt,
        });
        // An organisation-owned plan has no owner earning to name; it settled unless it threw.
        if (earningsId || ownerOrganizationId) {
          createdCount++;
        } else {
          skippedCount++;
        }
      } catch (err) {
        if (err instanceof ParkedCaptureEarningsError) {
          skippedCount++;
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Payment ${payment.id}: ${msg}`);
        errorCount++;
      }
    }
  }

  if (skippedRefundedIds.length > 0) {
    // Keep message string static so Sentry groups all occurrences into one issue; IDs live in extra.
    reportSentryMessage(
      "EARNINGS_SKIPPED_REFUNDED: payment(s) refunded or charged back after the cohort read; not accrued",
      {
        subsystem: "payments",
        op: "sync-payment-earnings.race",
        expected: true,
        extra: { paymentIds: skippedRefundedIds },
      },
    );
  }

  const { paged: pagedCount, known } = await pageUnaccruablePayments(
    unaccruable,
    now,
  );
  // Only a payment an operator has been told about leaves the cohort.
  const errorsBeforeRetire = errors.length;
  const retiredCount = await retireUnaccruablePayments(known, errors);
  errorCount += errors.length - errorsBeforeRetire;

  // One message per run, not per row: the excluded volume is what an operator
  // needs to see when a cascade starts running ahead of the accrual (#1583 C-P0-05).
  const skippedRefunded = await prisma.payment.count({
    where: REFUNDED_UNEARNED_PAYMENT_WHERE,
  });
  if (skippedRefunded > 0) {
    reportSentryMessage(
      `EARNINGS_SKIPPED_REFUNDED: ${skippedRefunded} SUCCEEDED payment(s) without earnings were left unaccrued because a refund or lost dispute already returned the money`,
      {
        subsystem: "payments",
        op: "sync-payment-earnings",
        expected: true,
        extra: { skippedRefunded },
      },
    );
  }

  console.log(
    `Sync complete: ${totalProcessed} total, ${createdCount} created, ${skippedCount} skipped, ${errorCount} errors, ${pagedCount} paged, ${retiredCount} retired`,
  );

  return {
    success: errors.length === 0,
    totalProcessed,
    createdCount,
    skippedCount,
    errorCount,
    pagedCount,
    retiredCount,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

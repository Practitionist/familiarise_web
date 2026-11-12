#!/usr/bin/env node

/**
 * Abandoned Payment Cleanup Script
 *
 * Core library for cleaning up abandoned payments and appointments
 * that have exceeded their timeout periods.
 *
 * This module exports functions that can be used by:
 * - Local development: `npm run scripts:cleanup-abandoned-payments`
 * - GitHub Actions: `jobs/cleanup-abandoned-payments.ts`
 * - API routes: Can import and call functions directly
 *
 * Contains race condition fixes:
 * - Issue #6: 35 min buffer (5 min over 30 min expiry) for legacy payments
 * - Issue #10: Re-check payment status before cleanup to handle webhooks
 */

import {
  PaymentStatus,
  PaymentGateway,
  AppointmentStatus,
  OccurrenceCompletionStatus,
  type Prisma,
} from "@prisma/client";
import { isPreMintIntent } from "@/lib/payments/pre-mint-intent";
import {
  flushBackupInterestNotices,
  stageNoticesForAppointmentHolds,
  type StagedBackupInterestNotices,
} from "@/lib/booking/backup-interest";
import {
  finishSeatOpenedNotices,
  stageSeatOpenedNotices,
  type StagedSeatOpened,
} from "@/lib/booking/event-waitlist";
import {
  cancelRazorpayOrder,
  type RazorpayOrderCancelResult,
} from "../../lib/payments/core/razorpay";
import { reportSentryMessage } from "@/lib/observability/report";
import { reverseCreditsForPayment } from "@/lib/referrals/service";
import { returnDiscountUse } from "@/lib/payments/checkout/discount-use";
import { reverseBookingUtilization } from "@/lib/api/organizations/program-helpers";
import {
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
  transitionSubscriptionRequest,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import prisma, { type Tx, type PrismaLike } from "@/lib/prisma";
import { transitionParticipant } from "@/lib/booking/participants";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { lapseApprovedRequest } from "@/lib/booking/lapse-approved-request";
import {
  notifyConsulteeRequestExpired,
  PAY_LINK_LAPSED_REASON,
  type RequestExpiredNotice,
} from "@/lib/booking/expiry-notices";
import {
  PAYMENT_LINK_REMINDER_EMAIL_TYPE,
  sendPaymentLinkEmail,
} from "@/lib/email";
import { notifyPaymentLink } from "@/lib/novu/service";
import { reportStandingFinding } from "@/lib/observability/standing-finding";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { APPROVAL_PAYMENT_REMINDER_MS } from "@/lib/payments/constants";

/**
 * Result structure for cleanup operations
 */
export interface CleanupResult {
  success: boolean;
  cleanedCount: number;
  /** Rows whose status moved since the cohort read; left alone, not failures. */
  skippedCount: number;
  errorCount: number;
  totalProcessed: number;
  errors: string[];
}

export interface CleanupAbandonedOptions {
  /** #1356 — caps the cohort for the Netlify ticker; undefined keeps the
   * unbounded GitHub Actions behaviour. */
  limit?: number;
}

/**
 * Cancel payment intent with the appropriate payment gateway; resolves to what
 * the gateway still holds.
 */
export async function cancelPaymentIntent(
  paymentIntent: string,
  gateway: PaymentGateway,
): Promise<RazorpayOrderCancelResult> {
  // A pre-mint row never reached the gateway, so there is nothing to cancel there.
  if (isPreMintIntent(paymentIntent)) return "no_live_payment";
  try {
    switch (gateway) {
      // STRIPE has no client and no live orders; nothing to cancel.
      case PaymentGateway.STRIPE:
        return "no_live_payment";

      case PaymentGateway.RAZORPAY:
        return await cancelRazorpayOrder(paymentIntent);

      default:
        console.warn(`⚠️ Unknown payment gateway: ${gateway}`);
        return "unknown";
    }
  } catch (error) {
    console.error(
      `❌ Failed to cancel ${gateway} payment intent ${paymentIntent}:`,
      describeError(error),
    );
    throw error;
  }
}

/** Every catch in this sweep reports a failure the same way. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/** Both sweeps below report the same shape, so one printer keeps them in step. */
function logCleanupSummary(
  title: string,
  noun: string,
  result: CleanupResult,
): void {
  console.log(`\n📈 ${title}:`);
  console.log(`   ✅ Successfully cleaned: ${result.cleanedCount} ${noun}`);
  console.log(
    `   ⏭️ Skipped (status moved since the read): ${result.skippedCount} ${noun}`,
  );
  console.log(`   ❌ Failed to clean: ${result.errorCount} ${noun}`);
  console.log(`   📊 Total processed: ${result.totalProcessed} ${noun}`);

  if (result.totalProcessed > 0) {
    console.log(
      `   🎯 Success rate: ${((result.cleanedCount / result.totalProcessed) * 100).toFixed(1)}%`,
    );
  }

  if (result.errorCount > 0) {
    console.warn(
      `⚠️ ${result.errorCount} ${noun} failed to clean up - manual intervention may be required`,
    );
    result.errors.forEach((error, index) => {
      console.warn(`   ${index + 1}. ${error}`);
    });
  }
}

/** #1703 D2 — what a lapsed-link notice names, read by both cohorts. */
const LAPSED_LINK_PARTIES = {
  requestedBy: { select: { user: { select: { id: true, name: true } } } },
} as const;
const LAPSED_LINK_PLAN_SELECT = {
  select: {
    title: true,
    consultantProfile: { select: { user: { select: { name: true } } } },
  },
} as const;

type LapsedLinkRequest = {
  id: string;
  requestedBy: { user: { id: string; name: string | null } } | null;
};
type LapsedLinkPlan = {
  title: string;
  consultantProfile: { user: { name: string | null } } | null;
} | null;

/**
 * #1703 D2 — the one CAS a lapsed pay-link goes through, in whichever pass
 * reads the row first (the abandoned sweep sees a held slot's expired PENDING
 * payment before the approval sweep runs). `fromIn` is exactly
 * APPROVED_PENDING_PAYMENT, so a win means "the link lapsed" and nothing else;
 * the money predicate (no succeeded payment on the wrapper) rides in the WHERE.
 *
 * @returns true on the CAS win; false when the row was not a lapsed link
 *   (already moved, or in another status), with nothing written.
 */
async function expireLapsedPayLink(
  tx: Pick<Tx, "consultation" | "subscription" | "bookingStatusHistory">,
  kind: "consultation" | "subscription",
  id: string,
): Promise<boolean> {
  const unpaid = {
    payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
  } as const;
  try {
    switch (kind) {
      case "consultation":
        await transitionConsultationRequest(tx, {
          where: { id, appointment: unpaid },
          to: AppointmentStatus.EXPIRED,
          fromIn: [AppointmentStatus.APPROVED_PENDING_PAYMENT],
        });
        break;
      case "subscription":
        await transitionSubscriptionRequest(tx, {
          where: { id, appointment: unpaid },
          to: AppointmentStatus.EXPIRED,
          fromIn: [AppointmentStatus.APPROVED_PENDING_PAYMENT],
        });
        break;
    }
    return true;
  } catch (error) {
    if (!(error instanceof IllegalTransitionError)) throw error;
    return false;
  }
}

/** The consultee's notice for a lapsed link; sent by the caller after commit. */
function lapsedLinkNotice(
  kind: "consultation" | "subscription",
  request: LapsedLinkRequest,
  plan: LapsedLinkPlan,
  appointment: {
    id: string;
    organizationId: string | null;
    occurrences: { startsAt: Date }[];
  },
): RequestExpiredNotice | null {
  const consultee = request.requestedBy?.user;
  if (!consultee) return null;
  return {
    appointmentId: appointment.id,
    organizationId: appointment.organizationId,
    consulteeUserId: consultee.id,
    consulteeName: consultee.name ?? "Consultee",
    consultantName: plan?.consultantProfile?.user?.name ?? "Consultant",
    planTitle:
      plan?.title ??
      (kind === "consultation" ? "Consultation" : "Subscription"),
    appointmentType: kind === "consultation" ? "CONSULTATION" : "SUBSCRIPTION",
    startsAt: appointment.occurrences[0]?.startsAt ?? null,
    reason: PAY_LINK_LAPSED_REASON,
  };
}

/** A legacy row with no `expiresAt` lapses 5 min after the 30 min checkout hold. */
const LEGACY_HOLD_MS = 35 * 60 * 1000;

/** A PENDING payment whose own hold has lapsed; a sibling buyer's live hold never matches. */
function lapsedPendingPaymentWhere(now: Date): Prisma.PaymentWhereInput {
  return {
    paymentStatus: PaymentStatus.PENDING,
    OR: [
      { expiresAt: { lt: now } },
      {
        expiresAt: null,
        createdAt: { lt: new Date(now.getTime() - LEGACY_HOLD_MS) },
      },
    ],
  };
}

/**
 * What one cleanup unit needs loaded: only the payments `paymentWhere` selects
 * (the gateway cancel, the expiry, the credit restore and the seat release all
 * read this list), the parties a lapsed pay-link notice names, and the hold.
 */
function abandonedInclude(paymentWhere: Prisma.PaymentWhereInput) {
  return {
    payment: { where: paymentWhere },
    // #1703 D2 — a lapsed pay-link can be claimed here first; the notice
    // it sends after commit names these parties.
    consultation: {
      include: {
        ...LAPSED_LINK_PARTIES,
        consultationPlan: LAPSED_LINK_PLAN_SELECT,
      },
    },
    subscription: {
      include: {
        ...LAPSED_LINK_PARTIES,
        subscriptionPlan: LAPSED_LINK_PLAN_SELECT,
      },
    },
    webinar: true,
    class: true,
    occurrences: true,
  } satisfies Prisma.AppointmentInclude;
}

/**
 * The cohort: an appointment still holding a slot or a group seat against a
 * PENDING payment that has passed its expiry.
 */
function abandonedAppointmentWhere(
  lapsed: Prisma.PaymentWhereInput,
): Prisma.AppointmentWhereInput {
  return {
    deletedAt: null,
    payment: { some: lapsed },
    // Group-event seats are held by connecting the buyer to shared,
    // non-tentative slots, so a tentative-slot filter would never see an
    // abandoned webinar or class checkout.
    OR: [
      { occurrences: { some: { isTentative: true, deletedAt: null } } },
      { webinar: { isNot: null } },
      { class: { isNot: null } },
    ],
  };
}

function findAbandonedAppointments(limit?: number) {
  const lapsed = lapsedPendingPaymentWhere(new Date());
  return prisma.appointment.findMany({
    take: limit,
    // A skipped unit's `updatedAt` is touched, so it rotates behind the rest
    // of the cohort instead of heading every bounded run.
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    where: abandonedAppointmentWhere(lapsed),
    include: abandonedInclude(lapsed),
  });
}

type AbandonedAppointment = Awaited<
  ReturnType<typeof findAbandonedAppointments>
>[number];
type AbandonedPayment = AbandonedAppointment["payment"][number];

/**
 * FIX Issue #10 — a capture webhook can land between the cohort read and this
 * transaction, so the payment status is re-read inside it before anything is
 * touched.
 */
async function anyPaymentSucceeded(
  tx: Pick<Tx, "payment">,
  appointment: AbandonedAppointment,
): Promise<boolean> {
  for (const payment of appointment.payment) {
    const freshPayment = await tx.payment.findUnique({
      where: { id: payment.id },
    });

    if (freshPayment?.paymentStatus === PaymentStatus.SUCCEEDED) {
      console.log(
        JSON.stringify({
          event: "cleanup_skipped_payment_succeeded",
          paymentId: payment.id,
          appointmentId: appointment.id,
          reason: "Payment completed during cleanup processing",
          timestamp: new Date().toISOString(),
        }),
      );
      return true;
    }
  }
  return false;
}

/**
 * #1464 — where one appointment's failures are collected. `count` is mutated
 * in place rather than returned, because a gateway cancel is an external call
 * the caller's transaction cannot roll back: it must still reach `errorCount`
 * when the unit around it is rolled back and reported as skipped.
 */
interface FailureSink {
  /** Appended to `CleanupResult.errors`. */
  messages: string[];
  /** Added to `CleanupResult.errorCount` by the caller. */
  count: number;
  /** Payment ids whose order still has a live gateway payment; reported once per run. */
  liveSkips: string[];
}

/** One event per run for the orders skipped over a live payment, once per new id set. */
async function reportLiveGatewaySkips(paymentIds: string[]): Promise<void> {
  const message = "Abandoned sweep skipped an order with a live payment";
  await reportStandingFinding(
    {
      key: "cleanup-abandoned-payments:live-payment",
      ids: paymentIds,
      message,
    },
    () =>
      reportSentryMessage(message, {
        subsystem: "payments",
        expected: true,
        level: "warning",
        extra: {
          count: paymentIds.length,
          paymentIds: paymentIds.slice(0, 20),
        },
      }),
  );
}

/**
 * Mark the rows EXPIRED (timed out, not a gateway rejection).
 *
 * #1861 L2 — the gateway was already asked, outside the transaction, and every
 * payment here came back `no_live_payment`; a unit with a live or unproven
 * payment never reaches this. A capture that still lands after the row is
 * EXPIRED is the terminal race #1439 owns.
 */
async function expirePendingPayments(
  tx: Tx,
  payments: AbandonedPayment[],
): Promise<AbandonedPayment[]> {
  const expired: AbandonedPayment[] = [];
  // One-at-a-time and in cohort order: a deterministic write sequence.
  for (const payment of payments) {
    // Conditional on PENDING: a capture racing this sweep keeps SUCCEEDED.
    const { count } = await tx.payment.updateMany({
      where: { id: payment.id, paymentStatus: PaymentStatus.PENDING },
      data: { paymentStatus: PaymentStatus.EXPIRED },
    });
    if (count === 1) {
      await returnDiscountUse(tx, payment.id);
      await reverseBookingUtilization(tx, {
        paymentId: payment.id,
        reason: "Checkout abandoned",
      });
      expired.push(payment);
    }
  }
  return expired;
}

/**
 * #1459 — how many gateway cancels are in flight at once. The Netlify ticker
 * gives this sweep a 6 s budget (ADR 27) and one sequential round trip per
 * payment spent all of it on five stuck rows, so every tick aborted mid-sweep.
 * Five is enough to hide the latency without opening a burst the gateway would
 * rate-limit.
 */
const GATEWAY_CANCEL_CONCURRENCY = 5;

/**
 * #1459 — ceiling on a single cancel. Neither gateway client sets one, so a
 * hung connection would hold the whole batch past the ticker's timeout. A
 * timed-out cancel is `unknown`: the unit is skipped and retried next run.
 */
const GATEWAY_CANCEL_TIMEOUT_MS = 4_000;

async function cancelWithTimeout(
  paymentIntent: string,
  gateway: PaymentGateway,
): Promise<RazorpayOrderCancelResult> {
  // AbortSignal.timeout's timer does not hold the event loop open, so a cancel
  // that wins the race leaves nothing behind to keep the function alive.
  const signal = AbortSignal.timeout(GATEWAY_CANCEL_TIMEOUT_MS);
  return Promise.race([
    cancelPaymentIntent(paymentIntent, gateway),
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () =>
        reject(
          new Error(
            `Gateway cancel timed out after ${GATEWAY_CANCEL_TIMEOUT_MS} ms`,
          ),
        ),
      );
    }),
  ]);
}

/** #1861 L2 — one payment's gateway answer; `detail` explains an `unknown`. */
export interface GatewayIntentCheck {
  outcome: RazorpayOrderCancelResult;
  detail?: string;
}

/**
 * Cancel every payment's gateway intent with bounded concurrency.
 *
 * Exported for the concurrency pin: the ceiling is the whole point of the
 * function, and it is invisible from the outside of the sweep.
 *
 * @returns Every payment's answer, keyed by payment id. A cancel that threw or
 *   timed out is `unknown` (#1861 L2).
 */
export async function cancelGatewayIntents(
  payments: readonly Pick<
    AbandonedPayment,
    "id" | "paymentIntent" | "paymentGateway"
  >[],
): Promise<Map<string, GatewayIntentCheck>> {
  const checks = new Map<string, GatewayIntentCheck>();

  for (let i = 0; i < payments.length; i += GATEWAY_CANCEL_CONCURRENCY) {
    const chunk = payments.slice(i, i + GATEWAY_CANCEL_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((payment) =>
        cancelWithTimeout(payment.paymentIntent, payment.paymentGateway),
      ),
    );
    settled.forEach((outcome, j) => {
      checks.set(
        chunk[j].id,
        outcome.status === "fulfilled"
          ? { outcome: outcome.value }
          : { outcome: "unknown", detail: describeError(outcome.reason) },
      );
    });
  }

  return checks;
}

/**
 * #1861 L2 — true when every payment's order is proven empty. An `unknown` is
 * recorded AND counted, so the run reports `success: false` and retries next
 * tick; a live payment is a skip, left PENDING for reconcile-payment-status,
 * whose captures reach the #1861 L1 confirm-time tie-break. A consultation or
 * subscription slot is already free on the clock (buildDeadHoldFilter); an
 * event seat stays held until the gateway answers.
 */
function gatewayClearsExpiry(
  appointment: AbandonedAppointment,
  checks: Map<string, GatewayIntentCheck>,
  failures: FailureSink,
): boolean {
  let clear = true;
  for (const payment of appointment.payment) {
    const check: GatewayIntentCheck = checks.get(payment.id) ?? {
      outcome: "unknown",
    };
    if (check.outcome === "no_live_payment") continue;
    clear = false;
    if (check.outcome === "unknown") {
      const reason = check.detail ?? "gateway state could not be read";
      console.warn(
        `⚠️ Could not read gateway state for ${payment.paymentIntent}:`,
        reason,
      );
      failures.messages.push(
        `Payment cancellation failed for ${payment.paymentIntent}: ${reason}`,
      );
      failures.count++;
    } else {
      console.warn(
        JSON.stringify({
          event: "cleanup_skipped_gateway_has_live_payment",
          paymentId: payment.id,
          appointmentId: appointment.id,
          timestamp: new Date().toISOString(),
        }),
      );
      failures.liveSkips.push(payment.id);
    }
  }
  return clear;
}

/**
 * Restore referral credits consumed by these payments. The rows now survive
 * (soft-cancel below), so this is the whole point rather than an ordering trick
 * against a cascade.
 */
async function restoreReferralCredits(
  tx: Tx,
  payments: AbandonedPayment[],
): Promise<void> {
  for (const payment of payments) {
    try {
      const restored = await reverseCreditsForPayment(payment.id, tx);
      if (restored > 0) {
        console.log(
          `🔄 Restored ${restored} paise of referral credits from abandoned payment ${payment.id}`,
        );
      }
    } catch (creditError) {
      console.warn(
        `⚠️ Failed to restore credits for payment ${payment.id}:`,
        describeError(creditError),
      );
    }
  }
}

/**
 * Group events: release the HELD seat of each buyer whose own payment this unit
 * expired, on that payment's appointment only. A CONFIRMED or ATTENDED seat is
 * never released, and the shared occurrences stay for every other attendee.
 */
async function releaseGroupSeats(
  tx: Tx,
  appointment: AbandonedAppointment,
  expired: AbandonedPayment[],
  now: Date,
): Promise<StagedSeatOpened | null> {
  const kind = appointment.webinar ? "webinar" : "class";
  let total = 0;
  for (const payment of expired) {
    const released = await transitionParticipant(
      tx,
      { appointmentId: appointment.id, userId: payment.userId },
      "CANCELLED",
      { fromIn: ["HELD"] },
    );
    total += released;
    console.log(
      `🗑️ Released ${released} seat(s) for user ${payment.userId} on ${kind} appointment ${appointment.id}`,
    );
  }
  // Once per appointment, however many holds this unit lapsed.
  return total > 0 ? stageSeatOpenedNotices(tx, appointment.id, now) : null;
}

/**
 * Consultation / subscription: with no confirmed slot left, the request is
 * EXPIRED through the CAS and everything under it is tombstoned; with one, only
 * the tentative holds are released and the confirmed history stays.
 *
 * #1074 / #1319 — never delete an Appointment a Payment row points at. Deleting
 * the request cascaded the Appointment and with it every Payment (EXPIRED
 * intents, credit usage, a late capture's target). The slot is freed by status,
 * not absence.
 *
 * A CAS miss throws out of the caller's transaction on purpose: the payment
 * expiry and the credit restoration that ran ahead of it must roll back with it.
 */
async function expireRequestAndReleaseSlots(
  tx: Tx,
  appointment: AbandonedAppointment,
): Promise<{
  notice: RequestExpiredNotice | null;
  holdNotices: StagedBackupInterestNotices;
}> {
  const kind = appointment.consultation ? "consultation" : "subscription";
  const confirmedSlots = await tx.appointmentOccurrence.count({
    where: {
      appointmentId: appointment.id,
      isTentative: false,
      deletedAt: null,
    },
  });
  const now = new Date();

  if (confirmedSlots > 0) {
    // #1778 — the released holds tell anyone waiting on those times.
    const holdNotices = await stageNoticesForAppointmentHolds(
      tx,
      appointment.id,
    );
    // Only release the tentative slots; confirmed history stays.
    const released = await transitionOccurrenceCompletion(tx, {
      where: {
        appointmentId: appointment.id,
        isTentative: true,
        deletedAt: null,
      },
      to: OccurrenceCompletionStatus.CANCELLED,
      data: { deletedAt: now },
      allowZero: true,
    });
    console.log(
      `🗑️ Released ${released} tentative slot(s) for ${kind} appointment: ${appointment.id}`,
    );
    return {
      notice: null,
      holdNotices: holdNotices ?? { bells: [], emails: [] },
    };
  }

  // #1703 D2 — a lapsed pay-link is claimed by the narrow CAS first, so the
  // consultee's notice is tied to that win whichever pass got here.
  const request = appointment.consultation ?? appointment.subscription;
  let notice: RequestExpiredNotice | null = null;
  if (request && (await expireLapsedPayLink(tx, kind, request.id))) {
    notice = lapsedLinkNotice(
      kind,
      request,
      appointment.consultation?.consultationPlan ??
        appointment.subscription?.subscriptionPlan ??
        null,
      appointment,
    );
  } else if (appointment.consultation) {
    // The cohort's money predicate is repeated in the CAS WHERE, like the
    // approval and stale-pending arms. Status alone is not enough: the include
    // above only carries PENDING rows, and `reconcile-payment-status` flips a
    // recovered capture to SUCCEEDED without moving the request — so a sibling
    // or freshly-succeeded payment is invisible to a read-then-write. Re-checked
    // by the UPDATE itself, a paid booking matches zero rows and is skipped.
    await transitionConsultationRequest(tx, {
      where: {
        id: appointment.consultation.id,
        appointment: {
          payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
        },
      },
      to: AppointmentStatus.EXPIRED,
    });
  } else if (appointment.subscription) {
    // #1554 — one wrapper per subscription: the money predicate rides in the
    // CAS WHERE as "its wrapper carries no succeeded payment".
    await transitionSubscriptionRequest(tx, {
      where: {
        id: appointment.subscription.id,
        appointment: {
          payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
        },
      },
      to: AppointmentStatus.EXPIRED,
    });
  }

  // #1778 — the dead hold's times free: tell anyone waiting (same tx).
  const holdNotices = await stageNoticesForAppointmentHolds(tx, appointment.id);
  await transitionOccurrenceCompletion(tx, {
    where: { appointmentId: appointment.id, deletedAt: null },
    to: OccurrenceCompletionStatus.CANCELLED,
    data: { deletedAt: now },
    allowZero: true,
  });
  // The lapsed buyer's own 1:1 hold: its HELD seats are released with it.
  await transitionParticipant(
    tx,
    { appointmentId: appointment.id },
    "CANCELLED",
    { fromIn: ["HELD"] },
  );
  await tx.appointment.updateMany({
    where: { id: appointment.id, deletedAt: null },
    data: { deletedAt: now },
  });

  console.log(
    `🗑️ Expired abandoned ${kind} appointment (soft): ${appointment.id}`,
  );
  return {
    notice,
    holdNotices: holdNotices ?? { bells: [], emails: [] },
  };
}

/**
 * One appointment, one transaction: skip a capture that landed mid-sweep,
 * expire its payments, hand back the referral credits, then release the hold —
 * group seats for an event, request slots for a consultation or subscription.
 *
 * The CAS miss is caught OUTSIDE the transaction (the stale-pending sweep's
 * shape). Swallowing it inside would resolve the callback and commit the
 * payment expiry and credit restoration that ran before it, handing credits
 * back on a booking whose capture landed mid-transaction. Letting it escape
 * makes Prisma roll the whole unit back; only then is it counted as skipped.
 */
async function cleanupAbandonedAppointment(
  appointment: AbandonedAppointment,
  failures: FailureSink,
): Promise<{
  outcome: "cleaned" | "skipped";
  /** Set only when the lapsed-link CAS won inside the committed unit. */
  notice: RequestExpiredNotice | null;
}> {
  // #1861 L2 — the gateway round trips run BEFORE the transaction: under
  // PG_POOL_MAX=1 they held the only connection, and a paid order must keep
  // its row PENDING rather than be expired into a refund.
  const checks = await cancelGatewayIntents(appointment.payment);
  if (!gatewayClearsExpiry(appointment, checks, failures)) {
    return { outcome: "skipped", notice: null };
  }

  const now = new Date();
  try {
    const txOut = await prisma.$transaction(async (tx) => {
      if (await anyPaymentSucceeded(tx, appointment)) {
        return {
          outcome: "skipped" as const,
          notice: null,
          holdNotices: null,
          seatOpened: null,
        };
      }

      // Read Committed suffices: everything below is gated on this unit's own
      // PENDING → EXPIRED row-lock wins, which a capture's CAS cannot also win.
      const expired = await expirePendingPayments(tx, appointment.payment);
      if (expired.length === 0) {
        return {
          outcome: "skipped" as const,
          notice: null,
          holdNotices: null,
          seatOpened: null,
        };
      }
      await restoreReferralCredits(tx, expired);

      if (appointment.webinar || appointment.class) {
        return {
          outcome: "cleaned" as const,
          notice: null,
          holdNotices: null,
          seatOpened: await releaseGroupSeats(tx, appointment, expired, now),
        };
      }
      let notice: RequestExpiredNotice | null = null;
      let holdNotices: StagedBackupInterestNotices | null = null;
      if (appointment.consultation || appointment.subscription) {
        const expired = await expireRequestAndReleaseSlots(tx, appointment);
        notice = expired.notice;
        holdNotices = expired.holdNotices;
      }
      return {
        outcome: "cleaned" as const,
        notice,
        holdNotices,
        seatOpened: null,
      };
    });
    await flushBackupInterestNotices(txOut.holdNotices);
    await finishSeatOpenedNotices(txOut.seatOpened);
    return { outcome: txOut.outcome, notice: txOut.notice };
  } catch (error) {
    // Raced a capture or an approval: the row moved out of the expirable set,
    // or its payment succeeded, since the cohort read. The transaction is
    // rolled back by the time this runs — nothing above it was committed.
    if (!(error instanceof IllegalTransitionError)) throw error;
    console.log(
      `⏭️ Skipped appointment ${appointment.id} — status changed, or the payment succeeded, since the sweep read`,
    );
    return { outcome: "skipped", notice: null };
  }
}

/**
 * #1757 — retire ONE PENDING payment the gateway has no record of, through the
 * same per-appointment unit the abandoned sweep runs (expire the row, hand back
 * referral credits, release the hold or seat). Rows with no `expiresAt` and no
 * tentative hold never enter that sweep's cohort, which is why
 * reconcile-payment-status calls this directly once the row is old enough.
 * A payment with no appointment holds nothing: it is expired and its credits
 * are reversed inside one transaction.
 */
export async function retireOrphanPendingPayment(
  paymentId: string,
): Promise<{ outcome: "retired" | "skipped"; errors: string[] }> {
  const orphan = { id: paymentId, paymentStatus: PaymentStatus.PENDING };
  const appointment = await prisma.appointment.findFirst({
    where: { payment: { some: orphan } },
    include: {
      ...abandonedInclude(orphan),
      _count: { select: { payment: true } },
    },
  });

  if (appointment) {
    // #1761 CodeRabbit — a sibling SUCCEEDED/PENDING payment means this
    // appointment isn't the orphan's alone to tear down; leave it be.
    if (appointment._count.payment > 1) {
      return {
        outcome: "skipped",
        errors: [
          `Appointment ${appointment.id} has ${appointment._count.payment} payments; not retiring orphan ${paymentId}`,
        ],
      };
    }
    // The include loads only the orphan row, so a sibling checkout is left alone.
    const failures: FailureSink = { messages: [], count: 0, liveSkips: [] };
    const { outcome, notice } = await cleanupAbandonedAppointment(
      appointment,
      failures,
    );
    await reportLiveGatewaySkips(failures.liveSkips);
    if (outcome === "cleaned" && notice) {
      await notifyConsulteeRequestExpired(notice);
    }
    return {
      outcome: outcome === "cleaned" ? "retired" : "skipped",
      errors: failures.messages,
    };
  }

  const claimed = await prisma.$transaction(async (tx) => {
    // Conditional on PENDING: a capture racing this keeps SUCCEEDED.
    const { count } = await tx.payment.updateMany({
      where: { id: paymentId, paymentStatus: PaymentStatus.PENDING },
      data: { paymentStatus: PaymentStatus.EXPIRED },
    });
    if (count === 0) return false;
    await reverseCreditsForPayment(paymentId, tx);
    await returnDiscountUse(tx, paymentId);
    await reverseBookingUtilization(tx, {
      paymentId,
      reason: "Orphan checkout retired",
    });
    return true;
  });
  return { outcome: claimed ? "retired" : "skipped", errors: [] };
}

/**
 * Moves a skipped or failed unit to the back of the `updatedAt asc` cohort, so a
 * permanently unreadable gateway state cannot head-of-line block a bounded run.
 */
async function rotateUnit(appointmentId: string): Promise<void> {
  try {
    await prisma.appointment.updateMany({
      where: { id: appointmentId },
      data: { updatedAt: new Date() },
    });
  } catch (error) {
    console.warn(
      `⚠️ Could not rotate appointment ${appointmentId}:`,
      describeError(error),
    );
  }
}

/**
 * Clean up abandoned payments and appointments
 *
 * Finds appointments with:
 * - Pending payments that have expired (or legacy payments older than 35 min)
 * - Tentative slots that need to be released
 *
 * @returns CleanupResult with counts and error details
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function cleanupAbandonedPayments(
  opts: CleanupAbandonedOptions = {},
): Promise<CleanupResult> {
  return withCronLock(
    "cleanup-abandoned-payments",
    { failMode: "closed" },
    () => cleanupAbandonedPaymentsUnlocked(opts),
  );
}

async function cleanupAbandonedPaymentsUnlocked(
  opts: CleanupAbandonedOptions = {},
): Promise<CleanupResult> {
  console.log("🧹 Starting abandoned payment cleanup...");

  const result: CleanupResult = {
    success: false,
    cleanedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    totalProcessed: 0,
    errors: [],
  };

  try {
    const abandonedAppointments = await findAbandonedAppointments(opts.limit);

    result.totalProcessed = abandonedAppointments.length;
    console.log(
      `📊 Found ${abandonedAppointments.length} abandoned appointments to clean up`,
    );

    const liveSkips: string[] = [];
    for (const appointment of abandonedAppointments) {
      // #1464 — per appointment, so the gateway failures counted below belong
      // to this one and are not added again for the next.
      const failures: FailureSink = {
        messages: result.errors,
        count: 0,
        liveSkips,
      };
      try {
        const { outcome, notice } = await cleanupAbandonedAppointment(
          appointment,
          failures,
        );

        // #1861 L2 — a gateway state that could not be read skipped the unit
        // and fails the run, so an operator sees it and the next tick retries.
        result.errorCount += failures.count;

        if (outcome === "skipped") {
          result.skippedCount++;
          await rotateUnit(appointment.id);
        } else {
          result.cleanedCount++;
          console.log(
            `✅ Successfully cleaned up appointment: ${appointment.id}`,
          );
          // #1703 D2 — after the commit, and only on the lapsed-link CAS win.
          if (notice) await notifyConsulteeRequestExpired(notice);
        }
      } catch (error) {
        // Both: a gateway cancel that failed pushed its own line into
        // `errors`, so the count has to match or the summary contradicts the
        // list it prints.
        result.errorCount += failures.count + 1;
        const errorMessage = describeError(error);
        console.error(
          `❌ Failed to clean up appointment ${appointment.id}:`,
          errorMessage,
        );
        result.errors.push(
          `Appointment cleanup failed for ${appointment.id}: ${errorMessage}`,
        );
        await rotateUnit(appointment.id);
      }
    }

    await reportLiveGatewaySkips(liveSkips);
    result.success = result.errorCount === 0;
    logCleanupSummary("Cleanup Summary", "appointments", result);
  } catch (error) {
    const errorMessage = describeError(error);
    console.error("❌ Cleanup job failed:", errorMessage);
    result.errors.push(`Job failed: ${errorMessage}`);
    result.success = false;
  }

  return result;
}

/**
 * Cleanup expired APPROVED_PENDING_PAYMENT consultations
 *
 * FIX for orphaned payment bug:
 * When a consultant approves a consultation and payment expires,
 * the consultation status remains APPROVED_PENDING_PAYMENT forever,
 * blocking the slot permanently. This function resets those consultations.
 *
 * @returns CleanupResult with counts and error details
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-closed: money state must not double-run unlocked.
export async function cleanupExpiredApprovalPendingPayments(
  opts: CleanupAbandonedOptions = {},
): Promise<CleanupResult> {
  return withCronLock(
    "cleanup-abandoned-payments",
    { failMode: "closed" },
    () => cleanupExpiredApprovalPendingPaymentsUnlocked(opts),
  );
}

async function cleanupExpiredApprovalPendingPaymentsUnlocked(
  opts: CleanupAbandonedOptions = {},
): Promise<CleanupResult> {
  console.log(
    "🧹 Starting cleanup of expired APPROVED_PENDING_PAYMENT requests...",
  );

  const result: CleanupResult = {
    success: false,
    cleanedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    totalProcessed: 0,
    errors: [],
  };

  try {
    // Both request kinds stuck in APPROVED_PENDING_PAYMENT with a lapsed
    // PENDING payment. #1732 — subscriptions used to fall through here (this
    // read was consultations-only, and the abandoned sweep needs a tentative
    // occurrence a placeholder subscription appointment does not have), so
    // their pay-link lapse only ever reached the 7 d updatedAt fallback.
    const lapsedWhere = lapsedApprovalRequestWhere(new Date());
    const lapsedAppointment = {
      include: {
        payment: { where: { paymentStatus: PaymentStatus.PENDING } },
        occurrences: true,
      },
    } as const;
    // One `limit` bounds the run, split across the two kinds; undefined
    // (the Actions run) stays unbounded on both.
    const perKind =
      opts.limit === undefined ? undefined : Math.ceil(opts.limit / 2);
    const [expiredConsultations, expiredSubscriptions] = await Promise.all([
      prisma.consultation.findMany({
        take: perKind,
        // Oldest-first with an id tie-break: a bounded run drains the tail too.
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        where: lapsedWhere,
        include: {
          appointment: lapsedAppointment,
          // #1703 D2 — what the consultee's expiry notice names.
          ...LAPSED_LINK_PARTIES,
          consultationPlan: LAPSED_LINK_PLAN_SELECT,
        },
      }),
      prisma.subscription.findMany({
        take: perKind,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        where: lapsedWhere,
        include: {
          appointment: lapsedAppointment,
          ...LAPSED_LINK_PARTIES,
          subscriptionPlan: LAPSED_LINK_PLAN_SELECT,
        },
      }),
    ]);

    result.totalProcessed =
      expiredConsultations.length + expiredSubscriptions.length;
    console.log(
      `📊 Found ${expiredConsultations.length} consultations and ${expiredSubscriptions.length} subscriptions with a lapsed pay-link`,
    );

    for (const consultation of expiredConsultations) {
      await expireOneLapsedRequest(
        "consultation",
        consultation,
        consultation.consultationPlan,
        result,
      );
    }
    for (const subscription of expiredSubscriptions) {
      await expireOneLapsedRequest(
        "subscription",
        subscription,
        subscription.subscriptionPlan,
        result,
      );
    }

    result.success = result.errorCount === 0;
    logCleanupSummary("Expired Request Cleanup Summary", "requests", result);
  } catch (error) {
    const errorMessage = describeError(error);
    console.error("❌ Expired request cleanup failed:", errorMessage);
    result.errors.push(`Job failed: ${errorMessage}`);
    result.success = false;
  }

  return result;
}

/** An approval request whose PENDING pay-link has lapsed (consultation or subscription). */
function lapsedApprovalRequestWhere(now: Date) {
  return {
    status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
    appointment: {
      payment: {
        some: {
          AND: [
            { paymentStatus: PaymentStatus.PENDING },
            { expiresAt: { lt: now } },
          ],
        },
      },
    },
  } satisfies Prisma.ConsultationWhereInput & Prisma.SubscriptionWhereInput;
}

/**
 * One lapsed approval request: the shared lapse core (#1775 — the request
 * CAS with the money predicate in its WHERE, the tentative-hold release by
 * status, the PENDING → EXPIRED order tombstone), then the consultee notice
 * on the win. #1319 — EXPIRED, not REJECTED: REJECTED reads as "the
 * consultant declined" on every surface, and the CAS keeps a capture that
 * raced this sweep from being clobbered.
 */
async function expireOneLapsedRequest(
  kind: "consultation" | "subscription",
  request: LapsedLinkRequest & {
    appointment: {
      id: string;
      organizationId: string | null;
      occurrences: { startsAt: Date }[];
    } | null;
  },
  plan: LapsedLinkPlan,
  result: CleanupResult,
): Promise<void> {
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const { moved, holdNotices } = await lapseApprovedRequest(tx, {
        kind,
        id: request.id,
        reason: "PAYMENT_LAPSED",
        actorUserId: null,
      });
      if (moved === 0) {
        console.log(
          `⏭️ Skipped ${kind} ${request.id} — status changed since the sweep read`,
        );
        return { status: "skipped" as const, holdNotices: undefined };
      }
      console.log(
        `✅ Reset ${kind} ${request.id} from APPROVED_PENDING_PAYMENT to EXPIRED`,
      );
      return { status: "cleaned" as const, holdNotices };
    });

    if (outcome.status === "skipped") {
      result.skippedCount++;
      return;
    }
    result.cleanedCount++;
    await flushBackupInterestNotices(outcome.holdNotices);
    // #1703 D2 — after the commit: the consultee learns the link lapsed.
    const notice = request.appointment
      ? lapsedLinkNotice(kind, request, plan, request.appointment)
      : null;
    if (notice) await notifyConsulteeRequestExpired(notice);
  } catch (error) {
    result.errorCount++;
    const errorMessage = describeError(error);
    console.error(`❌ Failed to clean up ${kind} ${request.id}:`, errorMessage);
    result.errors.push(
      `${kind === "consultation" ? "Consultation" : "Subscription"} cleanup failed for ${request.id}: ${errorMessage}`,
    );
  }
}

/**
 * #1703 D2 — the half-window reminder. A request approved but unpaid gets one
 * nudge when half the pay-link window is left (12 h of 24). State-as-outbox
 * (ADR 27): the guard is the FailedEmail row the first send staged, keyed on
 * `payment:<id>` + the reminder email type, so a re-run finds it and skips.
 * Never after payment (the cohort and a re-read require a PENDING payment on
 * an APPROVED_PENDING_PAYMENT request) and never after expiry (`expiresAt`
 * must still be ahead).
 */
export async function remindApprovalPaymentsDue(
  opts: CleanupAbandonedOptions = {},
): Promise<CleanupResult> {
  return withCronLock(
    "cleanup-abandoned-payments",
    { failMode: "closed" },
    () => remindApprovalPaymentsDueUnlocked(opts),
  );
}

/** The window read: PENDING, still payable, and inside the last half. */
function reminderPaymentWindowWhere(now: Date) {
  return {
    paymentStatus: PaymentStatus.PENDING,
    expiresAt: {
      gt: now,
      lte: new Date(now.getTime() + APPROVAL_PAYMENT_REMINDER_MS),
    },
  } as const;
}

/** A request whose pay-link sits in the reminder window; consultation has no tombstone. */
function reminderRequestWhere(
  paymentWhere: ReturnType<typeof reminderPaymentWindowWhere>,
) {
  return {
    status: AppointmentStatus.APPROVED_PENDING_PAYMENT,
    pendingPaymentUrl: { not: null },
    appointment: { deletedAt: null, payment: { some: paymentWhere } },
  } satisfies Prisma.ConsultationWhereInput;
}

function subscriptionReminderRequestWhere(
  paymentWhere: ReturnType<typeof reminderPaymentWindowWhere>,
) {
  return {
    ...reminderRequestWhere(paymentWhere),
    deletedAt: null,
  } satisfies Prisma.SubscriptionWhereInput;
}

const REMINDER_PARTY_SELECT = {
  requestedBy: {
    select: { user: { select: { id: true, name: true, email: true } } },
  },
} as const;

type ReminderCandidate = {
  requestId: string;
  kind: "consultation" | "subscription";
  /** The cohort order key, kept so the merged list keeps oldest-first. */
  updatedAt: Date;
  pendingPaymentUrl: string;
  consultee: { id: string; name: string | null; email: string | null };
  consultantName: string;
  payment: { id: string; amount: number; currency: string; expiresAt: Date };
};

async function findReminderCandidates(
  now: Date,
  limit: number | undefined,
): Promise<ReminderCandidate[]> {
  const paymentWhere = reminderPaymentWindowWhere(now);
  const paymentSelect = {
    where: paymentWhere,
    select: { id: true, amount: true, currency: true, expiresAt: true },
    take: 1,
  } as const;
  const [consultations, subscriptions] = await Promise.all([
    prisma.consultation.findMany({
      take: limit,
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      where: reminderRequestWhere(paymentWhere),
      select: {
        id: true,
        updatedAt: true,
        pendingPaymentUrl: true,
        ...REMINDER_PARTY_SELECT,
        consultationPlan: {
          select: {
            consultantProfile: { select: { user: { select: { name: true } } } },
          },
        },
        appointment: { select: { payment: paymentSelect } },
      },
    }),
    prisma.subscription.findMany({
      take: limit,
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      where: subscriptionReminderRequestWhere(paymentWhere),
      select: {
        id: true,
        updatedAt: true,
        pendingPaymentUrl: true,
        ...REMINDER_PARTY_SELECT,
        subscriptionPlan: {
          select: {
            consultantProfile: { select: { user: { select: { name: true } } } },
          },
        },
        appointment: { select: { payment: paymentSelect } },
      },
    }),
  ]);

  const candidates: ReminderCandidate[] = [];
  for (const row of consultations) {
    const payment = row.appointment?.payment[0];
    if (!payment?.expiresAt || !row.pendingPaymentUrl) continue;
    candidates.push({
      requestId: row.id,
      kind: "consultation",
      updatedAt: row.updatedAt,
      pendingPaymentUrl: row.pendingPaymentUrl,
      consultee: row.requestedBy.user,
      consultantName:
        row.consultationPlan.consultantProfile.user.name ?? "Consultant",
      payment: { ...payment, expiresAt: payment.expiresAt },
    });
  }
  for (const row of subscriptions) {
    const payment = row.appointment?.payment[0];
    if (!payment?.expiresAt || !row.pendingPaymentUrl) continue;
    candidates.push({
      requestId: row.id,
      kind: "subscription",
      updatedAt: row.updatedAt,
      pendingPaymentUrl: row.pendingPaymentUrl,
      consultee: row.requestedBy.user,
      consultantName:
        row.subscriptionPlan.consultantProfile.user.name ?? "Consultant",
      payment: { ...payment, expiresAt: payment.expiresAt },
    });
  }
  // Each read took `limit`; the pass is bounded by one `limit`, so the merged
  // oldest-first list is cut once more.
  candidates.sort((a, b) => {
    const byTime = a.updatedAt.getTime() - b.updatedAt.getTime();
    if (byTime !== 0) return byTime;
    if (a.requestId === b.requestId) return 0;
    return a.requestId < b.requestId ? -1 : 1;
  });
  return limit === undefined ? candidates : candidates.slice(0, limit);
}

/** The outbox rows the earlier reminders staged, by payment id. */
async function alreadyReminded(paymentIds: string[]): Promise<Set<string>> {
  if (paymentIds.length === 0) return new Set();
  const rows = await prisma.failedEmail.findMany({
    where: {
      emailType: PAYMENT_LINK_REMINDER_EMAIL_TYPE,
      entityRef: { in: paymentIds.map((id) => `payment:${id}`) },
    },
    select: { entityRef: true },
  });
  return new Set(
    rows.flatMap((r) =>
      r.entityRef ? [r.entityRef.slice("payment:".length)] : [],
    ),
  );
}

async function remindApprovalPaymentsDueUnlocked(
  opts: CleanupAbandonedOptions = {},
): Promise<CleanupResult> {
  console.log("⏰ Starting approval pay-link reminders...");
  const result: CleanupResult = {
    success: false,
    cleanedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    totalProcessed: 0,
    errors: [],
  };

  try {
    const now = new Date();
    const candidates = await findReminderCandidates(now, opts.limit);
    const reminded = await alreadyReminded(candidates.map((c) => c.payment.id));
    result.totalProcessed = candidates.length;

    for (const candidate of candidates) {
      try {
        if (reminded.has(candidate.payment.id)) {
          result.skippedCount++;
          continue;
        }
        // Re-read at send time: a capture or the sweep may have moved the row
        // since the cohort read, and a reminder after either is wrong.
        const fresh = await prisma.payment.findUnique({
          where: { id: candidate.payment.id },
          select: { paymentStatus: true, expiresAt: true },
        });
        if (
          fresh?.paymentStatus !== PaymentStatus.PENDING ||
          !fresh.expiresAt ||
          fresh.expiresAt <= new Date()
        ) {
          result.skippedCount++;
          continue;
        }
        if (!candidate.consultee.email) {
          result.skippedCount++;
          continue;
        }
        const sent = await sendPaymentLinkEmail({
          email: candidate.consultee.email,
          name: candidate.consultee.name ?? "User",
          consultantName: candidate.consultantName,
          appointmentType: candidate.kind,
          amount: candidate.payment.amount,
          currency: candidate.payment.currency,
          paymentUrl: candidate.pendingPaymentUrl,
          expiresAt: candidate.payment.expiresAt,
          paymentId: candidate.payment.id,
          reminder: true,
        });
        if (sent.staged) {
          // Sent or awaiting the relay: the row exists, so the once-guard
          // holds. A send with no row would repeat next pass, so it is not
          // counted as done.
          const bellResult = await notifyPaymentLink(
            candidate.consultee.id,
            {
              paymentId: candidate.payment.id,
              appointmentId: candidate.requestId,
              amount: candidate.payment.amount,
              currency: candidate.payment.currency,
              consultantName: candidate.consultantName,
              appointmentType:
                candidate.kind === "consultation"
                  ? "CONSULTATION"
                  : "SUBSCRIPTION",
              paymentUrl: candidate.pendingPaymentUrl,
              expiresAt: candidate.payment.expiresAt,
              reminder: true,
            },
            `payment-link-remind:${candidate.payment.id}:auto`,
            { deferAttempt: true },
          ).catch(() => null);
          await flushNotificationsAfter(
            { bells: [bellResult?.staged] },
            "cleanup-abandoned-payments.remind",
          );
          result.cleanedCount++;
        } else {
          result.errorCount++;
          result.errors.push(
            `Reminder for ${candidate.kind} ${candidate.requestId} ${
              sent.success ? "sent without its guard row" : "did not send"
            }`,
          );
        }
      } catch (error) {
        result.errorCount++;
        const errorMessage = describeError(error);
        result.errors.push(
          `Reminder failed for ${candidate.kind} ${candidate.requestId}: ${errorMessage}`,
        );
      }
    }

    result.success = result.errorCount === 0;
    logCleanupSummary("Pay-link Reminder Summary", "reminders", result);
  } catch (error) {
    const errorMessage = describeError(error);
    console.error("❌ Pay-link reminder pass failed:", errorMessage);
    result.errors.push(`Job failed: ${errorMessage}`);
    result.success = false;
  }

  return result;
}

/**
 * Run all cleanup tasks
 *
 * Executes both abandoned payment cleanup and expired consultation cleanup.
 * Disconnects from database when complete.
 *
 * @returns Combined results from both cleanup operations
 */
export async function runAllCleanupTasks(): Promise<{
  paymentResult: CleanupResult;
  consultationResult: CleanupResult;
  reminderResult: CleanupResult;
  overallSuccess: boolean;
}> {
  const startTime = Date.now();
  console.log(`🚀 Starting cleanup job at ${new Date().toISOString()}`);

  try {
    // Run abandoned payment cleanup
    const paymentResult = await cleanupAbandonedPayments();

    // Run expired consultation cleanup
    const consultationResult = await cleanupExpiredApprovalPendingPayments();

    // #1703 D2 — the half-window reminder rides the same run.
    const reminderResult = await remindApprovalPaymentsDue();

    const duration = (Date.now() - startTime) / 1000;
    console.log(`⏱️ Job completed in ${duration.toFixed(2)} seconds`);

    // Combined summary
    console.log(`\n📊 Overall Cleanup Summary:`);
    console.log(
      `   🧹 Abandoned payments cleaned: ${paymentResult.cleanedCount}`,
    );
    console.log(
      `   🧹 Expired consultations reset: ${consultationResult.cleanedCount}`,
    );
    console.log(
      `   ⏰ Pay-link reminders sent: ${reminderResult.cleanedCount}`,
    );
    console.log(
      `   ❌ Total errors: ${paymentResult.errorCount + consultationResult.errorCount + reminderResult.errorCount}`,
    );

    const overallSuccess =
      paymentResult.success &&
      consultationResult.success &&
      reminderResult.success;

    return {
      paymentResult,
      consultationResult,
      reminderResult,
      overallSuccess,
    };
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * True when any of the three registry passes (abandoned holds, lapsed pay-links,
 * due reminders) has a candidate row. Reminder candidates already reminded still count.
 */
export async function hasAbandonedPaymentWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const appointment = await db.appointment.findFirst({
    where: abandonedAppointmentWhere(lapsedPendingPaymentWhere(now)),
    select: { id: true },
  });
  if (appointment) return true;
  const reminderWindow = reminderPaymentWindowWhere(now);
  if (outOfTime()) return true;
  const consultation = await db.consultation.findFirst({
    where: {
      OR: [
        lapsedApprovalRequestWhere(now),
        reminderRequestWhere(reminderWindow),
      ],
    },
    select: { id: true },
  });
  if (consultation) return true;
  if (outOfTime()) return true;
  const subscription = await db.subscription.findFirst({
    where: {
      OR: [
        lapsedApprovalRequestWhere(now),
        subscriptionReminderRequestWhere(reminderWindow),
      ],
    },
    select: { id: true },
  });
  return subscription !== null;
}

/**
 * Disconnect from the database
 * Call this when done using the cleanup functions if not using runAllCleanupTasks
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

// Run the cleanup if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllCleanupTasks()
    .then(({ overallSuccess }) => {
      if (overallSuccess) {
        console.log("🎉 Cleanup job completed successfully");
        process.exit(0);
      } else {
        console.error("❌ Cleanup job completed with errors");
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error("💥 Cleanup job failed:", error);
      process.exit(1);
    });
}

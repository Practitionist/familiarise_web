/**
 * #830 — orphaned-confirmation re-drive.
 *
 * A crash (or a blocked #827 conflict) between payment capture and slot
 * confirmation leaves a SUCCEEDED payment whose slots are still
 * isTentative=true: the buyer paid, holds no confirmed booking, and the
 * tentative rows block rebooking of those times. Nothing re-drove these —
 * reconcile-payment-status only logged "may need manual appointment
 * creation".
 *
 * This sweep finds that orphan class and re-runs confirmExistingAppointment
 * under the same Serializable + retry discipline as the webhook path. The
 * #827 first-confirmed-wins recheck inside it stays in force: a genuine
 * double-booking loser is NOT force-confirmed — it stays tentative with its
 * CONFIRMATION_BLOCKED_DOUBLE_BOOKING system event, and this sweep reports
 * it for the refund path instead of fighting the guard.
 *
 * #1356 — a second pass rides the same sweep, for the other half of a capture
 * that only half-happened. The Stream chat channel is created after the
 * confirmation commits, fire-and-forget, so the same crash window that strands
 * a tentative slot also strands the buyer's conversation. That leg now stamps
 * `Appointment.chatChannelEnsuredAt` when it succeeds, which turns "confirmed,
 * paid, still NULL" into an exact work queue — state-as-outbox, no queue table.
 * See ADR 27.
 */
import prisma from "@/lib/prisma";
import { PaymentStatus, Prisma, RefundStatus } from "@prisma/client";
import { confirmExistingAppointment } from "@/lib/payments/webhooks/handlers";
import { liveOccurrenceWhere } from "@/lib/appointments/occurrences";
import { ensureChannelsForAppointment } from "@/lib/payments/webhooks/ensure-channels";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { DmNotPermittedError } from "@/lib/stream/dm-eligibility";
import * as Sentry from "@sentry/nextjs";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import {
  isFreeCreditIntent,
  isInternalFundedIntent,
} from "@/lib/payments/funding-rail";
import { RefundValidationError } from "@/lib/payments/operations/refund";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import { claimAndNotifyOnce } from "@/lib/cron/cas-notice";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import { reportSentryMessage } from "@/lib/observability/report";

export interface OrphanedConfirmationResult {
  success: boolean;
  scanned: number;
  confirmed: number;
  stillBlocked: number;
  /** #1356 — appointments whose chat channel this run created and stamped. */
  channelsEnsured: number;
  /** #1356 — appointments still without a channel; retried next run. */
  channelsFailed: number;
  /** #1708 — appointments whose channel can never be ensured; stamped out of the queue. */
  channelsSkipped: number;
  /** #1391 — buyer-level Stream operations the channel pass spent this run. */
  channelBuyerOps: number;
  /** #1391 — selected appointments the buyer-operation budget left for the next run. */
  channelsDeferred: number;
}

// #1391 — the channel pass needs a ceiling of its own, in the unit it actually
// spends: one outbound Stream round trip per paid buyer, at Stream's latency,
// against the Netlify ticker's 26 s function ceiling. The operator's `limit`
// governs the confirmation pass, but it reaches 500 and a webinar appointment
// can carry hundreds of buyers, so `limit` alone bounds nothing here. #1356
const CHANNEL_PASS_MAX_APPOINTMENTS = 100;
const CHANNEL_PASS_MAX_BUYER_OPS = 500;

// #1439 — pulled out of the channel pass's loop body to keep that loop's
// cognitive complexity readable; the budget accounting and the
// ensured/failed counters stay with the caller since they govern the loop's
// own control flow (the deferred-budget break), not this one appointment's
// outcome.
type OrphanChannelOutcome = "ensured" | "skipped" | "failed";

// #1708 — no retry can make this pair's channel succeed, so the row leaves the
// `chatChannelEnsuredAt IS NULL` queue; rationale in the cron reference.
async function markChannelTerminal(
  appointmentId: string,
  reason: string,
): Promise<void> {
  await prisma.appointment.updateMany({
    where: { id: appointmentId, chatChannelEnsuredAt: null },
    data: { chatChannelEnsuredAt: new Date() },
  });
  console.warn(
    `💬 Chat channel for appointment ${appointmentId} marked terminal: ${reason}`,
  );
}

async function ensureChannelForOrphan(
  appointmentId: string,
): Promise<OrphanChannelOutcome> {
  try {
    const result = await ensureChannelsForAppointment(appointmentId);
    if (result.ensured) {
      console.log(`💬 Ensured chat channel for appointment ${appointmentId}`);
      return "ensured";
    }
    if (result.reason === "no_channel_branch_for_appointment") {
      await markChannelTerminal(appointmentId, result.reason);
      return "skipped";
    }
    console.warn(
      `💬 Could not ensure chat channel for appointment ${appointmentId}: ${result.reason}`,
    );
    return "failed";
  } catch (err) {
    if (err instanceof DmNotPermittedError) {
      await markChannelTerminal(appointmentId, err.message);
      return "skipped";
    }
    console.error(
      `❌ Chat-channel ensure failed for appointment ${appointmentId}:`,
      err,
    );
    return "failed";
  }
}

// #476 — fail-closed: re-driving a confirmation twice is guarded by the
// idempotent slot flip, but the entry must not run unlocked regardless.
export async function reconcileOrphanedConfirmations(
  opts: { graceMinutes?: number; limit?: number } = {},
): Promise<OrphanedConfirmationResult> {
  return withCronLock(
    "reconcile-orphaned-confirmations",
    { failMode: "closed" },
    () => reconcileOrphanedConfirmationsUnlocked(opts),
  );
}

async function reconcileOrphanedConfirmationsUnlocked(
  opts: { graceMinutes?: number; limit?: number } = {},
): Promise<OrphanedConfirmationResult> {
  const graceMinutes = opts.graceMinutes ?? 15;
  const limit = opts.limit ?? 200;
  // #1356 — the channel pass is bounded separately and much lower: each entry
  // is an outbound Stream round trip, and the caller that matters is a Netlify
  // ticker with a function ceiling, not a GitHub Actions job with minutes to
  // spend. An explicit `limit` from that caller lowers this pass too, but can
  // never raise it past the ceiling above.
  const channelLimit = Math.min(
    opts.limit ?? 50,
    CHANNEL_PASS_MAX_APPOINTMENTS,
  );
  const cutoff = new Date(Date.now() - graceMinutes * 60_000);

  const orphans = await prisma.payment.findMany({
    where: {
      paymentStatus: "SUCCEEDED",
      updatedAt: { lt: cutoff },
      appointmentId: { not: null },
      // FAMILIARISE_WEB-46 — a rescheduled-away row keeps isTentative and
      // would be re-driven every tick; only a live hold is an orphan.
      appointment: {
        occurrences: { some: { isTentative: true, ...liveOccurrenceWhere } },
      },
    },
    select: {
      id: true,
      appointmentId: true,
      userId: true,
      expiresAt: true,
      capturedAt: true,
    },
    take: limit,
  });

  let confirmed = 0;
  let stillBlocked = 0;
  for (const orphan of orphans) {
    try {
      await withSerializableRetry(() =>
        prisma.$transaction(
          async (tx) => {
            await confirmExistingAppointment(
              tx,
              orphan.appointmentId!,
              orphan.userId,
              // #1861 L1 — a capture that landed after its hold lapsed keeps
              // yielding to a live foreign hold on re-drive (its auto-refund
              // failed), not just on the first webhook pass.
              {
                holdExpired:
                  orphan.expiresAt !== null &&
                  orphan.capturedAt !== null &&
                  orphan.capturedAt > orphan.expiresAt,
              },
            );
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 10_000,
            timeout: 15_000,
          },
        ),
      );
      // Live holds only: the tentative sweeps release by status now, so a
      // released row keeps isTentative and an unfiltered count would report a
      // successful re-drive as still blocked.
      const remaining = await prisma.appointmentOccurrence.count({
        where: {
          appointmentId: orphan.appointmentId!,
          isTentative: true,
          ...liveOccurrenceWhere,
        },
      });
      if (remaining === 0) {
        confirmed += 1;
        console.log(
          `✅ Re-drove confirmation for appointment ${orphan.appointmentId} (payment ${orphan.id})`,
        );
      } else {
        // The #827 guard blocked it — a real conflict; the system event it
        // recorded routes the refund. Count, don't fight.
        stillBlocked += 1;
        console.log(
          `⛔ Appointment ${orphan.appointmentId} still blocked by the double-booking guard — refund path owns it`,
        );
      }
    } catch (err) {
      stillBlocked += 1;
      console.error(
        `❌ Re-drive failed for appointment ${orphan.appointmentId}:`,
        err,
      );
    }
  }

  // #1356 — second pass: the chat leg. Deliberately separate from the loop
  // above, because the two failures are independent — an appointment can be
  // perfectly confirmed and still have no conversation, which is precisely the
  // case nothing used to look for.
  //
  // Bounded to the last seven days because this is a repair for a recent crash
  // window, not a backfill: an older appointment has either been through
  // syncUserEventChannels on a dashboard load or is past caring. Oldest first,
  // so a backlog drains in arrival order rather than starving its head.
  const unchanneled = await prisma.appointment.findMany({
    where: {
      chatChannelEnsuredAt: null,
      deletedAt: null,
      createdAt: { gte: new Date(Date.now() - 7 * 24 * 3_600_000) },
      payment: { some: { paymentStatus: "SUCCEEDED", deletedAt: null } },
      occurrences: { none: { isTentative: true, ...liveOccurrenceWhere } },
    },
    select: {
      id: true,
      // The unit the budget is spent in. `ensureChannelsForAppointment` makes
      // one Stream call per SUCCEEDED payment, so this count — the same
      // predicate it loads buyers with — is what a row costs to drive.
      _count: {
        select: {
          payment: { where: { paymentStatus: "SUCCEEDED", deletedAt: null } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
    take: channelLimit,
  });

  let channelsEnsured = 0;
  let channelsFailed = 0;
  const skippedAppointmentIds: string[] = [];
  let channelBuyerOps = 0;
  let channelsDeferred = 0;
  for (const [index, appointment] of unchanneled.entries()) {
    const outcome = await ensureChannelForOrphan(appointment.id);
    if (outcome === "ensured") {
      channelsEnsured += 1;
    } else if (outcome === "skipped") {
      skippedAppointmentIds.push(appointment.id);
    } else {
      channelsFailed += 1;
    }

    // Charged after the attempt, and a failed attempt still costs its calls.
    // Charging afterwards also means the head of the queue always moves: an
    // appointment whose buyer count exceeds the whole budget is driven once
    // rather than starved forever. Rows past this point keep
    // `chatChannelEnsuredAt: null`, and the next run picks them up oldest-first
    // exactly where this one stopped — no cursor to persist.
    channelBuyerOps += appointment._count.payment;
    if (channelBuyerOps >= CHANNEL_PASS_MAX_BUYER_OPS) {
      channelsDeferred = unchanneled.length - (index + 1);
      if (channelsDeferred > 0) {
        console.log(
          `💬 Buyer-operation budget spent (${channelBuyerOps}/${CHANNEL_PASS_MAX_BUYER_OPS}); ` +
            `${channelsDeferred} appointment(s) deferred to the next run`,
        );
      }
      break;
    }
  }

  const channelsSkipped = skippedAppointmentIds.length;
  // #1708 — one warning per run that counts up, not one event per row per tick.
  if (channelsSkipped > 0) {
    Sentry.captureMessage(
      `reconcile-orphaned-confirmations: ${channelsSkipped} appointment(s) marked terminal — DM not permitted or no channel branch`,
      {
        level: "warning",
        fingerprint: ["reconcile-orphaned-confirmations", "dm_not_permitted"],
        tags: { subsystem: "payments" },
        extra: { appointmentIds: skippedAppointmentIds },
      },
    );
  }

  console.log(
    `🩹 Orphaned confirmations: scanned=${orphans.length} confirmed=${confirmed} stillBlocked=${stillBlocked} ` +
      `channelsEnsured=${channelsEnsured} channelsFailed=${channelsFailed} channelsSkipped=${channelsSkipped} ` +
      `channelBuyerOps=${channelBuyerOps} channelsDeferred=${channelsDeferred}`,
  );
  return {
    success: true,
    scanned: orphans.length,
    confirmed,
    stillBlocked,
    channelsEnsured,
    channelsFailed,
    channelsSkipped,
    channelBuyerOps,
    channelsDeferred,
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

export interface OrphanedPaymentHealResult {
  success: boolean;
  scanned: number;
  linked: number;
  refunded: number;
  escrowed: number;
  nonGatewaySkipped: number;
  topupSkipped: number;
  stillFailing: number;
  timestamp: string;
}

const ORPHAN_PAYMENT_GRACE_MINUTES = 60;
const ORPHAN_PAYMENT_WINDOW_DAYS = 7;

type OrphanPaymentRow = {
  id: string;
  paymentIntent: string;
  userId: string;
  createdAt: Date;
};

function orphanPaymentWhere(graceCutoff: Date, windowCutoff: Date) {
  return {
    paymentStatus: PaymentStatus.SUCCEEDED,
    appointmentId: null,
    deletedAt: null,
    parentPaymentId: null,
    NOT: { paymentIntent: { startsWith: "overage:" } },
    createdAt: { gte: windowCutoff, lt: graceCutoff },
    refunds: { none: { status: RefundStatus.PENDING } },
    disputes: {
      none: { status: { notIn: DISPUTE_INACTIVE_FOR_GATING } },
    },
  } satisfies Prisma.PaymentWhereInput;
}

// Fail-closed: this sweep refunds, so concurrent runs must collapse to one.
export async function reconcileOrphanedPayments(
  opts: { graceMinutes?: number; limit?: number } = {},
): Promise<OrphanedPaymentHealResult> {
  return withCronLock("reconcile-orphaned-payments", { failMode: "closed" }, () =>
    reconcileOrphanedPaymentsUnlocked(opts),
  );
}

async function reconcileOrphanedPaymentsUnlocked(
  opts: { graceMinutes?: number; limit?: number } = {},
): Promise<OrphanedPaymentHealResult> {
  const graceMinutes = opts.graceMinutes ?? ORPHAN_PAYMENT_GRACE_MINUTES;
  const limit = opts.limit ?? 200;
  const now = Date.now();
  const graceCutoff = new Date(now - graceMinutes * 60_000);
  const windowCutoff = new Date(
    now - ORPHAN_PAYMENT_WINDOW_DAYS * 24 * 3_600_000,
  );
  const result: OrphanedPaymentHealResult = {
    success: true,
    scanned: 0,
    linked: 0,
    refunded: 0,
    escrowed: 0,
    nonGatewaySkipped: 0,
    topupSkipped: 0,
    stillFailing: 0,
    timestamp: new Date(now).toISOString(),
  };

  const orphans = await prisma.payment.findMany({
    where: orphanPaymentWhere(graceCutoff, windowCutoff),
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, paymentIntent: true, userId: true, createdAt: true },
  });
  result.scanned = orphans.length;

  const failedIds: string[] = [];
  for (const payment of orphans) {
    try {
      await healOneOrphan(payment, result);
    } catch (err) {
      result.stillFailing += 1;
      failedIds.push(payment.id);
      console.error(`orphan heal failed for payment ${payment.id}:`, err);
    }
  }

  const stale = await prisma.payment.findMany({
    where: {
      paymentStatus: PaymentStatus.SUCCEEDED,
      appointmentId: null,
      deletedAt: null,
      parentPaymentId: null,
      NOT: { paymentIntent: { startsWith: "overage:" } },
      createdAt: { lt: windowCutoff },
      refunds: { none: { status: RefundStatus.PENDING } },
      disputes: {
        none: { status: { notIn: DISPUTE_INACTIVE_FOR_GATING } },
      },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, paymentIntent: true, userId: true, createdAt: true },
  });
  for (const payment of stale) {
    try {
      if (await escrowOneOrphan(payment)) result.escrowed += 1;
    } catch (err) {
      result.stillFailing += 1;
      failedIds.push(payment.id);
      console.error(`orphan escrow failed for payment ${payment.id}:`, err);
    }
  }

  // One event per run, never per row.
  if (
    result.linked + result.refunded + result.escrowed + result.stillFailing >
    0
  ) {
    reportSentryMessage(
      `orphaned-payments: healed ${result.linked} linked, ${result.refunded} refunded, ${result.escrowed} escrowed`,
      {
        subsystem: "payments",
        op: "reconcile-orphaned-payments",
        fingerprint: ["orphaned-payments"],
        extra: {
          scanned: result.scanned,
          linked: result.linked,
          refunded: result.refunded,
          escrowed: result.escrowed,
          nonGatewaySkipped: result.nonGatewaySkipped,
          topupSkipped: result.topupSkipped,
          stillFailing: result.stillFailing,
          sample: failedIds.slice(0, 10),
        },
      },
    );
  }

  result.success = result.stillFailing === 0;
  console.log(
    `orphan payments: scanned=${result.scanned} linked=${result.linked} ` +
      `refunded=${result.refunded} escrowed=${result.escrowed} ` +
      `nonGateway=${result.nonGatewaySkipped} topup=${result.topupSkipped} ` +
      `failing=${result.stillFailing}`,
  );
  return result;
}

async function healOneOrphan(
  payment: OrphanPaymentRow,
  result: OrphanedPaymentHealResult,
): Promise<void> {
  // Wallet top-ups live in their own table; a matching order id means this
  // row belongs to that reconciler, not this one.
  const topup = await prisma.walletTopUp.findUnique({
    where: { providerOrderId: payment.paymentIntent },
    select: { id: true },
  });
  if (topup) {
    result.topupSkipped += 1;
    return;
  }

  const candidates = await prisma.appointment.findMany({
    where: {
      deletedAt: null,
      participants: { some: { userId: payment.userId } },
      occurrences: { some: { isTentative: true, ...liveOccurrenceWhere } },
      payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
    },
    select: { id: true },
    take: 2,
  });
  if (candidates.length === 1) {
    const appointmentId = candidates[0].id;
    const won = await claimAndNotifyOnce({
      claim: () =>
        prisma.payment.updateMany({
          where: {
            id: payment.id,
            paymentStatus: PaymentStatus.SUCCEEDED,
            appointmentId: null,
          },
          data: { appointmentId },
        }),
      notify: async () => {
        await withSerializableRetry(() =>
          prisma.$transaction(
            async (tx) => {
              await confirmExistingAppointment(tx, appointmentId, payment.userId);
            },
            {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
              maxWait: 10_000,
              timeout: 15_000,
            },
          ),
        );
      },
    });
    // A lost claim means another runner linked it; never fall through to a
    // refund on a row we did not win.
    if (won) result.linked += 1;
    return;
  }
  if (candidates.length > 1) return;

  // Synthetic intents carry no gateway money; count and leave for the
  // owning rail instead of calling the gateway.
  if (
    isInternalFundedIntent(payment.paymentIntent) ||
    isFreeCreditIntent(payment.paymentIntent)
  ) {
    result.nonGatewaySkipped += 1;
    return;
  }

  const dedupeKey = `orphan-auto:${payment.id}`;
  const won = await claimAndNotifyOnce({
    claim: () =>
      prisma.payment.updateMany({
        where: {
          id: payment.id,
          paymentStatus: PaymentStatus.SUCCEEDED,
          appointmentId: null,
        },
        data: { updatedAt: new Date() },
      }),
    notify: async () => {
      try {
        await refundBookingPayment({
          paymentId: payment.id,
          reason: "orphan auto-refund: SUCCEEDED payment with no appointment",
          initiatedByUserId: null,
          dedupeKey,
        });
      } catch (err) {
        // A concurrent win already refunded under the same key; that is the
        // single-refund outcome, not a failure.
        if (
          err instanceof RefundValidationError &&
          err.code === "ALREADY_FULLY_REFUNDED"
        ) {
          return;
        }
        throw err;
      }
    },
  });
  if (won) result.refunded += 1;
}

// Rows past the window are never dropped: one SystemEvent per payment guards
// the once-only page, and the money waits for an operator.
async function escrowOneOrphan(payment: OrphanPaymentRow): Promise<boolean> {
  const correlationId = `orphan-escrow:${payment.id}`;
  const existing = await prisma.systemEvent.findFirst({
    where: { correlationId },
    select: { id: true },
  });
  if (existing) return false;
  await recordSystemEvent({
    organizationId: null,
    category: "PAYMENT",
    severity: "WARN",
    message: `Orphaned payment ${payment.id} past escrow age needs manual recovery`,
    context: {
      paymentId: payment.id,
      paymentIntent: payment.paymentIntent,
      userId: payment.userId,
      createdAt: payment.createdAt.toISOString(),
    },
    correlationId,
  });
  reportSentryMessage(
    `orphan-escrow: payment ${payment.id} past 7d needs manual recovery`,
    {
      subsystem: "payments",
      op: "reconcile-orphaned-payments",
      fingerprint: ["orphan-escrow"],
      extra: { paymentId: payment.id },
    },
  );
  return true;
}

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
import prisma, { type PrismaLike } from "@/lib/prisma";
import { PaymentStatus, Prisma, RefundStatus } from "@prisma/client";
import { confirmExistingAppointment } from "@/lib/payments/webhooks/handlers";
import { liveOccurrenceWhere } from "@/lib/appointments/occurrences";
import { ensureChannelsForAppointment } from "@/lib/payments/webhooks/ensure-channels";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { DmNotPermittedError } from "@/lib/stream/dm-eligibility";
import { refundBookingPayment } from "@/lib/payments/operations/booking-refund";
import {
  isFreeCreditIntent,
  isInternalFundedIntent,
} from "@/lib/payments/funding-rail";
import { RefundValidationError } from "@/lib/payments/operations/refund";
import { notSettledElsewhereWhere } from "@/lib/payments/webhooks/auto-refund-marker";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import { claimAndNotifyOnce } from "@/lib/cron/cas-notice";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import { reportStandingFinding } from "@/lib/observability/standing-finding";

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
type OrphanChannelOutcome =
  | { kind: "ensured" }
  | { kind: "skipped"; reason: string }
  | { kind: "failed" };

// No retry can create this pair's channel; the run stamps it out of the queue afterwards.
function terminalReason(appointmentId: string, reason: string): string {
  console.warn(
    `💬 Chat channel for appointment ${appointmentId} is terminal: ${reason}`,
  );
  return reason;
}

type TerminalSkip = {
  appointmentId: string;
  appointmentType: string;
  reason: string;
};

// The stamp and its finding commit together, so a failed insert leaves the rows queued for the next run.
async function stampChannelsTerminal(skipped: TerminalSkip[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.appointment.updateMany({
      where: {
        id: { in: skipped.map((s) => s.appointmentId) },
        chatChannelEnsuredAt: null,
      },
      data: { chatChannelEnsuredAt: new Date() },
    });
    await recordSystemEvent({
      db: tx,
      strict: true,
      category: "BOOKING",
      severity: "WARN",
      message: `reconcile-orphaned-confirmations: ${skipped.length} appointment(s) marked terminal — no retry can create their chat channel`,
      context: { skipped },
      correlationId: "reconcile-orphaned-confirmations:channel-terminal",
    });
  });
}

async function ensureChannelForOrphan(
  appointmentId: string,
): Promise<OrphanChannelOutcome> {
  try {
    const result = await ensureChannelsForAppointment(appointmentId);
    if (result.ensured) {
      console.log(`💬 Ensured chat channel for appointment ${appointmentId}`);
      return { kind: "ensured" };
    }
    if (result.reason === "no_channel_branch_for_appointment") {
      return {
        kind: "skipped",
        reason: terminalReason(appointmentId, result.reason),
      };
    }
    console.warn(
      `💬 Could not ensure chat channel for appointment ${appointmentId}: ${result.reason}`,
    );
    return { kind: "failed" };
  } catch (err) {
    if (err instanceof DmNotPermittedError) {
      return {
        kind: "skipped",
        reason: terminalReason(appointmentId, "dm_not_permitted"),
      };
    }
    console.error(
      `❌ Chat-channel ensure failed for appointment ${appointmentId}:`,
      err,
    );
    return { kind: "failed" };
  }
}

const DEFAULT_CONFIRMATION_GRACE_MINUTES = 15;
const CHANNEL_PASS_WINDOW_MS = 7 * 24 * 3_600_000;

/** A SUCCEEDED payment whose appointment still holds a live tentative slot. */
function orphanedConfirmationWhere(
  updatedBefore: Date,
): Prisma.PaymentWhereInput {
  return {
    paymentStatus: "SUCCEEDED",
    updatedAt: { lt: updatedBefore },
    appointmentId: { not: null },
    // A rescheduled-away row keeps isTentative and would be re-driven every
    // tick; only a live hold is an orphan.
    appointment: {
      occurrences: { some: { isTentative: true, ...liveOccurrenceWhere } },
    },
  };
}

/** A confirmed, paid appointment whose chat channel was never stamped ensured. */
function unchanneledAppointmentWhere(
  createdSince: Date,
): Prisma.AppointmentWhereInput {
  return {
    chatChannelEnsuredAt: null,
    deletedAt: null,
    createdAt: { gte: createdSince },
    payment: { some: { paymentStatus: "SUCCEEDED", deletedAt: null } },
    occurrences: { none: { isTentative: true, ...liveOccurrenceWhere } },
  };
}

/** True when the confirmation pass or the chat-channel pass has a row. */
export async function hasOrphanedConfirmationWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  const t = now.getTime();
  if (outOfTime()) return true;
  const payment = await db.payment.findFirst({
    where: orphanedConfirmationWhere(
      new Date(t - DEFAULT_CONFIRMATION_GRACE_MINUTES * 60_000),
    ),
    select: { id: true },
  });
  if (payment) return true;
  if (outOfTime()) return true;
  const appointment = await db.appointment.findFirst({
    where: unchanneledAppointmentWhere(new Date(t - CHANNEL_PASS_WINDOW_MS)),
    select: { id: true },
  });
  return appointment !== null;
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
  const graceMinutes = opts.graceMinutes ?? DEFAULT_CONFIRMATION_GRACE_MINUTES;
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
    where: orphanedConfirmationWhere(cutoff),
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
    where: unchanneledAppointmentWhere(
      new Date(Date.now() - CHANNEL_PASS_WINDOW_MS),
    ),
    select: {
      id: true,
      appointmentType: true,
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
  const skipped: TerminalSkip[] = [];
  let channelBuyerOps = 0;
  let channelsDeferred = 0;
  for (const [index, appointment] of unchanneled.entries()) {
    const outcome = await ensureChannelForOrphan(appointment.id);
    if (outcome.kind === "ensured") {
      channelsEnsured += 1;
    } else if (outcome.kind === "skipped") {
      skipped.push({
        appointmentId: appointment.id,
        appointmentType: appointment.appointmentType,
        reason: outcome.reason,
      });
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

  // One console finding per run; if it cannot be saved the rows stay queued and Sentry hears once.
  let channelsSkipped = 0;
  if (skipped.length > 0) {
    try {
      await stampChannelsTerminal(skipped);
      channelsSkipped = skipped.length;
    } catch (err) {
      channelsFailed += skipped.length;
      reportSentryError(err, {
        subsystem: "payments",
        op: "reconcile-orphaned-confirmations:channel-terminal",
        extra: { appointmentIds: skipped.map((s) => s.appointmentId) },
      });
    }
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

function hasUnrefundedBalance(payment: {
  amount?: number;
  refunds?: ReadonlyArray<{ amountPaise?: number; amount?: number }>;
}): boolean {
  if (!Array.isArray(payment.refunds) || payment.refunds.length === 0) {
    return true;
  }
  if (typeof payment.amount !== "number") {
    return false;
  }
  const refundedSum = payment.refunds.reduce(
    (sum: number, r) => sum + Number(r.amountPaise ?? r.amount ?? 0),
    0,
  );
  return refundedSum < payment.amount;
}

function orphanPaymentWhere(graceCutoff: Date, windowCutoff: Date) {
  return {
    paymentStatus: PaymentStatus.SUCCEEDED,
    appointmentId: null,
    deletedAt: null,
    parentPaymentId: null,
    NOT: { paymentIntent: { startsWith: "overage:" } },
    AND: [notSettledElsewhereWhere],
    createdAt: { gte: windowCutoff, lt: graceCutoff },
    refunds: {
      none: { status: RefundStatus.PENDING },
    },
    disputes: {
      none: { status: { notIn: DISPUTE_INACTIVE_FOR_GATING } },
    },
  } satisfies Prisma.PaymentWhereInput;
}

/** An orphan past the heal window, escrowed for an operator. */
function staleOrphanPaymentWhere(windowCutoff: Date) {
  return {
    paymentStatus: PaymentStatus.SUCCEEDED,
    appointmentId: null,
    deletedAt: null,
    parentPaymentId: null,
    NOT: { paymentIntent: { startsWith: "overage:" } },
    AND: [notSettledElsewhereWhere],
    createdAt: { lt: windowCutoff },
    refunds: {
      none: {
        status: RefundStatus.PENDING,
      },
    },
    disputes: {
      none: { status: { notIn: DISPUTE_INACTIVE_FOR_GATING } },
    },
  } satisfies Prisma.PaymentWhereInput;
}

/**
 * True when the heal arm or the escrow arm has a candidate. An already-escrowed
 * row stays in the escrow arm, so this is a superset of the run's writes.
 */
export async function hasOrphanedPaymentWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  const t = now.getTime();
  const windowCutoff = new Date(
    t - ORPHAN_PAYMENT_WINDOW_DAYS * 24 * 3_600_000,
  );
  if (outOfTime()) return true;
  const row = await db.payment.findFirst({
    where: {
      OR: [
        orphanPaymentWhere(
          new Date(t - ORPHAN_PAYMENT_GRACE_MINUTES * 60_000),
          windowCutoff,
        ),
        staleOrphanPaymentWhere(windowCutoff),
      ],
    },
    select: { id: true },
  });
  return row !== null;
}

// Fail-closed: this sweep refunds, so concurrent runs must collapse to one.
export async function reconcileOrphanedPayments(
  opts: { graceMinutes?: number; limit?: number } = {},
): Promise<OrphanedPaymentHealResult> {
  return withCronLock(
    "reconcile-orphaned-payments",
    { failMode: "closed" },
    () => reconcileOrphanedPaymentsUnlocked(opts),
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

  const rawOrphans = await prisma.payment.findMany({
    where: orphanPaymentWhere(graceCutoff, windowCutoff),
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      amount: true,
      paymentIntent: true,
      userId: true,
      createdAt: true,
      refunds: {
        where: { status: RefundStatus.SUCCEEDED },
        select: { amountPaise: true },
      },
    },
  });
  const orphans = rawOrphans.filter(hasUnrefundedBalance);
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

  const rawStale = await prisma.payment.findMany({
    where: staleOrphanPaymentWhere(windowCutoff),
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      amount: true,
      paymentIntent: true,
      userId: true,
      createdAt: true,
      refunds: {
        where: { status: RefundStatus.SUCCEEDED },
        select: { amountPaise: true },
      },
    },
  });
  const stale = rawStale.filter(hasUnrefundedBalance);
  for (const payment of stale) {
    try {
      if (await escrowOneOrphan(payment)) result.escrowed += 1;
    } catch (err) {
      result.stillFailing += 1;
      failedIds.push(payment.id);
      console.error(`orphan escrow failed for payment ${payment.id}:`, err);
    }
  }

  // One event per run, never per row. Heal counts are one-off facts; only the
  // still-failing ids are a standing finding, reported once per new id set.
  const healed = result.linked + result.refunded + result.escrowed;
  const orphanExtra = {
    scanned: result.scanned,
    linked: result.linked,
    refunded: result.refunded,
    escrowed: result.escrowed,
    nonGatewaySkipped: result.nonGatewaySkipped,
    topupSkipped: result.topupSkipped,
    stillFailing: result.stillFailing,
    sample: failedIds.slice(0, 10),
  };
  if (healed > 0) {
    reportSentryMessage(
      `orphaned-payments: healed ${result.linked} linked, ${result.refunded} refunded, ${result.escrowed} escrowed`,
      {
        subsystem: "payments",
        op: "reconcile-orphaned-payments",
        fingerprint: ["orphaned-payments-healed"],
        extra: orphanExtra,
      },
    );
  }
  if (result.stillFailing > 0) {
    const message = `orphaned-payments: ${result.stillFailing} still failing to heal`;
    await reportStandingFinding(
      {
        key: "reconcile-orphaned-confirmations:still-failing",
        ids: failedIds,
        message,
      },
      () =>
        reportSentryMessage(message, {
          subsystem: "payments",
          op: "reconcile-orphaned-payments",
          fingerprint: ["orphaned-payments-still-failing"],
          extra: orphanExtra,
        }),
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
              await confirmExistingAppointment(
                tx,
                appointmentId,
                payment.userId,
              );
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

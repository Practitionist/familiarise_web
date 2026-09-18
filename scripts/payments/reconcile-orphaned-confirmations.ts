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
import { Prisma } from "@prisma/client";
import { confirmExistingAppointment } from "@/lib/payments/webhooks/handlers";
import { liveOccurrenceWhere } from "@/lib/appointments/occurrences";
import { ensureChannelsForAppointment } from "@/lib/payments/webhooks/ensure-channels";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { DmNotPermittedError } from "@/lib/stream/dm-eligibility";
import * as Sentry from "@sentry/nextjs";

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
    select: { id: true, appointmentId: true, userId: true },
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

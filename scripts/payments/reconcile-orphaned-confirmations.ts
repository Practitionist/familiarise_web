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
 */
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { confirmExistingAppointment } from "@/lib/payments/webhooks/handlers";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { withCronLock } from "@/lib/cron/with-cron-lock";

export interface OrphanedConfirmationResult {
  success: boolean;
  scanned: number;
  confirmed: number;
  stillBlocked: number;
}

// #476 — fail-closed: re-driving a confirmation twice is guarded by the
// idempotent slot flip, but the entry must not run unlocked regardless.
export async function reconcileOrphanedConfirmations(
  opts: { graceMinutes?: number; limit?: number } = {},
): Promise<OrphanedConfirmationResult> {
  return withCronLock("reconcile-orphaned-confirmations", { failMode: "closed" }, () =>
    reconcileOrphanedConfirmationsUnlocked(opts),
  );
}

async function reconcileOrphanedConfirmationsUnlocked(
  opts: { graceMinutes?: number; limit?: number } = {},
): Promise<OrphanedConfirmationResult> {
  const graceMinutes = opts.graceMinutes ?? 15;
  const limit = opts.limit ?? 200;
  const cutoff = new Date(Date.now() - graceMinutes * 60_000);

  const orphans = await prisma.payment.findMany({
    where: {
      paymentStatus: "SUCCEEDED",
      updatedAt: { lt: cutoff },
      appointmentId: { not: null },
      appointment: {
        slotsOfAppointment: { some: { isTentative: true } },
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
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
      const remaining = await prisma.slotOfAppointment.count({
        where: { appointmentId: orphan.appointmentId!, isTentative: true },
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

  console.log(
    `🩹 Orphaned confirmations: scanned=${orphans.length} confirmed=${confirmed} stillBlocked=${stillBlocked}`,
  );
  return {
    success: true,
    scanned: orphans.length,
    confirmed,
    stillBlocked,
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

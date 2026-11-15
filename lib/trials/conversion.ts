import { TrialStatus } from "@prisma/client";
import { transitionTrial } from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import type { Tx } from "@/lib/prisma";

/** A plan paid this long after the trial ended is not its conversion. */
export const TRIAL_CONVERSION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A completed trial converts when a subscription to any plan of the same
 * expert is PAID within 30 days of the trial's completion: at capture, or at a
 * checkout that settles with no gateway. Never at checkout start, so an
 * abandoned checkout leaves the trial COMPLETED. CAS on COMPLETED → CONVERTED;
 * losing it never fails the capture.
 */
export async function convertCompletedTrial(
  tx: Tx,
  subscriptionId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const subscription = await tx.subscription.findUnique({
    where: { id: subscriptionId },
    select: {
      requestedById: true,
      subscriptionPlan: { select: { consultantProfileId: true } },
      appointment: {
        select: {
          payment: {
            where: { paymentStatus: "SUCCEEDED", deletedAt: null },
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { capturedAt: true },
          },
        },
      },
    },
  });
  if (!subscription?.subscriptionPlan) return null;
  // Judged at the capture, not when a reconcile sweep got round to it.
  const paidAt = subscription.appointment?.payment[0]?.capturedAt ?? now;
  const trial = await tx.trial.findFirst({
    where: {
      consulteeProfileId: subscription.requestedById,
      consultantProfileId: subscription.subscriptionPlan.consultantProfileId,
      status: TrialStatus.COMPLETED,
      convertedToSubscriptionId: null,
      // A trial completed after the payment did not lead to it.
      completedAt: {
        gte: new Date(paidAt.getTime() - TRIAL_CONVERSION_WINDOW_MS),
        lte: paidAt,
      },
    },
    // The pair index allows one COMPLETED trial; the order only makes the read explicit.
    orderBy: { completedAt: "desc" },
    select: { id: true },
  });
  if (!trial) return null;
  try {
    await transitionTrial(tx, {
      where: { id: trial.id },
      to: TrialStatus.CONVERTED,
      data: { convertedToSubscriptionId: subscriptionId },
    });
  } catch (err) {
    if (err instanceof IllegalTransitionError) return null;
    throw err;
  }
  console.log(
    JSON.stringify({
      event: "trial_converted",
      trialId: trial.id,
      subscriptionId,
      timestamp: new Date().toISOString(),
    }),
  );
  return trial.id;
}

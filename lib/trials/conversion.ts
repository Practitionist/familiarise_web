import { TrialStatus } from "@prisma/client";
import { transitionTrial } from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import type { Tx } from "@/lib/prisma";

/**
 * A completed trial converts when a subscription with the same expert is PAID:
 * at capture, or at a checkout that settles with no gateway. Never at checkout
 * start, so an abandoned checkout leaves the trial COMPLETED. CAS on
 * COMPLETED → CONVERTED; losing it never fails the capture.
 */
export async function convertCompletedTrial(
  tx: Tx,
  subscriptionId: string,
): Promise<string | null> {
  const subscription = await tx.subscription.findUnique({
    where: { id: subscriptionId },
    select: {
      requestedById: true,
      subscriptionPlan: { select: { consultantProfileId: true } },
    },
  });
  if (!subscription?.subscriptionPlan) return null;
  const trial = await tx.trial.findFirst({
    where: {
      consulteeProfileId: subscription.requestedById,
      consultantProfileId: subscription.subscriptionPlan.consultantProfileId,
      status: TrialStatus.COMPLETED,
      convertedToSubscriptionId: null,
    },
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

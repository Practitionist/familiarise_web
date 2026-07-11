import prisma, { type Tx } from "@/lib/prisma";

/**
 * Recomputes the denormalized ConsultantProfile.rating after a review
 * mutation. Explore sort (orderByForSort) and the minRating filter read this
 * column, so every create/update/delete must call it or ratings drift.
 * Accepts a transaction client so the recompute stays atomic with the
 * mutation that triggered it.
 */
export async function recomputeConsultantRating(
  tx: Tx,
  consultantProfileId: string,
): Promise<void> {
  const agg = await tx.consultantReview.aggregate({
    where: { consultantProfileId },
    _avg: { rating: true },
  });

  await tx.consultantProfile.update({
    where: { id: consultantProfileId },
    data: { rating: agg._avg.rating ?? 0 },
  });
}

/**
 * Review eligibility: the consultee must have at least one completed booking
 * with the consultant. "Completed" means a Consultation or Subscription whose
 * status reached COMPLETED (or that has at least one held session — a slot
 * with completionStatus COMPLETED, which covers in-flight subscriptions), or
 * a trial that reached COMPLETED/CONVERTED.
 */
export async function hasCompletedBookingWith(
  consulteeProfileId: string,
  consultantProfileId: string,
): Promise<boolean> {
  const completedBooking = {
    OR: [
      { status: "COMPLETED" as const },
      {
        appointment: {
          slotsOfAppointment: {
            some: { completionStatus: "COMPLETED" as const },
          },
        },
      },
    ],
  };

  const [consultation, subscription, trial] = await Promise.all([
    prisma.consultation.findFirst({
      where: {
        requestedById: consulteeProfileId,
        consultationPlan: { consultantProfileId },
        ...completedBooking,
      },
      select: { id: true },
    }),
    prisma.subscription.findFirst({
      where: {
        requestedById: consulteeProfileId,
        subscriptionPlan: { consultantProfileId },
        OR: [
          { status: "COMPLETED" },
          {
            appointments: {
              some: {
                slotsOfAppointment: {
                  some: { completionStatus: "COMPLETED" },
                },
              },
            },
          },
        ],
      },
      select: { id: true },
    }),
    prisma.trialSession.findFirst({
      where: {
        consulteeProfileId,
        consultantProfileId,
        status: { in: ["COMPLETED", "CONVERTED"] },
      },
      select: { id: true },
    }),
  ]);

  return Boolean(consultation || subscription || trial);
}

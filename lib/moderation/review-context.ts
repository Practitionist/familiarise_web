import prisma from "@/lib/prisma";
import { exclusionUnpublishesScore } from "@/lib/reviews";

export interface ReviewReportSignal {
  hasRefund: boolean;
  hasOpenTicket: boolean;
  hasDispute: boolean;
}

export interface ReviewReportContext {
  appointmentId: string;
  appointmentStatus: string;
  refundCount: number;
  latestRefundStatus: string | null;
  hasDispute: boolean;
  openSupportCount: number;
  signals: string[];
}

/** Batched booking context signals across review reports (constant 3 queries). */
export async function readReviewReportSignals(
  appointmentIds: string[],
): Promise<Record<string, ReviewReportSignal>> {
  const uniqueIds = [...new Set(appointmentIds.filter(Boolean))];
  if (uniqueIds.length === 0) return {};

  const [refundRows, openThreads, disputeRows] = await Promise.all([
    prisma.refund.findMany({
      where: {
        deletedAt: null,
        payment: { appointmentId: { in: uniqueIds } },
      },
      select: { payment: { select: { appointmentId: true } } },
    }),
    prisma.appointmentSupportThread.findMany({
      where: {
        appointmentId: { in: uniqueIds },
        status: { notIn: ["RESOLVED", "CLOSED"] },
      },
      select: { appointmentId: true },
    }),
    prisma.dispute.findMany({
      where: {
        payment: { appointmentId: { in: uniqueIds } },
      },
      select: { payment: { select: { appointmentId: true } } },
    }),
  ]);

  const refundSet = new Set<string>();
  for (const row of refundRows) {
    if (row.payment.appointmentId) refundSet.add(row.payment.appointmentId);
  }

  const openTicketSet = new Set<string>(
    openThreads.map((t) => t.appointmentId),
  );

  const disputeSet = new Set<string>();
  for (const row of disputeRows) {
    if (row.payment.appointmentId) disputeSet.add(row.payment.appointmentId);
  }

  const out: Record<string, ReviewReportSignal> = {};
  for (const id of uniqueIds) {
    out[id] = {
      hasRefund: refundSet.has(id),
      hasOpenTicket: openTicketSet.has(id),
      hasDispute: disputeSet.has(id),
    };
  }
  return out;
}

/** Detailed non-judgmental booking and support context for a single review report. */
export async function readReviewReportContext(
  appointmentId: string,
): Promise<ReviewReportContext | null> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      occurrences: {
        orderBy: { startsAt: "desc" },
        take: 1,
        select: { completionStatus: true },
      },
      consultantReviews: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true },
      },
      supportThreads: {
        where: { status: { notIn: ["RESOLVED", "CLOSED"] } },
        select: { id: true },
      },
      payment: {
        select: {
          refunds: {
            where: { deletedAt: null },
            orderBy: { updatedAt: "desc" },
            select: { id: true, status: true, updatedAt: true },
          },
          disputes: {
            select: { id: true },
          },
        },
      },
    },
  });

  if (!appointment) return null;

  const refunds = appointment.payment
    .flatMap((p) => p.refunds)
    .toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const refundCount = refunds.length;
  const latestRefund = refunds[0] ?? null;
  const latestRefundStatus = latestRefund?.status ?? null;
  const hasDispute = appointment.payment.some((p) => p.disputes.length > 0);
  const openSupportCount = appointment.supportThreads.length;
  const signals: string[] = [];

  const latestReview = appointment.consultantReviews[0];
  if (latestReview && latestRefund) {
    const elapsedDays = Math.max(
      0,
      Math.round(
        Math.abs(
          latestReview.createdAt.getTime() - latestRefund.updatedAt.getTime(),
        ) / 86_400_000,
      ),
    );
    signals.push(`Review posted within ${elapsedDays} days of refund decision`);
  }

  if (openSupportCount > 0) {
    signals.push("Open support case on this booking");
  }

  if (hasDispute) {
    signals.push("Payment dispute recorded on this booking");
  }

  return {
    appointmentId: appointment.id,
    appointmentStatus:
      appointment.occurrences[0]?.completionStatus ?? "UNSCHEDULED",
    refundCount,
    latestRefundStatus,
    hasDispute,
    openSupportCount,
    signals,
  };
}

/** Whether excluding this review from the rating would take the expert's published score below the publication gate. */
export async function readExclusionDropsBelowGate(
  reviewId: string,
): Promise<boolean> {
  const review = await prisma.consultantReview.findUnique({
    where: { id: reviewId },
    select: { consultantProfileId: true },
  });
  if (!review) return false;
  const counted = await prisma.consultantReview.findMany({
    where: {
      consultantProfileId: review.consultantProfileId,
      deletedAt: null,
      excludedFromAggregateAt: null,
    },
    select: { id: true, rating: true, track: true, ratingUnitId: true },
  });
  return exclusionUnpublishesScore(counted, reviewId);
}

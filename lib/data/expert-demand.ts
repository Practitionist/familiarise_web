import prisma from "@/lib/prisma";
import { runBounded } from "@/lib/db/bounded";
import {
  mergeSpans,
  readFeasibilitySpans,
  subtractSpans,
  type TimeSpan,
} from "@/lib/booking/feasibility";
import {
  countOpenRequestsForCap,
  openConsultationRequestWhere,
} from "@/lib/data/needs-you";
import {
  ALLOCATE_WINDOW_MS,
  requestHoldDeadline,
} from "@/lib/dashboard/money-state";
import { DEMAND_HORIZON_DAYS } from "@/lib/booking/demand-signals";
import type { ExpertDemand } from "@/schemas/expert-demand";

const DAY_MS = 86_400_000;
const totalMs = (spans: readonly TimeSpan[]) =>
  spans.reduce((t, s) => t + (s.endMs - s.startMs), 0);

/**
 * The expert's own load, for the demand banner: seven batched statements
 * (cap counts 2, nearest expiry 1, unplaced paid plans 1, published and
 * booked time 2, waiting learners 1) after the route's profile read.
 */
export async function readExpertDemand(
  profile: {
    id: string;
    acceptingRequests: boolean;
    bookingMode: ExpertDemand["bookingMode"];
    maxOpenRequests: number | null;
  },
  now: Date = new Date(),
): Promise<ExpertDemand> {
  const horizon = {
    fromMs: now.getTime(),
    toMs: now.getTime() + DEMAND_HORIZON_DAYS * DAY_MS,
  };
  const [openRequests, oldestRequest, unplaced, spans, waiting] =
    await runBounded([
      () => countOpenRequestsForCap(profile.id, prisma, now),
      () =>
        prisma.consultation.findFirst({
          where: openConsultationRequestWhere(profile.id, now),
          orderBy: { requestedAt: "asc" },
          select: { requestedAt: true },
        }),
      () =>
        prisma.subscription.findMany({
          where: {
            deletedAt: null,
            status: { in: ["PENDING", "APPROVED"] },
            subscriptionPlan: { consultantProfileId: profile.id },
            appointment: {
              payment: { some: { paymentStatus: "SUCCEEDED" } },
              occurrences: {
                none: {
                  deletedAt: null,
                  completionStatus: { notIn: ["CANCELLED", "RESCHEDULED"] },
                },
              },
            },
          },
          select: {
            appointment: {
              select: {
                payment: {
                  where: { paymentStatus: "SUCCEEDED" },
                  select: {
                    paymentStatus: true,
                    capturedAt: true,
                    createdAt: true,
                  },
                },
              },
            },
          },
          relationLoadStrategy: "join",
        }),
      () => readFeasibilitySpans(prisma, profile.id, horizon, now),
      () =>
        prisma.windowBackupInterest.findMany({
          where: {
            consultantProfileId: profile.id,
            status: "WAITING",
            windowStart: { gt: now },
          },
          distinct: ["userId"],
          select: { userId: true },
        }),
    ] as const);

  // Every unplaced plan and every captured payment on it: the earliest capture sets the deadline.
  const paidAt = unplaced
    .flatMap((s) => s.appointment?.payment ?? [])
    .map((p) => p.capturedAt ?? p.createdAt)
    .sort((a, b) => a.getTime() - b.getTime());
  const oldestPaid = paidAt[0] ?? null;
  const placeBy = oldestPaid
    ? new Date(oldestPaid.getTime() + ALLOCATE_WINDOW_MS)
    : null;
  const published = mergeSpans(spans.windows);
  const publishedMs = totalMs(published);
  const freeMs = totalMs(subtractSpans(published, mergeSpans(spans.busy)));
  const expiry = oldestRequest
    ? requestHoldDeadline("CONSULTATION", oldestRequest.requestedAt)
    : null;

  return {
    acceptingRequests: profile.acceptingRequests,
    bookingMode: profile.bookingMode,
    openRequests,
    maxOpenRequests: profile.maxOpenRequests,
    nearestRequestExpiry: expiry?.toISOString() ?? null,
    unplacedPlans: unplaced.length,
    oldestUnplacedPaidAt: oldestPaid?.toISOString() ?? null,
    nearestPlacementDeadline: placeBy?.toISOString() ?? null,
    bookedShare: publishedMs > 0 ? (publishedMs - freeMs) / publishedMs : null,
    learnersWaiting: waiting.length,
  };
}

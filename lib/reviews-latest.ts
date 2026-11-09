import "server-only";

import prisma from "@/lib/prisma";
import type { TConsultantDashboardResponse } from "@/types/consultant-events";

/** Longest quote the Home card carries; the full text lives in Reviews. */
const LATEST_REVIEW_BODY_MAX = 400;

/**
 * Home's "Latest feedback": the newest live review that has text, one bounded
 * read. An anonymous reviewer stays anonymous, exactly as in the inbox.
 */
export async function readLatestReview(
  consultantProfileId: string,
): Promise<NonNullable<TConsultantDashboardResponse["latestReview"]> | null> {
  const row = await prisma.consultantReview.findFirst({
    where: {
      consultantProfileId,
      deletedAt: null,
      reviewDescription: { not: null },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      rating: true,
      reviewDescription: true,
      createdAt: true,
      isAnonymous: true,
      consulteeProfile: { select: { user: { select: { name: true } } } },
    },
  });
  const body = row?.reviewDescription?.trim();
  if (!row || !body) return null;
  return {
    rating: row.rating,
    body: body.slice(0, LATEST_REVIEW_BODY_MAX),
    createdAt: row.createdAt.toISOString(),
    reviewerFirstName: row.isAnonymous
      ? null
      : (row.consulteeProfile.user.name?.trim().split(/\s+/)[0] ?? null),
  };
}

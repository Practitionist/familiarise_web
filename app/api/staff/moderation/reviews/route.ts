/**
 * Staff Moderation Reviews API
 * List consultant reviews for moderation
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { readPageParams } from "@/lib/backoffice/list-paging";
import type { ModerationReviewsPageInput } from "@/lib/backoffice/moderation-schemas";

const querySchema = z.object({
  consultantProfileId: z.string().min(1).optional(),
  minRating: z.coerce.number().int().min(1).max(5).optional(),
  maxRating: z.coerce.number().int().min(1).max(5).optional(),
});

/**
 * GET /api/staff/moderation/reviews
 * List reviews (optionally filtered)
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("moderation.manage");
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const parsed = querySchema.safeParse({
      consultantProfileId: searchParams.get("consultantProfileId") ?? undefined,
      minRating: searchParams.get("minRating") ?? undefined,
      maxRating: searchParams.get("maxRating") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid query", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { consultantProfileId, minRating, maxRating } = parsed.data;
    const { page, limit, skip: offset } = readPageParams(searchParams, 20);

    const where: Prisma.ConsultantReviewWhereInput = {};

    if (consultantProfileId) {
      where.consultantProfileId = consultantProfileId;
    }
    if (minRating !== undefined || maxRating !== undefined) {
      where.rating = {
        ...(minRating !== undefined && { gte: minRating }),
        ...(maxRating !== undefined && { lte: maxRating }),
      };
    }

    const [reviews, total] = await Promise.all([
      prisma.consultantReview.findMany({
        relationLoadStrategy: "join",
        where,
        // An allowlist, not a bare include: the profiles carry statutory PII
        // this queue never renders, so it is not fetched either (#946, #1561).
        select: {
          id: true,
          rating: true,
          reviewDescription: true,
          createdAt: true,
          deletedAt: true,
          removedBy: true,
          isAnonymous: true,
          replyBody: true,
          repliedAt: true,
          replyDeletedAt: true,
          replyRemovedBy: true,
          editedAt: true,
          // #1562 — who acted and why lives on the audit row, newest first.
          moderationActions: {
            select: {
              actionType: true,
              notes: true,
              createdAt: true,
              takenBy: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: "desc" },
            take: 5,
          },
          consultantProfile: {
            select: {
              id: true,
              user: { select: { name: true, email: true, image: true } },
            },
          },
          // The reviewer is a learner: STAFF read their public identity only.
          consulteeProfile: {
            select: {
              id: true,
              user: { select: { name: true, image: true } },
            },
          },
        },
        // Newest first; the id breaks a tie so a page never repeats a review.
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: limit,
        skip: offset,
      }),
      prisma.consultantReview.count({ where }),
    ]);

    const formattedReviews = reviews.map((review) => ({
      id: review.id,
      rating: review.rating,
      reviewDescription: review.reviewDescription,
      consultant: {
        profileId: review.consultantProfile.id,
        name: review.consultantProfile.user.name,
        email: review.consultantProfile.user.email,
        image: review.consultantProfile.user.image,
      },
      // Sent even for an anonymous review: staff see its author, and the screen labels it.
      reviewer: {
        profileId: review.consulteeProfile.id,
        name: review.consulteeProfile.user.name,
        image: review.consulteeProfile.user.image,
      },
      createdAt: review.createdAt,
      // #1300 — this queue deliberately does NOT filter `deletedAt`, so staff see
      // removed rows; it then projected neither `deletedAt` nor `isAnonymous`, so
      // a removed review was indistinguishable from a live one and an anonymous
      // author from a named one — on the one surface whose whole job is telling
      // them apart. `editedAt` is here for the same reason: a review that has
      // been rewritten since it was reported is a different review.
      deletedAt: review.deletedAt,
      removedBy: review.removedBy,
      isAnonymous: review.isAnonymous,
      // The reply and its state: live, withdrawn by the consultant, or taken down.
      replyBody: review.replyBody,
      repliedAt: review.repliedAt,
      replyDeletedAt: review.replyDeletedAt,
      replyRemovedBy: review.replyRemovedBy,
      editedAt: review.editedAt,
      moderationActions: review.moderationActions,
    }));

    // Get rating distribution.
    // #1300 — the SAME population as the list, from the same `where`. It had no
    // `where` at all, and scoping it to live rows only half-fixed that: the list
    // applies `consultantProfileId` and the rating bounds and deliberately does not
    // filter `deletedAt`, so a filtered queue still showed a histogram of a
    // different population. Two numbers on one screen have to count the same rows,
    // and on this screen that includes the removed ones — telling them apart is
    // what the queue is for.
    const ratingDistribution = await prisma.consultantReview.groupBy({
      by: ["rating"],
      where,
      _count: { id: true },
    });

    const distribution = Object.fromEntries(
      ratingDistribution.map((r) => [r.rating, r._count.id]),
    );

    const body: ModerationReviewsPageInput = {
      reviews: formattedReviews,
      distribution,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + limit < total,
      },
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error("Error fetching reviews:", error);
    return NextResponse.json(
      { error: "Failed to fetch reviews" },
      { status: 500 },
    );
  }
}

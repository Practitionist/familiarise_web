import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import { Prisma } from "@prisma/client";
import { notifyNewReview } from "@/lib/novu";
import { CreateReviewSchema } from "@/schemas/feedbacks";
import { apiError } from "@/lib/errors";
import { getSession } from "@/lib/auth-server";
import { purgeReviewSurfaces } from "@/lib/data/public-cache";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import {
  hasCompletedBookingWith,
  recomputeConsultantRating,
} from "@/lib/reviews";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const rating = searchParams.get("rating");
    const consultantId = searchParams.get("consultantId");
    const consulteeId = searchParams.get("consulteeId");
    const searchTerm = searchParams.get("search");

    const whereClause: Prisma.ConsultantReviewWhereInput = {};

    if (rating) {
      whereClause.rating = {
        gte: parseInt(rating), // Greater than or equal to the specified rating
      };
    }

    if (consultantId) {
      whereClause.consultantProfileId = consultantId;
    }

    if (consulteeId) {
      whereClause.consulteeProfileId = consulteeId;
    }

    if (searchTerm) {
      whereClause.reviewDescription = {
        contains: searchTerm,
        mode: "insensitive",
      };
    }

    // #693 — moderation-removed reviews stay hidden
    whereClause.deletedAt = null;
    const reviews = await prisma.consultantReview.findMany({
      where: whereClause,
      take: 50,
      include: {
        // #946 allowlist. This route is PUBLIC (middleware.ts marks it so) and
        // its response is CDN-cached, so a bare `include:` here published every
        // reviewed consultant's panNumber / ibanOrAccount / swiftBic /
        // udyamNumber to anonymous callers.
        consultantProfile: {
          select: {
            ...consultantPublicScalars,
            user: { select: { name: true } },
          },
        },
        consulteeProfile: {
          include: {
            user: {
              select: {
                name: true,
                image: true,
              },
            },
          },
        },
      },
      orderBy: {
        rating: "desc",
      },
    });

    return NextResponse.json(
      { data: reviews },
      {
        status: 200,
        headers: {
          "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    return apiError({ tag: "[Reviews.GET]", error });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Rate limit: 5 reviews per hour per user
    const rl = await applyRateLimit(spamLimiter, `reviews:${session.user.id}`);
    if (rl) return rl;

    const body = await req.json();
    const result = CreateReviewSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", details: result.error.issues },
        { status: 400 },
      );
    }
    const validatedData = result.data;

    // Reviews are always authored as the session user's own consultee
    // profile — the body's consulteeProfileId is only accepted if it matches.
    const sessionConsulteeProfileId = session.user.consulteeProfileId;
    if (!sessionConsulteeProfileId) {
      return NextResponse.json(
        { error: "You need a consultee profile to post a review" },
        { status: 403 },
      );
    }
    if (validatedData.consulteeProfileId !== sessionConsulteeProfileId) {
      return NextResponse.json(
        { error: "You can only post reviews as yourself" },
        { status: 403 },
      );
    }

    // Only consultees with a completed booking may review the consultant.
    const eligible = await hasCompletedBookingWith(
      sessionConsulteeProfileId,
      validatedData.consultantProfileId,
    );
    if (!eligible) {
      return NextResponse.json(
        {
          error:
            "You can only review consultants after a completed session with them",
        },
        { status: 403 },
      );
    }

    // Create + rating recompute in one transaction so the denormalized
    // ConsultantProfile.rating (explore sort/filter) never drifts. Serializable
    // + retry so two concurrent reviews for the same consultant can't lose-update
    // the recomputed average (P2034 aborts one, retry then sees the committed row).
    const newReview = await withSerializableRetry(() =>
      prisma.$transaction(async (tx) => {
      const created = await tx.consultantReview.create({
        data: {
          rating: validatedData.rating,
          reviewDescription: validatedData.reviewDescription,
          consultantProfileId: validatedData.consultantProfileId,
          consulteeProfileId: sessionConsulteeProfileId,
        },
        include: {
          // #946 allowlist — the response goes back to the consultee who wrote
          // the review; a bare `include:` handed them the consultant's PAN and
          // bank account.
          consultantProfile: {
            select: {
              ...consultantPublicScalars,
              user: { select: { name: true } },
            },
          },
          consulteeProfile: {
            include: {
              user: {
                select: {
                  name: true,
                  image: true,
                },
              },
            },
          },
        },
      });

      await recomputeConsultantRating(tx, created.consultantProfileId);

      return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    // Notify the consultant about the new review
    void notifyNewReview(newReview.consultantProfile.userId, {
      reviewerName: newReview.consulteeProfile?.user?.name || "User",
      rating: newReview.rating,
      comment: newReview.reviewDescription || undefined,
      planTitle: undefined,
      dashboardUrl: "/dashboard/consultant/reviews",
    });

    // Reviews are the landing page's testimonials and they move the expert's
    // denormalized rating, which orders the directory — both surfaces are stale
    // until purged, and the landing page's window is an hour.
    purgeReviewSurfaces(newReview.consultantProfileId);

    return NextResponse.json(newReview, { status: 201 });
  } catch (error) {
    // @@unique([consultantProfileId, consulteeProfileId]) — one review per pair.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "You have already reviewed this consultant" },
        { status: 409 },
      );
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    return apiError({ tag: "[Reviews.POST]", error });
  }
}

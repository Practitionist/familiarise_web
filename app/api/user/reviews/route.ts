import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { notifyNewReview } from "@/lib/novu";
import { CreateReviewSchema } from "@/schemas/feedbacks";
import { apiError } from "@/lib/errors";
import { getSession } from "@/lib/auth-server";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";

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

    const reviews = await prisma.consultantReview.findMany({
      where: whereClause,
      take: 50,
      include: {
        consultantProfile: {
          include: {
            user: {
              select: {
                name: true,
              },
            },
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

    const newReview = await prisma.consultantReview.create({
      data: {
        rating: validatedData.rating,
        reviewDescription: validatedData.reviewDescription,
        consultantProfileId: validatedData.consultantProfileId,
        consulteeProfileId: validatedData.consulteeProfileId,
      },
      include: {
        consultantProfile: {
          include: {
            user: {
              select: {
                name: true,
              },
            },
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

    // Notify the consultant about the new review
    void notifyNewReview(newReview.consultantProfile.userId, {
      reviewerName: newReview.consulteeProfile?.user?.name || "User",
      rating: newReview.rating,
      comment: newReview.reviewDescription || undefined,
      planTitle: undefined,
      dashboardUrl: "/dashboard/consultant/reviews",
    });

    return NextResponse.json(newReview, { status: 201 });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    return apiError({ tag: "[Reviews.POST]", error });
  }
}

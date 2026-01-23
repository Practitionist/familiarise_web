/**
 * Staff Moderation Reviews API
 * List consultant reviews for moderation
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

/**
 * GET /api/staff/moderation/reviews
 * List reviews (optionally filtered)
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    if (user?.role !== UserRole.STAFF && user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const consultantProfileId = searchParams.get("consultantProfileId");
    const minRating = searchParams.get("minRating");
    const maxRating = searchParams.get("maxRating");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = (page - 1) * limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {};

    if (consultantProfileId) {
      where.consultantProfileId = consultantProfileId;
    }
    if (minRating) {
      where.rating = { ...where.rating, gte: parseInt(minRating) };
    }
    if (maxRating) {
      where.rating = { ...where.rating, lte: parseInt(maxRating) };
    }

    const [reviews, total] = await Promise.all([
      prisma.consultantReview.findMany({
        where,
        include: {
          consultantProfile: {
            include: {
              user: {
                select: { id: true, name: true, email: true, image: true },
              },
            },
          },
          consulteeProfile: {
            include: {
              user: {
                select: { id: true, name: true, email: true, image: true },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
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
      reviewer: {
        profileId: review.consulteeProfile.id,
        name: review.consulteeProfile.user.name,
        email: review.consulteeProfile.user.email,
        image: review.consulteeProfile.user.image,
      },
      createdAt: review.createdAt,
    }));

    // Get rating distribution
    const ratingDistribution = await prisma.consultantReview.groupBy({
      by: ["rating"],
      _count: { id: true },
    });

    const distribution = Object.fromEntries(
      ratingDistribution.map((r) => [r.rating, r._count.id])
    );

    return NextResponse.json({
      reviews: formattedReviews,
      distribution,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + limit < total,
      },
    });
  } catch (error) {
    console.error("Error fetching reviews:", error);
    return NextResponse.json(
      { error: "Failed to fetch reviews" },
      { status: 500 }
    );
  }
}

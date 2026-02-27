import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { notifyNewReview } from "@/lib/novu";
import { CreateReviewSchema } from "@/schemas/feedbacks";
import { apiError } from "@/lib/errors";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const rating = searchParams.get("rating");
    const consultantId = searchParams.get("consultantId");
    const consulteeId = searchParams.get("consulteeId");
    const searchTerm = searchParams.get("search");

    let whereClause: any = {};

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
          "Cache-Control":
            "public, s-maxage=120, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    return apiError({ tag: "[Reviews.GET]", error });
  }
}

export async function POST(req: NextRequest) {
  try {
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
    return apiError({ tag: "[Reviews.POST]", error });
  }
}

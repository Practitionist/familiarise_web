import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { notifyNewReview } from "@/lib/novu";

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

    return NextResponse.json({ data: reviews }, { status: 200 });
  } catch (error) {
    console.error("Error getting reviews:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const newReview = await prisma.consultantReview.create({
      data: {
        rating: body.rating,
        reviewDescription: body.reviewDescription,
        consultantProfileId: body.consultantProfileId,
        consulteeProfileId: body.consulteeProfileId,
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
    void notifyNewReview(
      newReview.consultantProfile.userId,
      {
        reviewerName: newReview.consulteeProfile?.user?.name || "User",
        rating: newReview.rating,
        comment: newReview.reviewDescription || undefined,
        planTitle: undefined,
        dashboardUrl: "/dashboard/consultant/reviews",
      },
    );

    return NextResponse.json(newReview, { status: 201 });
  } catch (error) {
    console.error("Error creating review:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

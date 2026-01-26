/**
 * Staff Moderation Review Detail API
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { UserRole } from "@prisma/client";

interface RouteParams {
  params: Promise<{ reviewId: string }>;
}

/**
 * DELETE /api/staff/moderation/reviews/[reviewId]
 * Delete a review (admin only)
 */
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { role: true },
    });

    // Only admins can delete reviews
    if (user?.role !== UserRole.ADMIN) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { reviewId } = await params;

    const review = await prisma.consultantReview.findUnique({
      where: { id: reviewId },
      select: { consultantProfileId: true, rating: true },
    });

    if (!review) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    // Delete review and recalculate consultant rating
    await prisma.$transaction(async (tx) => {
      // Delete the review
      await tx.consultantReview.delete({
        where: { id: reviewId },
      });

      // Recalculate average rating
      const remainingReviews = await tx.consultantReview.aggregate({
        where: { consultantProfileId: review.consultantProfileId },
        _avg: { rating: true },
        _count: { id: true },
      });

      await tx.consultantProfile.update({
        where: { id: review.consultantProfileId },
        data: {
          rating: remainingReviews._avg.rating || 0,
        },
      });
    });

    return NextResponse.json({
      success: true,
      message: "Review deleted and consultant rating recalculated",
    });
  } catch (error) {
    console.error("Error deleting review:", error);
    return NextResponse.json(
      { error: "Failed to delete review" },
      { status: 500 },
    );
  }
}

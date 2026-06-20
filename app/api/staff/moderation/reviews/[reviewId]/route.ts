/**
 * Staff Moderation Review Detail API
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
interface RouteParams {
  params: Promise<{ reviewId: string }>;
}

/**
 * DELETE /api/staff/moderation/reviews/[reviewId]
 * Delete a review (admin only)
 */
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;
    const session = auth.session;

    // Only admins can delete reviews
    if (session.user.role !== "ADMIN") {
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

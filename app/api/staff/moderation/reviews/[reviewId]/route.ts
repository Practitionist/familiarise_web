/**
 * Staff Moderation Review Detail API
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import { recomputeConsultantRating } from "@/lib/reviews";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { purgeReviewSurfaces } from "@/lib/data/public-cache";
import { Prisma } from "@prisma/client";
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

    // #705 — Serializable + retry, matching the three consultee-facing paths.
    // At READ COMMITTED a concurrent review write reads the same pre-image and
    // the second UPDATE overwrites an average computed without the first, so
    // the published score stays wrong with nothing to show for it.
    await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          await tx.consultantReview.delete({ where: { id: reviewId } });
          await recomputeConsultantRating(tx, review.consultantProfileId);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    // #705 — the moderation paths never purged, so a removed review kept
    // rendering on the landing page and explore for up to an hour.
    purgeReviewSurfaces(review.consultantProfileId);

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

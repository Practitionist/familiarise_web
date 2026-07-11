import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  requireApiAuth,
  isPrivileged,
  checkOwnership,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { recomputeConsultantRating } from "@/lib/reviews";

// GET: Public read (for trust/SEO purposes)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const review = await prisma.consultantReview.findUnique({
      where: { id: id },
      include: {
        consultantProfile: true,
        consulteeProfile: true,
      },
    });

    if (!review) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    return NextResponse.json(review, { status: 200 });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    console.error("Error getting review:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

// PUT: Requires auth + ownership
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const { id } = await params;

    // Fetch the review to check ownership
    const review = await prisma.consultantReview.findUnique({
      where: { id: id },
      select: { consulteeProfileId: true, consultantProfileId: true },
    });

    if (!review) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    // Check authorization: privileged users can update any, others only their own
    const isOwner = checkOwnership(
      session,
      review.consulteeProfileId,
      "consultee",
    );
    if (!isPrivileged(session.user.role) && !isOwner) {
      return forbiddenResponse("You can only update your own reviews");
    }

    const body = await req.json();
    // Update + rating recompute in one transaction — ConsultantProfile.rating
    // is denormalized for explore sort/filter and must track every mutation.
    const updatedReview = await prisma.$transaction(async (tx) => {
      const updated = await tx.consultantReview.update({
        where: { id: id },
        data: {
          rating: body.rating,
          reviewDescription: body.reviewDescription,
        },
        include: {
          consultantProfile: true,
          consulteeProfile: true,
        },
      });

      await recomputeConsultantRating(tx, review.consultantProfileId);

      return updated;
    });

    return NextResponse.json(updatedReview, { status: 200 });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    console.error("Error updating review:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

// DELETE: Requires auth + ownership
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const { id } = await params;

    // Fetch the review to check ownership
    const review = await prisma.consultantReview.findUnique({
      where: { id: id },
      select: { consulteeProfileId: true, consultantProfileId: true },
    });

    if (!review) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    // Check authorization: privileged users can delete any, others only their own
    const isOwner = checkOwnership(
      session,
      review.consulteeProfileId,
      "consultee",
    );
    if (!isPrivileged(session.user.role) && !isOwner) {
      return forbiddenResponse("You can only delete your own reviews");
    }

    // Delete + rating recompute in one transaction — see PUT.
    await prisma.$transaction(async (tx) => {
      await tx.consultantReview.delete({
        where: { id: id },
      });
      await recomputeConsultantRating(tx, review.consultantProfileId);
    });

    return NextResponse.json(
      { message: "Review deleted successfully" },
      { status: 200 },
    );
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    console.error("Error deleting review:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

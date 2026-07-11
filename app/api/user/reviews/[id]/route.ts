import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  requireApiAuth,
  isPrivileged,
  checkOwnership,
  forbiddenResponse,
} from "@/lib/auth-helpers";

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

    // #693 — a moderation-removed review reads as gone
    if (review?.deletedAt) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }
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
      select: { consulteeProfileId: true, deletedAt: true },
    });

    // #693 — a moderation-removed review cannot be edited back into view
    if (!review || review.deletedAt) {
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
    const updatedReview = await prisma.consultantReview.update({
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
      select: { consulteeProfileId: true },
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

    await prisma.consultantReview.delete({
      where: { id: id },
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

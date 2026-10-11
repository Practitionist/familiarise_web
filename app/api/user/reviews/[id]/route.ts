import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  requireApiAuth,
  checkOwnership,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import {
  recomputeConsultantRating,
  ModeratedReviewError,
  resolveRatingCausePatch,
} from "@/lib/reviews";
import {
  publicReviewSelect,
  sanitisePublicReview,
} from "@/lib/data/review-public";
import { purgeReviewSurfaces } from "@/lib/data/public-cache";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { applyRateLimit, reviewWriteLimiter } from "@/lib/rate-limit";
import { UpdateReviewSchema } from "@/schemas/feedbacks";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const review = await prisma.consultantReview.findFirst({
      where: { id, deletedAt: null },
      select: publicReviewSelect,
    });

    if (!review) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    return NextResponse.json(sanitisePublicReview(review), { status: 200 });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    console.error("Error getting review:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const limited = await applyRateLimit(
      reviewWriteLimiter,
      `reviews:${session.user.id}`,
    );
    if (limited) return limited;

    const { id } = await params;

    const review = await prisma.consultantReview.findUnique({
      where: { id: id },
      select: {
        consulteeProfileId: true,
        consultantProfileId: true,
        deletedAt: true,
      },
    });

    if (!review || review.deletedAt) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    if (!checkOwnership(session, review.consulteeProfileId, "consultee")) {
      return forbiddenResponse("You can only update your own reviews");
    }

    const parsed = UpdateReviewSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.issues },
        { status: 400 },
      );
    }
    const body = parsed.data;

    const updatedReview = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const current = await tx.consultantReview.findUnique({
            where: { id: id },
            select: {
              deletedAt: true,
              rating: true,
              reviewDescription: true,
              repliedAt: true,
              replyDeletedAt: true,
            },
          });
          if (!current || current.deletedAt) throw new ModeratedReviewError();

          const textChanged =
            (body.rating !== undefined && body.rating !== current.rating) ||
            (body.reviewDescription !== undefined &&
              (body.reviewDescription ?? null) !==
                (current.reviewDescription ?? null));
          if (textChanged) {
            const bumped = await tx.consultantReview.update({
              where: { id: id },
              data: { revisionNo: { increment: 1 }, editedAt: new Date() },
              select: { revisionNo: true },
            });
            await tx.consultantReviewRevision.create({
              data: {
                reviewId: id,
                revisionNo: bumped.revisionNo - 1,
                rating: current.rating,
                reviewDescription: current.reviewDescription,
                afterPublicReply:
                  current.repliedAt !== null && current.replyDeletedAt === null,
              },
            });
          }

          const updated = await tx.consultantReview.update({
            where: { id: id },
            data: {
              rating: body.rating,
              reviewDescription: body.reviewDescription,
              isAnonymous: body.isAnonymous,
              ...resolveRatingCausePatch(
                body.rating ?? current.rating,
                body.ratingCause,
              ),
            },
            select: publicReviewSelect,
          });

          await recomputeConsultantRating(tx, review.consultantProfileId);

          return updated;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    purgeReviewSurfaces(review.consultantProfileId);

    return NextResponse.json(sanitisePublicReview(updatedReview), {
      status: 200,
    });
  } catch (error) {
    if (error instanceof ModeratedReviewError) {
      return NextResponse.json(
        {
          error:
            "This review was removed by our moderation team and can't be edited.",
        },
        { status: 409 },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    console.error("Error updating review:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    const limited = await applyRateLimit(
      reviewWriteLimiter,
      `reviews:${session.user.id}`,
    );
    if (limited) return limited;

    const { id } = await params;

    const review = await prisma.consultantReview.findUnique({
      where: { id: id },
      select: {
        consulteeProfileId: true,
        consultantProfileId: true,
        deletedAt: true,
        removedBy: true,
      },
    });

    if (!review) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    if (!checkOwnership(session, review.consulteeProfileId, "consultee")) {
      return forbiddenResponse("You can only delete your own reviews");
    }

    if (review.deletedAt) {
      if (review.removedBy === "AUTHOR") {
        return NextResponse.json(
          { message: "Review withdrawn" },
          { status: 200 },
        );
      }
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    // Soft, never hard: the unique is not partial on `deletedAt`, so the withdrawn
    // row keeps its slot and `removedBy = AUTHOR` is what lets the author revive it.
    await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const removed = await tx.consultantReview.updateMany({
            // Idempotent and race-safe: the second of two concurrent deletes
            // writes nothing rather than overwriting the first one's timestamp
            // and its attribution.
            where: { id, deletedAt: null },
            data: { deletedAt: new Date(), removedBy: "AUTHOR" },
          });
          if (removed.count === 0) return;
          await recomputeConsultantRating(tx, review.consultantProfileId);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    purgeReviewSurfaces(review.consultantProfileId);

    return NextResponse.json(
      { message: "Review deleted successfully" },
      { status: 200 },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    console.error("Error deleting review:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

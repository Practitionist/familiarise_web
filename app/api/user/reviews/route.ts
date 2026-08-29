import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { stripAnonymousReviewers } from "@/lib/data/review-privacy";
import { consultantPublicScalars } from "@/lib/data/consultant-public";
import { Prisma } from "@prisma/client";
import { notifyNewReview } from "@/lib/novu";
import { CreateReviewSchema } from "@/schemas/feedbacks";
import { apiError } from "@/lib/errors";
import { getSession } from "@/lib/auth-server";
import { purgeReviewSurfaces } from "@/lib/data/public-cache";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import {
  recomputeConsultantRating,
  resolveReviewableSession,
} from "@/lib/reviews";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

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

    // #693 — moderation-removed reviews stay hidden
    whereClause.deletedAt = null;
    const reviews = await prisma.consultantReview.findMany({
      where: whereClause,
      take: 50,
      include: {
        // #946 allowlist. This route is PUBLIC (middleware.ts marks it so) and
        // its response is CDN-cached, so a bare `include:` here published every
        // reviewed consultant's panNumber / ibanOrAccount / swiftBic /
        // udyamNumber to anonymous callers.
        consultantProfile: {
          select: {
            ...consultantPublicScalars,
            user: { select: { name: true } },
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
      // PUBLIC and CDN-cached: a name withheld by the reviewer must not ship
      // in the payload, or the anonymity is cosmetic.
      { data: stripAnonymousReviewers(reviews) },
      {
        status: 200,
        headers: {
          "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    return apiError({ tag: "[Reviews.GET]", error });
  }
}

/** Thrown when the author tries to edit a review moderation has removed. */
class ModeratedReviewError extends Error {}

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

    // Reviews are always authored as the session user's own consultee profile.
    const sessionConsulteeProfileId = session.user.consulteeProfileId;
    if (!sessionConsulteeProfileId) {
      return NextResponse.json(
        { error: "You need a consultee profile to post a review" },
        { status: 403 },
      );
    }

    // #705 — eligibility is now per SESSION, and it is what tells us who is
    // being reviewed. One message for "not yours", "not held" and "not paid":
    // distinguishing them would leak whether an appointment exists.
    const reviewable = await resolveReviewableSession(
      sessionConsulteeProfileId,
      session.user.id,
      validatedData.appointmentId,
    );
    if (!reviewable) {
      return NextResponse.json(
        {
          error:
            "You can only review a session you attended and paid for, once it has taken place",
        },
        { status: 403 },
      );
    }

    // Create + rating recompute in one transaction so the denormalized
    // ConsultantProfile.rating (explore sort/filter) never drifts. Serializable
    // + retry so two concurrent reviews for the same consultant can't lose-update
    // the recomputed average (P2034 aborts one, retry then sees the committed row).
    const newReview = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // A review that moderation removed cannot be edited back into existence,
          // and accepting the edit silently would tell the author it was published
          // when nothing changed on the page.
          const existing = await tx.consultantReview.findUnique({
            where: {
              consultantProfileId_consulteeProfileId: {
                consultantProfileId: reviewable.consultantProfileId,
                consulteeProfileId: sessionConsulteeProfileId,
              },
            },
            select: { deletedAt: true },
          });
          if (existing?.deletedAt) throw new ModeratedReviewError();

          // UPSERT, not create. There is one review per consultant per consultee,
          // so a second session with the same person updates the opinion rather
          // than colliding on the unique — and `appointmentId`/`ratingUnitId` move
          // to the session that prompted this edit, which is what keeps the group
          // weighting pointed at the most recent thing they actually attended.
          const created = await tx.consultantReview.upsert({
            where: {
              consultantProfileId_consulteeProfileId: {
                consultantProfileId: reviewable.consultantProfileId,
                consulteeProfileId: sessionConsulteeProfileId,
              },
            },
            update: {
              rating: validatedData.rating,
              reviewDescription: validatedData.reviewDescription,
              appointmentId: reviewable.appointmentId,
              ratingUnitId: reviewable.ratingUnitId,
              isAnonymous: validatedData.isAnonymous ?? undefined,
              // A moderated-away review must not be resurrected by re-submitting.
              deletedAt: undefined,
            },
            create: {
              rating: validatedData.rating,
              reviewDescription: validatedData.reviewDescription,
              consultantProfileId: reviewable.consultantProfileId,
              consulteeProfileId: sessionConsulteeProfileId,
              appointmentId: reviewable.appointmentId,
              isAnonymous: validatedData.isAnonymous ?? false,
              // Denormalized at write time: `groupBy` can only group on this
              // model's own scalars, and this is what makes a 200-seat webinar one
              // data point instead of two hundred.
              ratingUnitId: reviewable.ratingUnitId,
            },
            include: {
              // #946 allowlist — the response goes back to the consultee who wrote
              // the review; a bare `include:` handed them the consultant's PAN and
              // bank account.
              consultantProfile: {
                select: {
                  ...consultantPublicScalars,
                  user: { select: { name: true } },
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

          await recomputeConsultantRating(tx, created.consultantProfileId);

          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    // Notify the consultant about the new review
    void notifyNewReview(newReview.consultantProfile.userId, {
      reviewerName: newReview.consulteeProfile?.user?.name || "User",
      rating: newReview.rating,
      comment: newReview.reviewDescription || undefined,
      planTitle: reviewable.title,
      // `/dashboard/consultant/reviews` never existed — the link 404'd for
      // every review ever notified. The capability router picks the viewer's
      // tree from a bare /dashboard.
      dashboardUrl: "/dashboard",
    });

    // Reviews are the landing page's testimonials and they move the expert's
    // denormalized rating, which orders the directory — both surfaces are stale
    // until purged, and the landing page's window is an hour.
    purgeReviewSurfaces(newReview.consultantProfileId);

    return NextResponse.json(newReview, { status: 201 });
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
    // @@unique([consultantProfileId, consulteeProfileId]) — one per consultant.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "You have already reviewed this session" },
        { status: 409 },
      );
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    return apiError({ tag: "[Reviews.POST]", error });
  }
}

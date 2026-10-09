import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma, { type Tx } from "@/lib/prisma";
import {
  publicReviewSelect,
  sanitisePublicReview,
  sanitisePublicReviews,
} from "@/lib/data/review-public";
import { Prisma } from "@prisma/client";
import { attemptTrigger, notifyNewReview } from "@/lib/novu";
import { goHref } from "@/lib/dashboard/go";
import { EMAIL_BUDGET_MS, sendNewReviewEmail } from "@/lib/email";
import { CreateReviewSchema } from "@/schemas/feedbacks";
import { apiError } from "@/lib/errors";
import { getSession } from "@/lib/auth-server";
import { purgeReviewSurfaces } from "@/lib/data/public-cache";
import { reviewWriteLimiter, applyRateLimit } from "@/lib/rate-limit";
import {
  ModeratedReviewError,
  pickExistingReview,
  recomputeConsultantRating,
  resolveRatingCausePatch,
  resolveReviewableSession,
} from "@/lib/reviews";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { z } from "zod";

async function recordReviewRevisionIfChanged(
  tx: Tx,
  existing: {
    id: string;
    rating: number;
    reviewDescription: string | null;
    repliedAt: Date | null;
    replyDeletedAt: Date | null;
  },
  nextRating: number,
  nextDescription: string | null | undefined,
): Promise<void> {
  const textChanged =
    existing.rating !== nextRating ||
    (existing.reviewDescription ?? null) !== (nextDescription ?? null);
  if (!textChanged) return;

  const bumped = await tx.consultantReview.update({
    where: { id: existing.id },
    data: { revisionNo: { increment: 1 }, editedAt: new Date() },
    select: { revisionNo: true },
  });
  await tx.consultantReviewRevision.create({
    data: {
      reviewId: existing.id,
      revisionNo: bumped.revisionNo - 1,
      rating: existing.rating,
      reviewDescription: existing.reviewDescription,
      afterPublicReply:
        existing.repliedAt !== null && existing.replyDeletedAt === null,
    },
  });
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const rating = searchParams.get("rating");
    const consultantId = searchParams.get("consultantId");
    const searchTerm = searchParams.get("search");

    const whereClause: Prisma.ConsultantReviewWhereInput = {};

    if (rating !== null) {
      // `parseInt("4junk")` is 4 and `parseInt("abc")` is NaN; neither belongs
      // in a Prisma filter.
      const minRating = z.coerce.number().int().min(1).max(5).safeParse(rating);
      if (!minRating.success) {
        return NextResponse.json(
          { error: "rating must be an integer from 1 to 5" },
          { status: 400 },
        );
      }
      whereClause.rating = { gte: minRating.data };
    }

    if (consultantId) {
      whereClause.consultantProfileId = consultantId;
    }

    // NO consulteeProfileId filter. This route is PUBLIC (middleware.ts) and
    // CDN-cached, so an unauthenticated caller could pass any profile id and
    // read back that person's reviews — including the ones they marked
    // anonymous. Stripping `consulteeProfile` from the RESPONSE does nothing
    // there: the caller supplied the identity, so the filter itself is the
    // de-anonymisation. Nothing in the app ever passed this parameter.
    // A "my reviews" surface must authenticate and derive the profile from the
    // session, not accept it from the query string.

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
      // The allowlist. This route is PUBLIC (middleware.ts marks it so) and its
      // response is CDN-cached, so a bare `include:` here published every
      // reviewed consultant's statutory PII AND every named reviewer's private
      // profile — `goals`, `aboutMe`, `careerStage`, `budgetPreference`.
      select: publicReviewSelect,
      orderBy: {
        rating: "desc",
      },
    });

    return NextResponse.json(
      // PUBLIC and CDN-cached: a name withheld by the reviewer must not ship
      // in the payload, or the anonymity is cosmetic.
      { data: sanitisePublicReviews(reviews) },
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

export async function POST(req: NextRequest) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 20 writes an hour: an edit is a POST too, so 5 shut out "write, tweak twice".
    const rl = await applyRateLimit(
      reviewWriteLimiter,
      `reviews:${session.user.id}`,
    );
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
    const writeResult = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // #1549 — the pair's review for THIS (track, event), or a NULL-track legacy
          // row the write adopts. The same rule the composer uses (pickExistingReview),
          // so the form never shows a review this write would not update.
          const candidates = await tx.consultantReview.findMany({
            where: {
              consultantProfileId: reviewable.consultantProfileId,
              consulteeProfileId: sessionConsulteeProfileId,
              OR: [
                {
                  track: reviewable.track,
                  ratingUnitId: reviewable.ratingUnitId,
                },
                { track: null },
              ],
            },
            select: {
              id: true,
              deletedAt: true,
              removedBy: true,
              track: true,
              ratingUnitId: true,
              rating: true,
              reviewDescription: true,
              revisionNo: true,
              repliedAt: true,
              replyDeletedAt: true,
            },
          });
          const existing = pickExistingReview(
            candidates,
            reviewable.track,
            reviewable.ratingUnitId,
          );
          // An author's withdrawal is revivable; a moderation removal is not.
          const withdrawnByAuthor =
            existing !== null &&
            existing.deletedAt !== null &&
            existing.removedBy === "AUTHOR";
          if (existing?.deletedAt && !withdrawnByAuthor) {
            throw new ModeratedReviewError();
          }

          // An explicit select, never `include`: `include` returns every scalar on
          // the row, which (a) hands the author staff-only columns and (b) fails
          // with P2022 whenever the schema is pushed ahead of the deploy — the
          // documented order. Only what the notification below reads.
          const select = {
            ...publicReviewSelect,
            updatedAt: true,
            consultantProfile: {
              select: { userId: true, user: { select: { name: true } } },
            },
            consulteeProfile: {
              select: { user: { select: { name: true, image: true } } },
            },
          } as const;

          let created;
          if (existing) {
            await recordReviewRevisionIfChanged(
              tx,
              existing,
              validatedData.rating,
              validatedData.reviewDescription,
            );

            created = await tx.consultantReview.update({
              where: { id: existing.id },
              data: {
                rating: validatedData.rating,
                reviewDescription: validatedData.reviewDescription,
                appointmentId: reviewable.appointmentId,
                track: reviewable.track,
                ratingUnitId: reviewable.ratingUnitId,
                ...(reviewable.heldAt
                  ? { ratedOccurrenceAt: reviewable.heldAt }
                  : {}),
                isAnonymous: validatedData.isAnonymous ?? undefined,
                ...resolveRatingCausePatch(
                  validatedData.rating,
                  validatedData.ratingCause,
                ),
                ...(withdrawnByAuthor
                  ? { deletedAt: null, removedBy: null }
                  : {}),
              },
              select,
            });
          } else {
            created = await tx.consultantReview.create({
              data: {
                rating: validatedData.rating,
                reviewDescription: validatedData.reviewDescription,
                consultantProfileId: reviewable.consultantProfileId,
                consulteeProfileId: sessionConsulteeProfileId,
                appointmentId: reviewable.appointmentId,
                isAnonymous: validatedData.isAnonymous ?? false,
                ...resolveRatingCausePatch(
                  validatedData.rating,
                  validatedData.ratingCause ?? null,
                ),
                track: reviewable.track,
                ratingUnitId: reviewable.ratingUnitId,
                ratedOccurrenceAt: reviewable.heldAt,
              },
              select,
            });
          }

          await recomputeConsultantRating(tx, created.consultantProfileId);

          const isNew = !existing || withdrawnByAuthor;
          let stagedBell = null;
          if (isNew) {
            const reviewerName = created.isAnonymous
              ? "A verified client"
              : created.consulteeProfile?.user?.name || "User";
            const reviewsInboxHref = goHref("expert", "reviews");
            const triggerResult = await notifyNewReview(
              created.consultantProfile.userId,
              {
                reviewerName,
                rating: created.rating,
                comment: created.reviewDescription || undefined,
                planTitle: reviewable.title,
                dashboardUrl: reviewsInboxHref,
              },
              `review-published:${created.id}:${created.updatedAt.getTime()}`,
              { tx },
            );
            stagedBell = triggerResult.staged ?? null;
          }

          return { review: created, isNew, stagedBell };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    const { review: newReview, isNew, stagedBell } = writeResult;

    if (isNew) {
      if (stagedBell) {
        await attemptTrigger(stagedBell);
      }
      const reviewerName = newReview.isAnonymous
        ? "A verified client"
        : newReview.consulteeProfile?.user?.name || "User";
      const reviewsInboxHref = goHref("expert", "reviews");
      await sendNewReviewEmail(
        {
          reviewId: newReview.id,
          consultantUserId: newReview.consultantProfile.userId,
          reviewerName,
          rating: newReview.rating,
          comment: newReview.reviewDescription,
          reviewUrl: reviewsInboxHref,
        },
        EMAIL_BUDGET_MS.REQUEST,
      );
    }

    purgeReviewSurfaces(newReview.consultantProfileId);

    const {
      consultantProfile,
      updatedAt: _updatedAt,
      ...publicRow
    } = newReview;
    return NextResponse.json(
      sanitisePublicReview({
        ...publicRow,
        consultantProfile: { user: consultantProfile.user },
      }),
      { status: isNew ? 201 : 200 },
    );
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
    // The sidecar unique (pair, track, event), lost as a find-then-create race:
    // one review per expert for 1:1, one per event for a webinar or class (#1549).
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        {
          error:
            "You already have a review for this expert or event. Reload to edit the one you have.",
        },
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

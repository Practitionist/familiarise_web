/**
 * GET /api/consultant/reviews — the signed-in consultant's own reviews (#1527
 * Q5, #1300). Session-derived: there is no id to swap, so nobody reads another
 * consultant's inbox. `?cursor=` pages, `?rating=1..5` and `?needsReply=1`
 * filter. Replies go through the existing `/api/user/reviews/[id]/reply`.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireOwnConsultantProfile } from "@/lib/api/consultant-profile";
import { apiError } from "@/lib/errors/api-error";
import {
  REVIEWS_PAGE_SIZE,
  readOwnReviews,
} from "@/lib/data/consultant-reviews-inbox";

function ratingParam(raw: string | null): number | null {
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return n >= 1 && n <= 5 ? n : null;
}

export async function GET(request: NextRequest) {
  try {
    const { profileId, error } = await requireOwnConsultantProfile();
    if (error) return error;
    const params = request.nextUrl.searchParams;
    const limitRaw = Number.parseInt(params.get("limit") ?? "", 10);
    const data = await readOwnReviews({
      consultantProfileId: profileId,
      cursor: params.get("cursor"),
      rating: ratingParam(params.get("rating")),
      needsReply: params.get("needsReply") === "1",
      limit: limitRaw > 0 ? Math.min(limitRaw, 50) : REVIEWS_PAGE_SIZE,
    });
    // One person's inbox, with anonymous reviews in it: never shared, never stored.
    return NextResponse.json(
      { data },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiError({
      tag: "[Consultant.Reviews.GET]",
      error,
      fallbackMessage: "Failed to load your reviews",
    });
  }
}

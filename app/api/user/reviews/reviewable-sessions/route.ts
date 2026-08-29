/**
 * #705 — the sessions this consultee may review.
 *
 * Reviews became per-session, so "can I review X" is a question about an
 * appointment rather than about a consultant. The review card asks this before
 * rendering, and the same helper backs the POST's authorization — one rule, not
 * two that can disagree.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { supportError } from "@/lib/api/support-http";
import {
  listReviewableSessions,
  resolveReviewableSession,
} from "@/lib/reviews";

const ROUTE = "user.reviews.reviewable";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return supportError({ status: 401, code: "UNAUTHORIZED", context: { route: ROUTE } });
    }
    const consulteeProfileId = session.user.consulteeProfileId;
    // Not having a consultee profile is not an error — it just means there is
    // nothing to review, and the card renders nothing.
    if (!consulteeProfileId) {
      return NextResponse.json({ data: [] });
    }

    const appointmentId = req.nextUrl.searchParams.get("appointmentId");
    if (appointmentId) {
      const one = await resolveReviewableSession(
        consulteeProfileId,
        session.user.id,
        appointmentId,
      );
      return NextResponse.json({ data: one ? [one] : [] });
    }

    return NextResponse.json({
      data: await listReviewableSessions(consulteeProfileId, session.user.id),
    });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: ROUTE },
    });
  }
}

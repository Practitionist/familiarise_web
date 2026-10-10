/**
 * #705 — the sessions this consultee may review.
 *
 * Reviews became per-session, so "can I review X" is a question about an
 * appointment rather than about a consultant. The review card asks this before
 * rendering, and the same helper backs the POST's authorization — one rule, not
 * two that can disagree.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth-server";
import { supportError } from "@/lib/api/support-http";
import {
  listReviewableSessions,
  resolveReviewableSession,
} from "@/lib/reviews";

const ROUTE = "user.reviews.reviewable";

// #831 — every caller-supplied string is parsed and bounded before it reaches a
// query. Both ids are cuid/uuid-shaped, so 64 characters is generous.
const QuerySchema = z.object({
  consultantProfileId: z.string().min(1).max(64).optional(),
  appointmentId: z.string().min(1).max(64).optional(),
  unreviewed: z.enum(["0", "1"]).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return supportError({
        status: 401,
        code: "UNAUTHORIZED",
        context: { route: ROUTE },
      });
    }
    const consulteeProfileId = session.user.consulteeProfileId;
    if (!consulteeProfileId) {
      return NextResponse.json({ data: [] });
    }

    const query = QuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    if (!query.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: query.error.flatten(),
        context: { route: ROUTE },
      });
    }
    const { consultantProfileId, appointmentId, unreviewed } = query.data;
    const onlyUnreviewed = unreviewed === "1";

    if (consultantProfileId) {
      const items = await listReviewableSessions(
        consulteeProfileId,
        session.user.id,
        consultantProfileId,
      );
      return NextResponse.json({
        data: onlyUnreviewed ? items.filter((item) => !item.reviewed) : items,
      });
    }

    if (appointmentId) {
      const one = await resolveReviewableSession(
        consulteeProfileId,
        session.user.id,
        appointmentId,
      );
      const items = one ? [one] : [];
      return NextResponse.json({
        data: onlyUnreviewed ? items.filter((item) => !item.reviewed) : items,
      });
    }

    const items = await listReviewableSessions(
      consulteeProfileId,
      session.user.id,
    );
    return NextResponse.json({
      data: onlyUnreviewed ? items.filter((item) => !item.reviewed) : items,
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

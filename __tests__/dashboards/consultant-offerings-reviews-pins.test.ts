/**
 * @jest-environment node
 */

/**
 * Two consultant pins: Delete is offered only on an untouched plan, and the
 * Reviews inbox reads the session's own profile and nobody else's.
 */

jest.mock("server-only", () => ({}));

const requireOwnConsultantProfile = jest.fn();
jest.mock("../../lib/api/consultant-profile", () => ({
  requireOwnConsultantProfile: () => requireOwnConsultantProfile(),
}));

const readOwnReviews = jest.fn();
jest.mock("../../lib/reviews-inbox", () => ({
  REVIEWS_PAGE_SIZE: 20,
  readOwnReviews: (args: unknown) => readOwnReviews(args),
}));

import { NextRequest, NextResponse } from "next/server";

import {
  TOUCHED_EVENT,
  UNTOUCHED_EVENT,
  UNTOUCHED_PLAN,
} from "@/lib/offerings/delete-guard";
import { GET as getReviews } from "@/app/api/consultant/reviews/route";

// #1846 — the card and the DELETE routes share one guard, so they cannot
// disagree, and any seat ever held counts (no status filter), released or not.
it("offers Delete only where the server's own no-history guard would pass", () => {
  expect(UNTOUCHED_EVENT).toEqual({ NOT: TOUCHED_EVENT });
  expect(UNTOUCHED_PLAN.webinar).toEqual({ webinars: { none: TOUCHED_EVENT } });
  expect(UNTOUCHED_PLAN.class).toEqual({ classes: { none: TOUCHED_EVENT } });
  expect(TOUCHED_EVENT.appointment.is.OR).toEqual([
    { payment: { some: {} } },
    { participants: { some: { role: "CONSULTEE" } } },
  ]);
  expect(UNTOUCHED_PLAN.subscription).toEqual({
    subscriptions: { none: {} },
    trials: { none: {} },
  });
});

it("reads the session's own reviews and ignores any id in the URL", async () => {
  requireOwnConsultantProfile.mockResolvedValueOnce({
    error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
  });
  const denied = await getReviews(
    new NextRequest("http://x/api/consultant/reviews?consultantProfileId=cp-2"),
  );
  expect(denied.status).toBe(401);
  expect(readOwnReviews).not.toHaveBeenCalled();

  requireOwnConsultantProfile.mockResolvedValueOnce({ profileId: "cp-1" });
  readOwnReviews.mockResolvedValueOnce({ rows: [], nextCursor: null });
  const own = await getReviews(
    new NextRequest(
      "http://x/api/consultant/reviews?consultantProfileId=cp-2&rating=9&needsReply=1",
    ),
  );
  expect(own.status).toBe(200);
  expect(own.headers.get("Cache-Control")).toBe("private, no-store");
  expect(readOwnReviews).toHaveBeenCalledWith(
    expect.objectContaining({
      consultantProfileId: "cp-1",
      rating: null,
      needsReply: true,
    }),
  );
});

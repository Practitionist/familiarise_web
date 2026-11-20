/**
 * @jest-environment node
 */

/**
 * The booking page's review form asks the reviewable-sessions route about one
 * appointment: the query it sends passes the route's schema, and the route's
 * answer parses on the client.
 */

import { NextRequest } from "next/server";
import type { ReviewableSession } from "@/lib/reviews";

const mockResolve = jest.fn();
const mockList = jest.fn();
jest.mock("@/lib/reviews", () => ({
  resolveReviewableSession: (...args: unknown[]) => mockResolve(...args),
  listReviewableSessions: (...args: unknown[]) => mockList(...args),
}));
jest.mock("@/lib/auth-server", () => ({
  getSession: async () => ({
    user: { id: "u_daniel", consulteeProfileId: "ce_daniel" },
  }),
}));

import { GET } from "@/app/api/user/reviews/reviewable-sessions/route";
import { fetchReviewableSessions } from "@/components/reviews/reviewable-sessions";

const held: ReviewableSession = {
  appointmentId: "appt_held",
  consultantProfileId: "cp_pending_verification",
  consultantName: "Michael Anderson",
  track: "ONE_TO_ONE",
  ratingUnitId: null,
  appointmentType: "CONSULTATION",
  title: "Career consultation",
  heldAt: new Date("2026-11-10T05:30:00.000Z"),
  reviewed: true,
  profileIsPublic: false,
  existingReview: {
    id: "rev_1",
    rating: 4,
    reviewDescription: "Practical and well paced.",
    ratingCause: null,
    isAnonymous: true,
  },
};

afterEach(() => {
  jest.restoreAllMocks();
});

it("resolves exactly the booking the form sits on", async () => {
  mockResolve.mockResolvedValue(held);
  jest
    .spyOn(global, "fetch")
    .mockImplementation(async (input) =>
      GET(new NextRequest(new URL(String(input), "http://localhost"))),
    );

  const rows = await fetchReviewableSessions({ appointmentId: "appt_held" });

  expect(mockResolve).toHaveBeenCalledWith(
    "ce_daniel",
    "u_daniel",
    "appt_held",
  );
  expect(mockList).not.toHaveBeenCalled();
  expect(rows).toEqual([
    {
      appointmentId: "appt_held",
      consultantName: "Michael Anderson",
      title: "Career consultation",
      heldAt: "2026-11-10T05:30:00.000Z",
      profileIsPublic: false,
      // An anonymous review reopens anonymous, so an edit does not publish the name.
      existingReview: {
        id: "rev_1",
        rating: 4,
        reviewDescription: "Practical and well paced.",
        ratingCause: null,
        isAnonymous: true,
      },
    },
  ]);
});

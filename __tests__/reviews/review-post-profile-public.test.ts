/**
 * @jest-environment node
 */

/**
 * The review POST tells its author whether the expert's public profile is
 * served, by the same gate as the profile page (VERIFIED and not deleted).
 */

import { NextRequest } from "next/server";

const mockCreate = jest.fn();
const tx = {
  consultantReview: { findMany: jest.fn(async () => []), create: mockCreate },
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) },
}));
jest.mock("@/lib/auth-server", () => ({
  getSession: async () => ({
    user: { id: "u_daniel", consulteeProfileId: "ce_daniel" },
  }),
}));
jest.mock("@/lib/rate-limit", () => ({
  reviewWriteLimiter: {},
  applyRateLimit: async () => null,
}));
jest.mock("@/lib/db/serializable-retry", () => ({
  withSerializableRetry: (fn: () => unknown) => fn(),
}));
jest.mock("@/lib/reviews", () => ({
  ModeratedReviewError: class extends Error {},
  pickExistingReview: () => null,
  recomputeConsultantRating: async () => undefined,
  resolveRatingCausePatch: () => ({}),
  resolveReviewableSession: async () => ({
    appointmentId: "appt_held",
    consultantProfileId: "cp_michael",
    track: "ONE_TO_ONE",
    ratingUnitId: null,
    title: "Career consultation",
    heldAt: new Date("2026-11-10T05:30:00.000Z"),
  }),
}));
jest.mock("@/lib/novu", () => ({
  notifyNewReview: async () => ({ staged: null }),
}));
jest.mock("@/lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: async () => undefined,
}));
jest.mock("@/lib/email/senders/people", () => ({
  stageNewReviewEmail: async () => [],
}));
jest.mock("@/lib/data/public-cache", () => ({
  purgeReviewSurfaces: () => undefined,
}));

import { POST } from "@/app/api/user/reviews/route";

function createdRow(verificationStatus: string, deletedAt: Date | null) {
  return {
    id: "rev_1",
    rating: 5,
    reviewDescription: null,
    isAnonymous: false,
    consultantProfileId: "cp_michael",
    updatedAt: new Date("2026-11-20T10:00:00.000Z"),
    replyDeletedAt: null,
    excludedFromAggregateAt: null,
    consultantProfile: {
      userId: "u_michael",
      verificationStatus,
      deletedAt,
      user: { name: "Michael Anderson" },
    },
    consulteeProfile: { user: { name: "Daniel Brown", image: null } },
  };
}

it.each([
  ["VERIFIED", null, true],
  ["PENDING_VERIFICATION", null, false],
  ["VERIFIED", new Date("2026-11-19T00:00:00.000Z"), false],
])(
  "an expert %s (deleted %s) answers profileIsPublic=%s",
  async (status, deletedAt, expected) => {
    mockCreate.mockResolvedValue(createdRow(status, deletedAt));
    const res = await POST(
      new NextRequest("http://localhost/api/user/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: 5, appointmentId: "appt_held" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.profileIsPublic).toBe(expected);
    // The answer is projected away from the row: the status itself is not published.
    expect(body.consultantProfile).toEqual({
      user: { name: "Michael Anderson" },
    });
    expect(
      mockCreate.mock.calls[0][0].select.consultantProfile.select,
    ).toMatchObject({ verificationStatus: true, deletedAt: true });
  },
);

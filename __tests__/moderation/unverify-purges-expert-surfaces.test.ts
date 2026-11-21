/**
 * @jest-environment node
 */

/**
 * A moderation reject purges the expert's public profile after the action
 * commits, so a cached page stops offering trials and requests at once.
 */

import { NextRequest } from "next/server";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/auth-helpers", () => ({
  isPrivileged: () => true,
  requireBackofficeSurface: async () => ({
    session: { user: { id: "op-1", role: "ADMIN" } },
  }),
}));

const mockDb = {
  opsActionLog: { create: jest.fn(async () => ({ id: "ops-row" })) },
  moderationReport: {
    findUnique: jest.fn(async () => ({
      id: "report-1",
      type: "PROFILE",
      reason: "OTHER",
      status: "PENDING",
      reportedById: "u-2",
      targetUserId: "u-expert",
      reviewId: null,
      streamMessageId: null,
      review: null,
    })),
    updateMany: jest.fn(async () => ({ count: 1 })),
    findUniqueOrThrow: jest.fn(async () => ({
      id: "report-1",
      status: "ACTION_TAKEN",
    })),
  },
  moderationAction: { create: jest.fn(async () => ({ id: "act-1" })) },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return {
      ...mockDb,
      $transaction: async (run: (tx: typeof mockDb) => Promise<unknown>) => {
        const out = await run(mockDb);
        mockCommitted.push("commit");
        return out;
      },
    };
  },
}));
const mockCommitted: string[] = [];
const mockPurgeExpert = jest.fn((id: string) => {
  mockCommitted.push(`purge:${id}`);
});
jest.mock("../../lib/data/public-cache", () => ({
  purgeExpertSurfaces: (id: string) => mockPurgeExpert(id),
  purgeReviewSurfaces: jest.fn(),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(),
}));
jest.mock("../../lib/moderation/side-effects", () => ({
  prepareModerationNotices: async () => ({}),
  applyTransactionalEffects: async () => ({
    profilesUnverified: 1,
    unverifiedConsultantProfileId: "cp-9",
  }),
  applyBestEffortEffects: async (_input: unknown, t: unknown) => t,
  persistActionSideEffects: jest.fn(),
}));

import { POST as reportAction } from "../../app/api/staff/moderation/reports/[reportId]/action/route";

it("purges the rejected expert's public profile once the action has committed", async () => {
  const res = await reportAction(
    new NextRequest("http://test/door", {
      method: "POST",
      body: JSON.stringify({
        actionType: "PROFILE_UNVERIFIED",
        reason: "Credentials could not be confirmed",
      }),
    }),
    { params: Promise.resolve({ reportId: "report-1" }) },
  );

  expect(res.status).toBe(200);
  expect(mockPurgeExpert).toHaveBeenCalledTimes(1);
  expect(mockCommitted).toEqual(["commit", "purge:cp-9"]);
});

/**
 * @jest-environment node
 */

/**
 * #1584 P1-EC05 — invite/update cap collaborator shares at MAX_COLLAB_BPS
 * (9000, the 90 % ceiling that keeps the owner at 10 %), but settlement only
 * refused Σbps > 10000, so a legacy 9001–10000 set settled with the owner
 * under 10 %. `calculateRevenueSplit` now refuses at the same ceiling.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(),
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  removeUserFromEventChannel: jest.fn(),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyCollaboratorInvited: jest.fn(),
  notifyCollaboratorAccepted: jest.fn(),
  notifyCollaboratorRemoved: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

import { calculateRevenueSplit } from "@/lib/collaborators/service";

function txWithShares(bps: number[]) {
  return {
    collaborator: {
      findMany: jest.fn().mockResolvedValue(
        bps.map((revenueShareBps, i) => ({
          consultantProfileId: `collab-${i}`,
          status: "ACCEPTED",
          role: "CO_HOST",
          revenueShareBps,
          consultantProfile: { userId: `collab-user-${i}` },
        })),
      ),
    },
    webinarPlan: {
      findUnique: jest.fn().mockResolvedValue({ consultantProfileId: "owner" }),
    },
    classPlan: { findUnique: jest.fn() },
  };
}

describe("collaborator settlement honours the invite-time ceiling (#1584 P1-EC05)", () => {
  it("refuses a 9500-bps set instead of paying the owner 5 %", async () => {
    await expect(
      calculateRevenueSplit(
        "webinar",
        "plan-1",
        10_000,
        txWithShares([5000, 4500]) as never,
      ),
    ).rejects.toThrow(/9500 bps \(> 9000\)/);
  });

  it("still settles a set exactly at the ceiling", async () => {
    const splits = await calculateRevenueSplit(
      "webinar",
      "plan-1",
      10_000,
      txWithShares([9000]) as never,
    );
    expect(splits.map((s) => s.share)).toEqual([1000, 9000]);
  });
});

/**
 * @jest-environment node
 */

/**
 * Settlement calls `calculateRevenueSplit` inside the earnings transaction. On
 * a one-connection pool a read on the global client there queues behind the
 * connection the transaction holds, so every read goes through the client the
 * caller hands over, and the team is the one on the plan at the time given.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    collaborator: { findMany: jest.fn() },
    webinarPlan: { findUnique: jest.fn() },
    classPlan: { findUnique: jest.fn() },
  },
}));

import globalPrisma from "@/lib/prisma";
import { calculateRevenueSplit } from "@/lib/collaborators/revenue-split";

const AT = new Date("2026-03-10T09:00:00Z");
const WEBINAR = { planType: "webinar", planId: "plan-1" } as const;

function makeTx(shareBps: number[] = [3000]) {
  return {
    collaborator: {
      findMany: jest.fn().mockResolvedValue(
        shareBps.map((revenueShareBps, i) => ({
          id: `row-${i + 1}`,
          consultantProfileId: `collab-${i + 1}`,
          role: "CO_HOST",
          tier: "STANDARD",
          revenueShareBps,
          consultantProfile: { userId: `collab-user-${i + 1}` },
        })),
      ),
    },
    webinarPlan: {
      findUnique: jest.fn().mockResolvedValue({ consultantProfileId: "owner" }),
    },
    classPlan: { findUnique: jest.fn() },
  };
}

describe("calculateRevenueSplit reads through the client it is given", () => {
  it("performs every read on the passed client, for the team at the time given", async () => {
    const tx = makeTx();

    const splits = await calculateRevenueSplit(WEBINAR, 10_000, tx as never, {
      at: AT,
    });

    expect(tx.collaborator.findMany).toHaveBeenCalledTimes(1);
    expect(tx.collaborator.findMany.mock.calls[0][0].where).toEqual({
      webinarPlanId: "plan-1",
      acceptedAt: { lte: AT },
      OR: [{ endedAt: null }, { endedAt: { gt: AT } }],
      consultantProfile: { deletedAt: null },
    });
    expect(tx.webinarPlan.findUnique).toHaveBeenCalledTimes(1);
    expect(globalPrisma.collaborator.findMany).not.toHaveBeenCalled();
    expect(globalPrisma.webinarPlan.findUnique).not.toHaveBeenCalled();
    expect(globalPrisma.classPlan.findUnique).not.toHaveBeenCalled();
    expect(splits).toEqual([
      {
        consultantProfileId: "owner",
        organizationId: null,
        share: 7000,
        role: "OWNER",
      },
      { consultantProfileId: "collab-1", share: 3000, role: "CO_HOST" },
    ]);
  });

  it("reads the class plan through the same client", async () => {
    const tx = makeTx();
    tx.classPlan.findUnique.mockResolvedValue({ consultantProfileId: "owner" });
    await calculateRevenueSplit(
      { planType: "class", planId: "plan-1" },
      10_000,
      tx as never,
      { at: AT },
    );
    expect(tx.classPlan.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.webinarPlan.findUnique).not.toHaveBeenCalled();
    expect(globalPrisma.classPlan.findUnique).not.toHaveBeenCalled();
  });

  it("never pays a collaborator a share of their own seat, whatever the checkout guard saw", async () => {
    // An acceptance can land between the checkout guard's read and settlement;
    // the exclusion at the money boundary is what makes that window harmless.
    const splits = await calculateRevenueSplit(
      WEBINAR,
      10_000,
      makeTx() as never,
      { at: AT, excludeBuyerUserId: "collab-user-1" },
    );
    expect(splits).toEqual([]);
  });

  it("splits a zero amount to zero everywhere, never to a negative owner share", async () => {
    const splits = await calculateRevenueSplit(WEBINAR, 0, makeTx() as never, {
      at: AT,
    });
    expect(splits.map((s) => s.share)).toEqual([0, 0]);
  });

  it("leaves the owner the remainder of whatever shares the database allowed", async () => {
    const splits = await calculateRevenueSplit(
      WEBINAR,
      10_000,
      makeTx([5000, 4000]) as never,
      { at: AT },
    );
    expect(splits.map((s) => s.share)).toEqual([1000, 5000, 4000]);
  });
});

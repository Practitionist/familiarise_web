/** @jest-environment node */
import type { Collaborator } from "@prisma/client";
const mockFind = jest.fn();
const mockMove = jest.fn();
const mockRead = jest.fn();
let rejectCommit = false;
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const result = await fn(prisma);
      if (rejectCommit) throw new Error("commit failed");
      return result;
    },
    collaborator: {
      findMany: (...args: unknown[]) => mockFind(...args),
      updateMany: (...args: unknown[]) => mockMove(...args),
      findUniqueOrThrow: (...args: unknown[]) => mockRead(...args),
    },
  },
}));
jest.mock("../../lib/collaborators/notifications", () => ({
  stageCollaboratorNotifications: jest.fn(async () => ({})),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(async () => undefined),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: async (
    _name: string,
    _opts: unknown,
    fn: () => Promise<unknown>,
  ) => fn(),
}));
import prisma from "@/lib/prisma";
import { expireStaleCollaboratorInvites } from "@/lib/collaborators/cleanup";
import { stageCollaboratorNotifications } from "@/lib/collaborators/notifications";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
const row: Collaborator = {
  id: "c1",
  consultantProfileId: "cp1",
  invitedById: null,
  webinarPlanId: "wp1",
  classPlanId: null,
  collaboratorType: "WEBINAR",
  role: "CO_HOST",
  tier: "PRESENTER",
  revenueShareBps: 1000,
  status: "DECLINED",
  respondedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
beforeEach(() => {
  jest.clearAllMocks();
  rejectCommit = false;
  mockFind.mockResolvedValue([{ id: "c1" }]);
  mockMove.mockResolvedValue({ count: 1 });
  mockRead.mockResolvedValue(row);
});
it("rechecks the exact stale floor so a resend after scanning wins", async () => {
  mockMove.mockResolvedValueOnce({ count: 0 });
  expect(await expireStaleCollaboratorInvites()).toEqual({
    scanned: 1,
    expired: 0,
  });
  const floor = mockFind.mock.calls[0][0].where.updatedAt;
  expect(mockMove).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: "c1", status: "PENDING", updatedAt: floor },
    }),
  );
  expect(stageCollaboratorNotifications).not.toHaveBeenCalled();
});
it("stages inside the transaction and only flushes committed work", async () => {
  await expireStaleCollaboratorInvites();
  expect(stageCollaboratorNotifications).toHaveBeenCalledWith(
    prisma,
    "EXPIRED",
    row,
  );
  expect(flushNotificationsAfter).toHaveBeenCalledTimes(1);
});
it("never flushes a bundle from a failed commit", async () => {
  rejectCommit = true;
  await expect(expireStaleCollaboratorInvites()).rejects.toThrow(
    "Failed to stage 1",
  );
  expect(flushNotificationsAfter).toHaveBeenCalledWith(
    { bells: [], emails: [] },
    "collaborator.expired",
  );
});
it("aggregates staging errors while continuing the bounded batch", async () => {
  mockFind.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
  jest
    .mocked(stageCollaboratorNotifications)
    .mockRejectedValueOnce(new Error("render failed"));
  await expect(expireStaleCollaboratorInvites()).rejects.toThrow(
    "Failed to stage 1",
  );
  expect(mockMove).toHaveBeenCalledTimes(2);
  expect(stageCollaboratorNotifications).toHaveBeenCalledTimes(2);
});

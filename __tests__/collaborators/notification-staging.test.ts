/** @jest-environment node */
import type { Collaborator } from "@prisma/client";
const mockPlan = jest.fn();
const mockProfile = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webinarPlan: { findUnique: (...args: unknown[]) => mockPlan(...args) },
    classPlan: { findUnique: (...args: unknown[]) => mockPlan(...args) },
    consultantProfile: {
      findUnique: (...args: unknown[]) => mockProfile(...args),
    },
  },
}));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: jest.fn(async () => null),
}));
jest.mock("../../lib/email/senders/collaborators", () => ({
  stageCollaboratorLifecycleEmail: jest.fn(async () => []),
}));
jest.mock("../../lib/url", () => ({ getAppUrl: () => "https://example.test" }));
import prisma from "@/lib/prisma";
import { stageCollaboratorNotifications } from "@/lib/collaborators/notifications";
import { stageBell } from "@/lib/novu/stage-bell";
import { stageCollaboratorLifecycleEmail } from "@/lib/email/senders/collaborators";

const row: Collaborator = {
  id: "c1",
  consultantProfileId: "invitee",
  invitedById: "inviter",
  webinarPlanId: "wp1",
  classPlanId: null,
  collaboratorType: "WEBINAR",
  role: "CO_HOST",
  tier: "PRESENTER",
  revenueShareBps: 2500,
  status: "PENDING",
  respondedAt: null,
  createdAt: new Date("2026-09-01"),
  updatedAt: new Date("2026-10-01"),
};
beforeEach(() => {
  jest.clearAllMocks();
  mockPlan.mockResolvedValue({
    title: "Workshop",
    consultantProfile: {
      userId: "owner-user",
      user: { name: "Owner", erasedAt: null },
    },
  });
  mockProfile.mockImplementation(
    async ({ where }: { where: { id: string } }) => ({
      userId: `${where.id}-user`,
      user: { name: where.id, erasedAt: null },
    }),
  );
});

it.each([
  ["INVITED", ["invitee-user"]],
  ["REMOVED", ["invitee-user"]],
  ["ACCEPTED", ["owner-user"]],
  ["DECLINED", ["owner-user"]],
  ["WITHDRAWN", ["owner-user"]],
  ["EXPIRED", ["invitee-user", "inviter-user"]],
] as const)(
  "stages %s to its lifecycle audience with the transaction",
  async (event, recipients) => {
    await stageCollaboratorNotifications(prisma, event, row);
    expect(mockPlan).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "wp1" } }),
    );
    expect(stageBell).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        recipients,
        dedupeKey: `c1:${event}:2026-10-01T00:00:00.000Z`,
      }),
    );
    expect(stageCollaboratorLifecycleEmail).toHaveBeenCalledTimes(
      recipients.length,
    );
    for (const recipientUserId of recipients) {
      expect(stageCollaboratorLifecycleEmail).toHaveBeenCalledWith(
        prisma,
        event,
        expect.objectContaining({ recipientUserId }),
        `c1:${event}:2026-10-01T00:00:00.000Z`,
      );
    }
  },
);

it("a reinvitation has a new identity and a retry of that revision keeps it", async () => {
  await stageCollaboratorNotifications(prisma, "INVITED", row);
  await stageCollaboratorNotifications(prisma, "INVITED", {
    ...row,
    updatedAt: new Date("2026-10-02"),
  });
  await stageCollaboratorNotifications(prisma, "INVITED", {
    ...row,
    updatedAt: new Date("2026-10-02"),
  });
  expect(
    jest.mocked(stageBell).mock.calls.map(([, input]) => input.dedupeKey),
  ).toEqual([
    "c1:INVITED:2026-10-01T00:00:00.000Z",
    "c1:INVITED:2026-10-02T00:00:00.000Z",
    "c1:INVITED:2026-10-02T00:00:00.000Z",
  ]);
});

it("an email staging failure aborts the source transaction instead of being swallowed", async () => {
  jest
    .mocked(stageCollaboratorLifecycleEmail)
    .mockRejectedValueOnce(new Error("render failed"));
  await expect(
    stageCollaboratorNotifications(prisma, "ACCEPTED", row),
  ).rejects.toThrow("render failed");
});

it("forced departures can stage a generic name before personal data is scrubbed", async () => {
  await stageCollaboratorNotifications(
    prisma,
    "WITHDRAWN",
    row,
    "A collaborator",
  );
  expect(stageBell).toHaveBeenCalledWith(
    prisma,
    expect.objectContaining({
      payload: expect.objectContaining({ collaboratorName: "A collaborator" }),
    }),
  );
});

it("does not queue a notice without a surviving recipient", async () => {
  mockPlan.mockResolvedValue(null);
  mockProfile.mockResolvedValue(null);
  expect(await stageCollaboratorNotifications(prisma, "ACCEPTED", row)).toEqual(
    {},
  );
  expect(stageBell).not.toHaveBeenCalled();
});

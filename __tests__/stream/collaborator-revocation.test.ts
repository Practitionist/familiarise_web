/**
 * @jest-environment node
 */

const mockChatRemove = jest.fn();
const mockEventRemove = jest.fn();
const mockCallUpdate = jest.fn();
const mockCallMute = jest.fn();
const mockReport = jest.fn();

type Intent = { nextRetryAt: Date; status: string };
/** The open `COLLAB_REVOKE` row as Postgres would hold it. */
let intent: Intent | null = null;

const mockDb = {
  collaborator: { findFirst: jest.fn() },
  streamRevocationRetry: {
    updateMany: jest.fn(async (args: unknown) => {
      const { where, data } = args as {
        where: { nextRetryAt?: Date };
        data: { status: string };
      };
      if (data.status !== "SUCCEEDED" || !intent) return { count: 0 };
      if (where.nextRetryAt?.getTime() !== intent.nextRetryAt.getTime()) {
        return { count: 0 };
      }
      intent.status = "SUCCEEDED";
      return { count: 1 };
    }),
    createMany: jest.fn(async (args: unknown) => {
      const { data } = args as { data: { nextRetryAt: Date }[] };
      intent = { nextRetryAt: data[0].nextRetryAt, status: "PENDING" };
      return { count: 1 };
    }),
  },
  webinar: { findMany: jest.fn() },
  appointmentParticipant: {
    updateMany: jest.fn(async () => ({ count: 0 })),
    findMany: jest.fn(),
  },
  appointmentOccurrence: { findMany: jest.fn() },
};

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: mockDb }));
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: () => ({
    channel: (_type: string, id: string) => ({
      removeMembers: (ids: string[]) => mockChatRemove(id, ids),
    }),
  }),
  getStreamVideoClient: () => ({
    video: {
      call: (_type: string, id: string) => ({
        updateCallMembers: (payload: unknown) => mockCallUpdate(id, payload),
        updateUserPermissions: (payload: unknown) => mockCallMute(id, payload),
        kickUser: jest.fn(async () => ({})),
      }),
    },
  }),
  isStreamConfigured: () => true,
  isExpectedStreamError: () => false,
}));
jest.mock("../../lib/stream/event-channel-service", () => ({
  removeUsersFromEventChannel: (...args: unknown[]) => mockEventRemove(...args),
}));
jest.mock("../../lib/stream/dm-eligibility", () => ({}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReport(...args),
}));

import { isUncappedRevocationKind } from "../../lib/stream/revocation-retry-policy";
import { resetThrottledCaptureForTesting } from "../../lib/observability/throttled-capture";

/** Loaded on first use, after the mocks above exist. */
const revocation = () => import("../../lib/stream/access-revocation");

const ref = { planType: "webinar", planId: "plan-1" } as const;
const collabIntent = {
  kind: "COLLAB_REVOKE",
  userId: "u-1",
  planId: "plan-1",
  planType: "WEBINAR",
};

beforeEach(() => {
  jest.clearAllMocks();
  resetThrottledCaptureForTesting();
  intent = null;
  mockDb.collaborator.findFirst.mockResolvedValue(null);
  mockDb.webinar.findMany.mockResolvedValue([
    { id: "w-1", appointment: { id: "a-1" } },
    { id: "w-2", appointment: { id: "a-2" } },
  ]);
  mockDb.appointmentParticipant.findMany.mockResolvedValue([]);
  mockDb.appointmentOccurrence.findMany.mockResolvedValue([]);
  mockChatRemove.mockResolvedValue({});
  mockEventRemove.mockResolvedValue({ failedUserIds: [] });
  mockCallUpdate.mockResolvedValue({});
});

describe("a collaborator's revocation intent", () => {
  it("is written through the ending transaction at a generation it returns", async () => {
    const tx = {
      streamRevocationRetry: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        createMany: jest.fn(async () => ({ count: 1 })),
      },
    };

    const { persistCollaboratorRevocationInTx } = await revocation();
    const generation = await persistCollaboratorRevocationInTx(
      tx as unknown as Parameters<typeof persistCollaboratorRevocationInTx>[0],
      ref,
      "u-1",
    );

    expect(tx.streamRevocationRetry.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ ...collabIntent, nextRetryAt: generation }),
      ],
      skipDuplicates: true,
    });
    expect(generation.getTime()).toBeGreaterThan(Date.now());
    expect(mockDb.streamRevocationRetry.createMany).not.toHaveBeenCalled();
  });

  it("is written before any lookup or Stream call when the caller holds no generation", async () => {
    await (await revocation()).revokeCollaboratorAccess(ref, "u-1");

    const written = mockDb.streamRevocationRetry.createMany.mock;
    expect(written.calls[0][0]).toMatchObject({ data: [collabIntent] });
    const firstOf = (mock: jest.Mock) => mock.mock.invocationCallOrder[0];
    expect(written.invocationCallOrder[0]).toBeLessThan(
      firstOf(mockDb.collaborator.findFirst),
    );
    expect(written.invocationCallOrder[0]).toBeLessThan(
      firstOf(mockChatRemove),
    );
    expect(intent?.status).toBe("SUCCEEDED");
  });

  it("settles only the generation it owns, so a row re-armed during the drive stays owed", async () => {
    mockChatRemove.mockImplementationOnce(async () => {
      if (intent) intent.nextRetryAt = new Date(Date.now() + 10 * 60_000);
      return {};
    });

    await (await revocation()).revokeCollaboratorAccess(ref, "u-1");

    expect(mockEventRemove).toHaveBeenCalledTimes(2);
    expect(intent?.status).toBe("PENDING");
  });

  it("stays owed, with every other step still attempted, when one event channel fails", async () => {
    mockEventRemove.mockResolvedValueOnce({ failedUserIds: ["u-1"] });

    const { redriveAccessRevocation, revokeCollaboratorAccess } =
      await revocation();
    await expect(revokeCollaboratorAccess(ref, "u-1")).resolves.toBeUndefined();

    expect(mockEventRemove).toHaveBeenCalledWith("webinar", "w-2", ["u-1"]);
    expect(intent?.status).toBe("PENDING");
    await expect(
      redriveAccessRevocation({
        ...collabIntent,
        kind: "COLLAB_REVOKE",
        planType: "WEBINAR",
        counterpartUserId: null,
        createdAt: new Date(),
      }),
    ).resolves.toBeNull();
  });
});

describe("a collaboration accepted again", () => {
  it("is left alone by a revocation written before it", async () => {
    mockDb.collaborator.findFirst.mockResolvedValue({ id: "c-2" });

    await (await revocation()).revokeCollaboratorAccess(ref, "u-1");

    expect(mockDb.collaborator.findFirst).toHaveBeenCalledWith({
      where: {
        webinarPlanId: "plan-1",
        status: "ACCEPTED",
        consultantProfile: { userId: "u-1", deletedAt: null },
      },
      select: { id: true },
    });
    expect(mockChatRemove).not.toHaveBeenCalled();
    expect(mockDb.appointmentParticipant.updateMany).not.toHaveBeenCalled();
    expect(intent?.status).toBe("SUCCEEDED");
  });
});

describe("the drive", () => {
  it("keeps a paid learner seat in that event's chat and its room without publish, removes the rest, and writes no participant row", async () => {
    mockDb.appointmentOccurrence.findMany.mockResolvedValue([
      { appointmentId: "a-1", meeting: { streamCallId: "occurrence-1" } },
      { appointmentId: "a-2", meeting: { streamCallId: "occurrence-2" } },
    ]);
    mockDb.appointmentParticipant.findMany.mockResolvedValue([
      { appointmentId: "a-2" },
    ]);

    await (await revocation()).revokeCollaboratorAccess(ref, "u-1");

    expect(mockDb.appointmentParticipant.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: "u-1",
        role: "CONSULTEE",
        OR: expect.any(Array),
        appointmentId: { in: ["a-1", "a-2"] },
      }),
      select: { appointmentId: true },
    });
    expect(mockChatRemove).toHaveBeenCalledWith("collab-webinar-plan-1", [
      "u-1",
    ]);
    expect(mockEventRemove.mock.calls).toEqual([["webinar", "w-1", ["u-1"]]]);
    expect(mockCallUpdate.mock.calls).toEqual([
      ["occurrence-1", { remove_members: ["u-1"] }],
      [
        "occurrence-2",
        { update_members: [{ user_id: "u-1", role: "call_member" }] },
      ],
    ]);
    const mute = {
      user_id: "u-1",
      revoke_permissions: ["send-audio", "send-video", "screenshare"],
    };
    expect(mockCallMute.mock.calls).toEqual([
      ["occurrence-1", mute],
      ["occurrence-2", mute],
    ]);
    expect(mockDb.appointmentParticipant.updateMany).not.toHaveBeenCalled();
  });
});

describe("the grant fence", () => {
  it("leaves a grant whose collaboration is still accepted", async () => {
    mockDb.collaborator.findFirst.mockResolvedValue({ id: "c-1" });

    await expect(
      (await revocation()).fenceCollaboratorGrant(ref, "u-1"),
    ).resolves.toEqual({
      verified: true,
      lost: false,
    });
    expect(mockDb.streamRevocationRetry.createMany).not.toHaveBeenCalled();
  });

  it("takes the grant back when the collaboration has ended", async () => {
    await expect(
      (await revocation()).fenceCollaboratorGrant(ref, "u-1"),
    ).resolves.toEqual({
      verified: true,
      lost: true,
    });

    expect(mockChatRemove).toHaveBeenCalledWith("collab-webinar-plan-1", [
      "u-1",
    ]);
    expect(intent?.status).toBe("SUCCEEDED");
  });

  it("persists the intent for the sweep, and vouches for nothing, when the row cannot be read", async () => {
    mockDb.collaborator.findFirst.mockRejectedValueOnce(
      new Error("db timeout"),
    );

    await expect(
      (await revocation()).fenceCollaboratorGrant(ref, "u-1"),
    ).resolves.toEqual({
      verified: false,
    });

    expect(mockDb.streamRevocationRetry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining(collabIntent)],
      }),
    );
    expect(mockChatRemove).not.toHaveBeenCalled();
    expect(intent?.status).toBe("PENDING");
    expect(mockReport).toHaveBeenCalledTimes(1);
  });
});

describe("retry policy", () => {
  it("never gives up on a collaborator revocation", () => {
    expect(isUncappedRevocationKind("COLLAB_REVOKE")).toBe(true);
  });
});

/**
 * @jest-environment node
 */

// A creator that writes a roster into Stream re-checks every collaborator in
// it once the write is over, however the write ended, and takes back the
// access of anyone whose collaboration ended while it ran.

const mockChannel = {
  create: jest.fn(),
  query: jest.fn(),
  addMembers: jest.fn(),
  removeMembers: jest.fn(),
  assignRoles: jest.fn(),
};
const mockDrive = jest.fn();
/** The users whose collaboration ended after the roster was read. */
let removedSinceRead: string[] = [];

const collaboratorRow = (userId: string) => ({
  role: "CO_HOST",
  consultantProfile: { userId, user: { id: userId } },
});
const plan = {
  id: "plan-1",
  title: "Intro",
  organizationId: null,
  consultantProfile: { user: { id: "u-host" } },
  collaborators: [collaboratorRow("u-kept"), collaboratorRow("u-removed")],
};
const mockDb = {
  webinar: {
    findUnique: jest.fn(async () => ({
      status: "SCHEDULED",
      webinarPlan: plan,
      appointment: null,
    })),
  },
  class: {
    findUnique: jest.fn(async () => ({
      status: "SCHEDULED",
      classPlan: plan,
      appointment: null,
    })),
  },
  webinarPlan: { findUnique: jest.fn(async () => plan) },
  collaborator: {
    findFirst: jest.fn(async (args: unknown) => {
      const { where } = args as {
        where: { consultantProfile: { userId: string } };
      };
      return removedSinceRead.includes(where.consultantProfile.userId)
        ? null
        : { id: "c-1" };
    }),
  },
  streamRevocationRetry: {
    updateMany: jest.fn(async () => ({ count: 0 })),
    createMany: jest.fn(async () => ({ count: 1 })),
  },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockDb;
  },
}));
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: () => ({ channel: () => mockChannel }),
  isStreamConfigured: () => true,
  isExpectedStreamError: () => false,
}));
jest.mock("../../lib/stream/collaborator-access", () => ({
  driveCollaboratorRevocation: (...args: unknown[]) => mockDrive(...args),
}));
jest.mock("../../lib/stream/event-channel-service", () => ({}));
jest.mock("../../lib/stream/dm-eligibility", () => ({}));
jest.mock("../../lib/stream/conduct-call-block", () => ({}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock("../../lib/stream-cache", () => ({ markChannelExists: jest.fn() }));
jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUsersToStream: jest.fn(async () => ({ users: {}, droppedIds: [] })),
}));

import {
  createClassChannel,
  createCollaboratorChannel,
  createWebinarChannel,
} from "../../actions/stream/chat/channel.action";

/** The users whose team place the creator re-read after its write. */
const reChecked = () =>
  Array.from(
    new Set(
      mockDb.collaborator.findFirst.mock.calls.map(
        ([args]) =>
          (args as { where: { consultantProfile: { userId: string } } }).where
            .consultantProfile.userId,
      ),
    ),
  );

beforeEach(() => {
  jest.clearAllMocks();
  removedSinceRead = [];
  mockChannel.create.mockResolvedValue({});
  mockChannel.query.mockResolvedValue({ members: [] });
  mockChannel.addMembers.mockResolvedValue({});
  mockChannel.removeMembers.mockResolvedValue({});
  mockChannel.assignRoles.mockResolvedValue({});
  mockDrive.mockResolvedValue(null);
});

describe("roster creators re-check the collaborators they may have added", () => {
  it("takes a collaborator removed during a webinar chat's creation back out", async () => {
    mockChannel.create.mockImplementation(async () => {
      removedSinceRead = ["u-removed"];
      return {};
    });

    await createWebinarChannel("w-1");

    expect(reChecked().sort()).toEqual(["u-kept", "u-removed"]);
    expect(mockDrive.mock.calls).toEqual([
      [
        { planType: "webinar", planId: "plan-1" },
        "u-removed",
        expect.any(Number),
      ],
    ]);
  });

  it("re-checks a class chat's collaborators when the creation fails", async () => {
    mockChannel.create.mockImplementation(async () => {
      removedSinceRead = ["u-removed"];
      throw new Error("stream timed out");
    });

    await expect(createClassChannel("cl-1")).rejects.toThrow(
      "stream timed out",
    );

    expect(reChecked().sort()).toEqual(["u-kept", "u-removed"]);
    expect(mockDrive.mock.calls).toEqual([
      [
        { planType: "class", planId: "plan-1" },
        "u-removed",
        expect.any(Number),
      ],
    ]);
  });

  it("re-checks every member of the team chat's roster when the membership query fails after the grant", async () => {
    mockChannel.query.mockImplementation(async () => {
      removedSinceRead = ["u-removed"];
      throw new Error("query failed");
    });

    await expect(
      createCollaboratorChannel("webinar", "plan-1"),
    ).rejects.toThrow("query failed");

    expect(reChecked().sort()).toEqual(["u-kept", "u-removed"]);
    expect(mockDrive.mock.calls).toEqual([
      [
        { planType: "webinar", planId: "plan-1" },
        "u-removed",
        expect.any(Number),
      ],
    ]);
  });
});

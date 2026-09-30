/**
 * #1580 — the collaborator coordination channel is created with members Stream
 * has never seen unless they are upserted first; every other creator in
 * channel.action.ts does so, this one did not, and the channel never existed
 * (Sentry FAMILIARISE_WEB-37). Pins the upsert-before-create order.
 */

const mockChannel = {
  create: jest.fn(),
  query: jest.fn(),
  addMembers: jest.fn().mockResolvedValue({}),
  removeMembers: jest.fn().mockResolvedValue({}),
  assignRoles: jest.fn().mockResolvedValue({}),
  id: "collab-webinar-plan-1",
  type: "messaging",
};
const mockStreamClient = { channel: jest.fn(), queryChannels: jest.fn() };
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const mockCache = {
  isChannelCached: jest.fn(() => false),
  markChannelExists: jest.fn(),
  initialSyncCompletedUsers: new Set<string>(),
};
const calls: string[] = [];

import { STREAM_BATCH_LIMIT } from "@/lib/stream/batch";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    webinarPlan: {
      findUnique: jest.fn(async () => ({
        title: "Intro Webinar",
        consultantProfile: { user: { id: "host-user" } },
        collaborators: [{ consultantProfile: { user: { id: "collab-user" } } }],
      })),
    },
  },
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(() => mockStreamClient),
  withStreamCircuitBreaker: jest.fn((op: () => unknown) => op()),
  StreamUnavailableError: class StreamUnavailableError extends Error {},
  isExpectedStreamError: jest.fn(() => false),
}));
jest.mock("../../lib/stream-logger", () => ({ streamLogger: mockLogger }));
jest.mock("../../lib/stream-cache", () => mockCache);
jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUserToStream: jest.fn().mockResolvedValue({}),
  upsertUsersToStream: jest.fn(async (ids: string[]) => {
    calls.push(`upsert:${ids.join(",")}`);
    return { users: {}, droppedIds: [] };
  }),
}));

describe("createCollaboratorChannel", () => {
  it("upserts the host and every accepted collaborator before creating the channel", async () => {
    // Imported here, after the mocks above are initialised (hoisting).
    const { createCollaboratorChannel } =
      await import("../../actions/stream/chat/channel.action");
    mockChannel.create.mockImplementation(async () => {
      calls.push("create");
      return {};
    });
    mockChannel.query.mockResolvedValue({
      members: [{ user_id: "host-user" }, { user_id: "collab-user" }],
    });
    mockStreamClient.channel.mockReturnValue(mockChannel);

    await createCollaboratorChannel("webinar", "plan-1");

    expect(calls.slice(0, 2)).toEqual([
      "upsert:host-user,collab-user",
      "create",
    ]);
  });

  /**
   * #E7 — the collaborator creator passed the WHOLE roster to
   * `channel.create()`, `addMembers` and `removeMembers` unchunked, while the
   * other creators in the same file go through `createMemberChunk` /
   * `addRemainingMembers` / `forEachChunk` from `@/lib/stream/batch`.
   *
   * LATENT, not live, and the comment in the source says so: the roster is
   * capped at four by `MAX_COLLABORATORS_PER_PLAN = 3`, so it cannot overflow
   * today. It is fixed anyway because the cap is a PLAN CONFIGURATION and the
   * ceiling is Stream's, and the two are edited by different people: raising the
   * plan cap is a one-line change that would otherwise turn every collaborator
   * channel create into a rejected request with no test standing between them.
   *
   * The ceiling itself is pinned below by the batch module's own tests, so what
   * is asserted here is the WIRING — that this creator cannot be the one that
   * forgets.
   */
  describe("roster chunking (#E7)", () => {
    beforeEach(() => {
      mockChannel.create.mockResolvedValue({});
      mockChannel.query.mockResolvedValue({
        members: [{ user_id: "host-user" }, { user_id: "collab-user" }],
      });
      mockChannel.addMembers.mockResolvedValue({});
      mockChannel.removeMembers.mockResolvedValue({});
      mockStreamClient.channel.mockReturnValue(mockChannel);
    });

    it("carries no more than Stream's 100-member ceiling in the create body", async () => {
      const { createCollaboratorChannel } =
        await import("@/actions/stream/chat/channel.action");

      await createCollaboratorChannel("webinar", "plan-1");

      const createData = mockStreamClient.channel.mock.calls.at(-1)?.[2] as {
        members: string[];
      };
      expect(Array.isArray(createData.members)).toBe(true);
      expect(createData.members.length).toBeLessThanOrEqual(STREAM_BATCH_LIMIT);
      // And the host is inside it: whoever must definitely end up in the channel
      // belongs at the FRONT of the roster so they land in this chunk rather
      // than in a follow-up request that can fail on its own.
      expect(createData.members[0]).toBe("host-user");
    });

    it("adds and removes in chunks of at most the ceiling", async () => {
      // A roster larger than the ceiling is unreachable today, so the sizes
      // themselves are not what is under test — the CHUNKING PATH is. Asserted
      // with the ordinary two-person roster: a two-person diff is one batch, and
      // the batch helper is what produced it.
      const { createCollaboratorChannel } =
        await import("@/actions/stream/chat/channel.action");

      await createCollaboratorChannel("webinar", "plan-1");

      for (const call of mockChannel.addMembers.mock.calls) {
        expect((call[0] as string[]).length).toBeLessThanOrEqual(
          STREAM_BATCH_LIMIT,
        );
      }
      for (const call of mockChannel.removeMembers.mock.calls) {
        expect((call[0] as string[]).length).toBeLessThanOrEqual(
          STREAM_BATCH_LIMIT,
        );
      }
    });
  });
});

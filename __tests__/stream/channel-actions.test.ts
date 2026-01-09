/**
 * Tests for Stream Chat channel actions
 * Tests channel creation and management for v9 SDK compatibility
 */

import {
  createMockPrisma,
  createMockChannelClient,
  createMockChannel,
  createMockLogger,
  createMockChannelCache,
} from "./__mocks__/stream-mocks";

// Create mock instances
const mockPrisma = createMockPrisma();
const mockStreamClient = createMockChannelClient();
const mockChannel = createMockChannel();
const mockLogger = createMockLogger();
const mockCache = createMockChannelCache();

// Mock dependencies using relative paths
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(() => mockStreamClient),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: mockLogger,
}));

jest.mock("../../lib/stream-cache", () => mockCache);

jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUserToStream: jest.fn().mockResolvedValue({}),
  upsertUsersToStream: jest.fn().mockResolvedValue({ users: {} }),
}));

describe("Channel Actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStreamClient.channel.mockReturnValue(mockChannel);
    mockStreamClient.queryChannels.mockResolvedValue([]);
  });

  describe("createChannel", () => {
    it("should create a channel with valid input", async () => {
      const { createChannel } = await import(
        "../../actions/stream/chat/channel.action"
      );

      mockChannel.query.mockResolvedValueOnce({
        members: { user1: {}, user2: {} },
      });

      const result = await createChannel({
        channelType: "messaging",
        channelId: "test-channel-123",
        channelName: "Test Channel",
        members: ["user1", "user2"],
        createdById: "user1",
      });

      expect(result.channelId).toBe("test-channel-123");
      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "test-channel-123",
        expect.objectContaining({
          name: "Test Channel",
          created_by_id: "user1",
          members: expect.arrayContaining(["user1", "user2"]),
        })
      );
      expect(mockChannel.create).toHaveBeenCalled();
    });

    it("should deduplicate members list", async () => {
      const { createChannel } = await import(
        "../../actions/stream/chat/channel.action"
      );

      mockChannel.query.mockResolvedValueOnce({ members: { user1: {} } });

      await createChannel({
        channelType: "team",
        channelId: "dedup-test",
        members: ["user1", "user1", "user1"],
        createdById: "user1",
      });

      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "team",
        "dedup-test",
        expect.objectContaining({
          members: ["user1"],
        })
      );
    });

    it("should ensure creator is always in members list", async () => {
      const { createChannel } = await import(
        "../../actions/stream/chat/channel.action"
      );

      mockChannel.query.mockResolvedValueOnce({
        members: { creator: {}, other: {} },
      });

      await createChannel({
        channelType: "messaging",
        channelId: "creator-test",
        members: ["other"],
        createdById: "creator",
      });

      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "creator-test",
        expect.objectContaining({
          members: expect.arrayContaining(["creator", "other"]),
        })
      );
    });

    it("should reject invalid channel type", async () => {
      const { createChannel } = await import(
        "../../actions/stream/chat/channel.action"
      );

      await expect(
        createChannel({
          channelType: "invalid" as "messaging" | "team",
          channelId: "test",
          members: ["user1"],
          createdById: "user1",
        })
      ).rejects.toThrow();
    });

    it("should reject empty channel ID", async () => {
      const { createChannel } = await import(
        "../../actions/stream/chat/channel.action"
      );

      await expect(
        createChannel({
          channelType: "messaging",
          channelId: "",
          members: ["user1"],
          createdById: "user1",
        })
      ).rejects.toThrow();
    });

    it("should reject empty members array", async () => {
      const { createChannel } = await import(
        "../../actions/stream/chat/channel.action"
      );

      await expect(
        createChannel({
          channelType: "messaging",
          channelId: "test",
          members: [],
          createdById: "user1",
        })
      ).rejects.toThrow();
    });
  });

  describe("createDirectMessageChannel", () => {
    it("should create DM channel with sorted user IDs", async () => {
      const { createDirectMessageChannel } = await import(
        "../../actions/stream/chat/channel.action"
      );

      mockChannel.query.mockResolvedValueOnce({
        members: { alice: {}, bob: {} },
      });

      const result = await createDirectMessageChannel("bob", "alice");

      expect(result.channelId).toBe("alice-bob");
      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "alice-bob",
        expect.anything()
      );
    });

    it("should create consistent channel ID regardless of user order", async () => {
      const { createDirectMessageChannel } = await import(
        "../../actions/stream/chat/channel.action"
      );

      mockChannel.query.mockResolvedValue({ members: {} });

      const result1 = await createDirectMessageChannel("user-z", "user-a");

      mockStreamClient.channel.mockClear();
      const result2 = await createDirectMessageChannel("user-a", "user-z");

      expect(result1.channelId).toBe(result2.channelId);
    });

    it("should reject empty user IDs", async () => {
      const { createDirectMessageChannel } = await import(
        "../../actions/stream/chat/channel.action"
      );

      await expect(createDirectMessageChannel("", "user2")).rejects.toThrow();
      await expect(createDirectMessageChannel("user1", "")).rejects.toThrow();
    });
  });

  describe("addMemberToChannel", () => {
    it("should add member to existing channel", async () => {
      const { addMemberToChannel } = await import(
        "../../actions/stream/chat/channel.action"
      );

      const result = await addMemberToChannel(
        "consultation-123",
        "new-user-id"
      );

      expect(result.success).toBe(true);
      expect(mockChannel.addMembers).toHaveBeenCalledWith(["new-user-id"]);
    });

    it("should infer messaging type for consultation channels", async () => {
      const { addMemberToChannel } = await import(
        "../../actions/stream/chat/channel.action"
      );

      await addMemberToChannel("consultation-abc", "user123");

      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "consultation-abc"
      );
    });

    it("should infer messaging type for subscription channels", async () => {
      const { addMemberToChannel } = await import(
        "../../actions/stream/chat/channel.action"
      );

      await addMemberToChannel("subscription-xyz", "user456");

      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "subscription-xyz"
      );
    });

    it("should infer team type for other channels", async () => {
      const { addMemberToChannel } = await import(
        "../../actions/stream/chat/channel.action"
      );

      await addMemberToChannel("webinar-123", "user789");

      expect(mockStreamClient.channel).toHaveBeenCalledWith("team", "webinar-123");
    });

    it("should reject invalid inputs", async () => {
      const { addMemberToChannel } = await import(
        "../../actions/stream/chat/channel.action"
      );

      await expect(addMemberToChannel("", "user")).rejects.toThrow();
      await expect(addMemberToChannel("channel", "")).rejects.toThrow();
    });
  });
});

describe("Event Channel Actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStreamClient.channel.mockReturnValue(mockChannel);
    mockStreamClient.queryChannels.mockResolvedValue([mockChannel]);
  });

  describe("getChannelId", () => {
    it("should generate correct channel IDs for each event type", async () => {
      mockCache.isChannelCached.mockReturnValue(undefined);
      mockCache.getMembershipCached.mockReturnValue(true);

      const { addUserToEventChannel } = await import(
        "../../actions/stream/chat/event-channel.action"
      );

      const result = await addUserToEventChannel("webinar", "123", "user-id");

      expect(result.channelId).toBe("webinar-123");
    });
  });

  describe("getChannelType", () => {
    it("should return messaging for consultation and subscription", async () => {
      mockCache.getMembershipCached.mockReturnValue(true);

      const { addUserToEventChannel } = await import(
        "../../actions/stream/chat/event-channel.action"
      );

      await addUserToEventChannel("consultation", "abc", "user");
      expect(mockStreamClient.channel).not.toHaveBeenCalled();

      await addUserToEventChannel("subscription", "xyz", "user");
      expect(mockStreamClient.channel).not.toHaveBeenCalled();
    });
  });

  describe("getUserEventChannels", () => {
    it("should query and return user channels", async () => {
      mockStreamClient.queryChannels.mockResolvedValueOnce([
        {
          id: "webinar-123",
          type: "team",
          data: { name: "Test Webinar" },
          state: { members: { user1: {}, user2: {} } },
        },
        {
          id: "consultation-456",
          type: "messaging",
          data: { name: "Test Consultation" },
          state: { members: { user1: {}, consultant: {} } },
        },
      ]);

      const { getUserEventChannels } = await import(
        "../../actions/stream/chat/event-channel.action"
      );

      const channels = await getUserEventChannels("user1");

      expect(mockStreamClient.queryChannels).toHaveBeenCalledWith(
        { members: { $in: ["user1"] } },
        { last_message_at: -1 },
        { limit: 100 }
      );

      expect(channels).toHaveLength(2);
      expect(channels[0].id).toBe("webinar-123");
      expect(channels[0].type).toBe("team");
      expect(channels[0].memberCount).toBe(2);
    });

    it("should reject empty user ID", async () => {
      const { getUserEventChannels } = await import(
        "../../actions/stream/chat/event-channel.action"
      );

      await expect(getUserEventChannels("")).rejects.toThrow();
    });
  });
});

/**
 * Tests for Stream Chat event channel actions
 * Tests channel creation, user syncing, and event-based channel management
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

// Mock dependencies
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
}));

describe("Event Channel Actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStreamClient.channel.mockReturnValue(mockChannel);
    mockStreamClient.queryChannels.mockResolvedValue([]);
    mockCache.initialSyncCompletedUsers.clear();
  });

  describe("checkEventChannelExists", () => {
    it("should return cached value when channel is cached as true", async () => {
      mockCache.isChannelCached.mockReturnValue(true);

      const { checkEventChannelExists } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await checkEventChannelExists("webinar", "webinar-123");

      expect(result).toBe(true);
      expect(mockStreamClient.channel).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Channel existence from cache",
        expect.objectContaining({ exists: true }),
      );
    });

    it("should return cached value when channel is cached as false", async () => {
      mockCache.isChannelCached.mockReturnValue(false);

      const { checkEventChannelExists } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await checkEventChannelExists("class", "class-456");

      expect(result).toBe(false);
      expect(mockStreamClient.channel).not.toHaveBeenCalled();
    });

    it("should query API and cache result on cache miss", async () => {
      mockCache.isChannelCached.mockReturnValue(undefined);
      mockChannel.query.mockResolvedValue({ state: {} });

      const { checkEventChannelExists } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await checkEventChannelExists("consultation", "cons-789");

      expect(result).toBe(true);
      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "consultation-cons-789",
      );
      expect(mockChannel.query).toHaveBeenCalled();
      expect(mockCache.markChannelExists).toHaveBeenCalled();
    });

    it("should return false when channel query fails", async () => {
      mockCache.isChannelCached.mockReturnValue(undefined);
      mockChannel.query.mockRejectedValue(new Error("Channel not found"));

      const { checkEventChannelExists } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await checkEventChannelExists("subscription", "sub-abc");

      expect(result).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Channel does not exist",
        expect.any(Object),
      );
    });

    it("should return team type for webinar", async () => {
      mockCache.isChannelCached.mockReturnValue(undefined);
      mockChannel.query.mockResolvedValue({});

      const { checkEventChannelExists } =
        await import("../../actions/stream/chat/event-channel.action");

      await checkEventChannelExists("webinar", "web-123");

      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "team",
        "webinar-web-123",
      );
    });

    it("should return team type for class", async () => {
      mockCache.isChannelCached.mockReturnValue(undefined);
      mockChannel.query.mockResolvedValue({});

      const { checkEventChannelExists } =
        await import("../../actions/stream/chat/event-channel.action");

      await checkEventChannelExists("class", "cls-123");

      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "team",
        "class-cls-123",
      );
    });

    it("should throw on invalid event type", async () => {
      const { checkEventChannelExists } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(
        checkEventChannelExists("invalid" as any, "id-123"),
      ).rejects.toThrow();
    });

    it("should throw on empty event ID", async () => {
      const { checkEventChannelExists } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(checkEventChannelExists("webinar", "")).rejects.toThrow();
    });
  });

  describe("addUserToEventChannel", () => {
    it("should return early when user membership is cached", async () => {
      mockCache.getMembershipCached.mockReturnValue(true);

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await addUserToEventChannel(
        "webinar",
        "web-123",
        "user-456",
      );

      expect(result.success).toBe(true);
      expect(result.channelId).toBe("webinar-web-123");
      expect(mockStreamClient.channel).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "User already member (cached)",
        expect.any(Object),
      );
    });

    it("should add user to existing channel", async () => {
      mockCache.getMembershipCached.mockReturnValue(false);
      mockChannel.addMembers.mockResolvedValue({});

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await addUserToEventChannel(
        "consultation",
        "cons-123",
        "user-789",
      );

      expect(result.success).toBe(true);
      expect(result.channelId).toBe("consultation-cons-123");
      expect(mockChannel.addMembers).toHaveBeenCalledWith(["user-789"]);
      expect(mockCache.markMembership).toHaveBeenCalled();
    });

    it("should create new channel when addMembers fails and event exists", async () => {
      mockCache.getMembershipCached.mockReturnValue(false);
      mockChannel.addMembers.mockRejectedValue(new Error("Channel not found"));
      mockChannel.create.mockResolvedValue({});

      // Mock webinar data
      mockPrisma.webinar.findUnique.mockResolvedValue({
        id: "web-123",
        webinarPlan: {
          title: "Test Webinar",
          consultantProfile: {
            user: { id: "consultant-1" },
          },
        },
        waitlist: [{ userId: "user-1" }, { userId: "user-2" }],
        appointment: {
          slotsOfAppointment: [{ user: [{ id: "user-3" }] }],
        },
      });

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await addUserToEventChannel(
        "webinar",
        "web-123",
        "new-user",
      );

      expect(result.success).toBe(true);
      expect(result.created).toBe(true);
      expect(mockChannel.create).toHaveBeenCalled();
      expect(mockCache.markChannelExists).toHaveBeenCalled();
    });

    it("should throw error when event not found", async () => {
      mockCache.getMembershipCached.mockReturnValue(false);
      mockChannel.addMembers.mockRejectedValue(new Error("Channel not found"));
      mockPrisma.webinar.findUnique.mockResolvedValue(null);

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(
        addUserToEventChannel("webinar", "nonexistent", "user-123"),
      ).rejects.toThrow("webinar not found: nonexistent");
    });

    it("should throw on empty user ID", async () => {
      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(
        addUserToEventChannel("webinar", "web-123", ""),
      ).rejects.toThrow();
    });

    it("should use messaging type for consultation", async () => {
      mockCache.getMembershipCached.mockReturnValue(false);
      mockChannel.addMembers.mockResolvedValue({});

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      await addUserToEventChannel("consultation", "cons-123", "user-123");

      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "consultation-cons-123",
      );
    });

    it("should use messaging type for subscription", async () => {
      mockCache.getMembershipCached.mockReturnValue(false);
      mockChannel.addMembers.mockResolvedValue({});

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      await addUserToEventChannel("subscription", "sub-123", "user-123");

      expect(mockStreamClient.channel).toHaveBeenCalledWith(
        "messaging",
        "subscription-sub-123",
      );
    });
  });

  describe("getEventData via addUserToEventChannel", () => {
    beforeEach(() => {
      mockCache.getMembershipCached.mockReturnValue(false);
      mockChannel.addMembers.mockRejectedValue(new Error("Channel not found"));
      mockChannel.create.mockResolvedValue({});
    });

    it("should fetch class data with consultant and members", async () => {
      mockPrisma.class.findUnique.mockResolvedValue({
        id: "class-123",
        classPlan: {
          title: "Test Class",
          consultantProfile: {
            user: { id: "consultant-1" },
          },
        },
        waitlist: [{ userId: "user-1" }],
        appointments: [
          {
            slotsOfAppointment: [
              { user: [{ id: "user-2" }, { id: "user-3" }] },
            ],
          },
        ],
      });

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await addUserToEventChannel(
        "class",
        "class-123",
        "new-user",
      );

      expect(result.success).toBe(true);
      expect(mockPrisma.class.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "class-123" },
        }),
      );
    });

    it("should return null for class without consultant", async () => {
      mockPrisma.class.findUnique.mockResolvedValue({
        id: "class-123",
        classPlan: {
          title: "Test Class",
          consultantProfile: null,
        },
        waitlist: [],
        appointments: [],
      });

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(
        addUserToEventChannel("class", "class-123", "user-123"),
      ).rejects.toThrow("class not found");
    });

    it("should fetch consultation data", async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue({
        id: "cons-123",
        consultationPlan: {
          title: "Test Consultation",
          consultantProfile: {
            user: { id: "consultant-1" },
          },
        },
        requestedBy: {
          user: { id: "consultee-1" },
        },
      });

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await addUserToEventChannel(
        "consultation",
        "cons-123",
        "new-user",
      );

      expect(result.success).toBe(true);
      expect(mockPrisma.consultation.findUnique).toHaveBeenCalled();
    });

    it("should return null for consultation without consultee", async () => {
      mockPrisma.consultation.findUnique.mockResolvedValue({
        id: "cons-123",
        consultationPlan: {
          title: "Test Consultation",
          consultantProfile: {
            user: { id: "consultant-1" },
          },
        },
        requestedBy: null,
      });

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(
        addUserToEventChannel("consultation", "cons-123", "user-123"),
      ).rejects.toThrow("consultation not found");
    });

    it("should fetch subscription data", async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue({
        id: "sub-123",
        subscriptionPlan: {
          title: "Test Subscription",
          consultantProfile: {
            user: { id: "consultant-1" },
          },
        },
        requestedBy: {
          user: { id: "subscriber-1" },
        },
      });

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await addUserToEventChannel(
        "subscription",
        "sub-123",
        "new-user",
      );

      expect(result.success).toBe(true);
      expect(mockPrisma.subscription.findUnique).toHaveBeenCalled();
    });
  });

  describe("getUserEventChannels", () => {
    it("should query and return user channels", async () => {
      mockStreamClient.queryChannels.mockResolvedValue([
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

      const { getUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      const channels = await getUserEventChannels("user1");

      expect(mockStreamClient.queryChannels).toHaveBeenCalledWith(
        { members: { $in: ["user1"] } },
        { last_message_at: -1 },
        { limit: 100 },
      );
      expect(channels).toHaveLength(2);
      expect(channels[0].id).toBe("webinar-123");
      expect(channels[0].type).toBe("team");
      expect(channels[0].memberCount).toBe(2);
    });

    it("should return empty array when user has no channels", async () => {
      mockStreamClient.queryChannels.mockResolvedValue([]);

      const { getUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      const channels = await getUserEventChannels("user-no-channels");

      expect(channels).toHaveLength(0);
    });

    it("should handle channel with undefined name", async () => {
      mockStreamClient.queryChannels.mockResolvedValue([
        {
          id: "test-channel",
          type: "team",
          data: {},
          state: { members: { user1: {} } },
        },
      ]);

      const { getUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      const channels = await getUserEventChannels("user1");

      expect(channels[0].name).toBeUndefined();
    });

    it("should throw on empty user ID", async () => {
      const { getUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(getUserEventChannels("")).rejects.toThrow();
    });

    it("should throw and log error when query fails", async () => {
      mockStreamClient.queryChannels.mockRejectedValue(new Error("API error"));

      const { getUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(getUserEventChannels("user1")).rejects.toThrow("API error");
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Failed to get user event channels",
        expect.any(Error),
        expect.any(Object),
      );
    });
  });

  describe("syncUserEventChannels", () => {
    it("should skip when user already synced", async () => {
      mockCache.initialSyncCompletedUsers.add("user-already-synced");

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await syncUserEventChannels("user-already-synced");

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it("should return error when user not found", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await syncUserEventChannels("nonexistent-user");

      expect(result.success).toBe(false);
      expect(result.error).toBe("User not found");
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "User not found for sync",
        expect.any(Object),
      );
    });

    it("should return success with 0 channels when user has no events", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: null,
        consulteeProfileId: "consultee-123",
      });
      mockPrisma.webinar.findMany.mockResolvedValue([]);
      mockPrisma.class.findMany.mockResolvedValue([]);
      mockPrisma.consultation.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await syncUserEventChannels("user-no-events");

      expect(result.success).toBe(true);
      expect(result.channelsSynced).toBe(0);
      expect(mockCache.initialSyncCompletedUsers.has("user-no-events")).toBe(
        true,
      );
    });

    it("should sync user to all their event channels", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: "consultant-123",
        consulteeProfileId: null,
      });

      // Mock consultant webinars
      mockPrisma.webinar.findMany.mockResolvedValue([
        { id: "webinar-1" },
        { id: "webinar-2" },
      ]);

      // Mock consultant classes
      mockPrisma.class.findMany.mockResolvedValue([{ id: "class-1" }]);

      // Mock consultations
      mockPrisma.consultation.findMany.mockResolvedValue([{ id: "cons-1" }]);

      // Mock subscriptions
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      // Mock successful channel operations
      mockCache.getMembershipCached.mockReturnValue(false);
      mockChannel.addMembers.mockResolvedValue({});

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await syncUserEventChannels("consultant-user");

      expect(result.success).toBe(true);
      expect(result.channelsSynced).toBe(4); // 2 webinars + 1 class + 1 consultation
      expect(result.durationMs).toBeDefined();
      expect(mockCache.initialSyncCompletedUsers.has("consultant-user")).toBe(
        true,
      );
    });

    it("should handle partial failures gracefully", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: null,
        consulteeProfileId: "consultee-123",
      });

      mockPrisma.webinar.findMany.mockResolvedValue([]);
      mockPrisma.class.findMany.mockResolvedValue([]);
      mockPrisma.consultation.findMany.mockResolvedValue([
        { id: "cons-1" },
        { id: "cons-2" },
      ]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      // First call succeeds, second fails
      mockCache.getMembershipCached.mockReturnValue(false);
      mockChannel.addMembers
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("Failed"));

      // Second call needs event data for channel creation
      mockPrisma.consultation.findUnique.mockResolvedValue(null);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await syncUserEventChannels("user-with-failures");

      expect(result.success).toBe(true);
      expect(result.channelsSynced).toBe(1);
      expect(result.failed).toBe(1);
    });

    it("should throw on invalid user ID", async () => {
      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(syncUserEventChannels("")).rejects.toThrow();
    });
  });

  describe("getWebinarIdsForUser", () => {
    it("should return hosted webinars for consultant", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: "consultant-123",
        consulteeProfileId: null,
      });
      mockPrisma.webinar.findMany.mockResolvedValue([
        { id: "webinar-1" },
        { id: "webinar-2" },
      ]);
      mockPrisma.class.findMany.mockResolvedValue([]);
      mockPrisma.consultation.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      mockCache.getMembershipCached.mockReturnValue(true); // Skip actual sync

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await syncUserEventChannels("consultant-user");

      expect(mockPrisma.webinar.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            webinarPlan: { consultantProfileId: "consultant-123" },
          },
        }),
      );
    });

    it("should return attended webinars for consultee", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: null,
        consulteeProfileId: "consultee-123",
      });
      mockPrisma.webinar.findMany
        .mockResolvedValueOnce([{ id: "waitlist-webinar" }])
        .mockResolvedValueOnce([{ id: "appointment-webinar" }]);
      mockPrisma.class.findMany.mockResolvedValue([]);
      mockPrisma.consultation.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      mockCache.getMembershipCached.mockReturnValue(true);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await syncUserEventChannels("consultee-user");

      // Should have been called twice - once for waitlist, once for appointments
      expect(mockPrisma.webinar.findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe("getClassIdsForUser", () => {
    it("should return hosted classes for consultant", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: "consultant-123",
        consulteeProfileId: null,
      });
      mockPrisma.webinar.findMany.mockResolvedValue([]);
      mockPrisma.class.findMany.mockResolvedValue([
        { id: "class-1" },
        { id: "class-2" },
      ]);
      mockPrisma.consultation.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      mockCache.getMembershipCached.mockReturnValue(true);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await syncUserEventChannels("consultant-user");

      expect(mockPrisma.class.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            classPlan: { consultantProfileId: "consultant-123" },
          },
        }),
      );
    });
  });

  describe("getConsultationIdsForUser", () => {
    it("should return consultations for user with both profiles", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: "consultant-123",
        consulteeProfileId: "consultee-123",
      });
      mockPrisma.webinar.findMany.mockResolvedValue([]);
      mockPrisma.class.findMany.mockResolvedValue([]);
      mockPrisma.consultation.findMany.mockResolvedValue([
        { id: "cons-1" },
        { id: "cons-2" },
      ]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      mockCache.getMembershipCached.mockReturnValue(true);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await syncUserEventChannels("dual-profile-user");

      expect(mockPrisma.consultation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            requestStatus: { in: ["APPROVED", "SCHEDULED"] },
          }),
        }),
      );
    });

    it("should return empty array when user has no profiles", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: null,
        consulteeProfileId: null,
      });
      mockPrisma.webinar.findMany.mockResolvedValue([]);
      mockPrisma.class.findMany.mockResolvedValue([]);
      mockPrisma.consultation.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([]);

      mockCache.getMembershipCached.mockReturnValue(true);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await syncUserEventChannels("no-profile-user");

      expect(result.channelsSynced).toBe(0);
    });
  });

  describe("getSubscriptionIdsForUser", () => {
    it("should return subscriptions filtered by status", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        consultantProfileId: null,
        consulteeProfileId: "consultee-123",
      });
      mockPrisma.webinar.findMany.mockResolvedValue([]);
      mockPrisma.class.findMany.mockResolvedValue([]);
      mockPrisma.consultation.findMany.mockResolvedValue([]);
      mockPrisma.subscription.findMany.mockResolvedValue([
        { id: "sub-1" },
        { id: "sub-2" },
      ]);

      mockCache.getMembershipCached.mockReturnValue(true);

      const { syncUserEventChannels } =
        await import("../../actions/stream/chat/event-channel.action");

      await syncUserEventChannels("subscribed-user");

      expect(mockPrisma.subscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            requestStatus: { in: ["APPROVED", "SCHEDULED"] },
          }),
        }),
      );
    });
  });
});

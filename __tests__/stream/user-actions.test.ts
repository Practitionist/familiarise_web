/**
 * Tests for Stream Chat user actions
 * Tests user upsert and search functionality for v9 SDK compatibility
 */

import {
  createMockPrisma,
  createMockUserClient,
  createMockLogger,
  createMockUserCache,
  createMockRoleMapper,
} from "./__mocks__/stream-mocks";

// Create mock instances
const mockPrisma = createMockPrisma();
const mockStreamClient = createMockUserClient();
const mockLogger = createMockLogger();
const mockUserCache = createMockUserCache();
const mockRoleMapper = createMockRoleMapper();

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

jest.mock("../../lib/stream-cache", () => mockUserCache);

jest.mock("../../lib/user", () => mockRoleMapper);

describe("User Actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStreamClient.upsertUser.mockReset();
    mockStreamClient.upsertUsers.mockReset();
    mockUserCache.isUserSynced.mockReturnValue(false);
  });

  describe("upsertUserToStream", () => {
    it("should upsert a user to Stream Chat", async () => {
      const mockUser = {
        id: "user-123",
        name: "Test User",
        email: "test@example.com",
        image: "https://example.com/avatar.jpg",
        role: "CONSULTANT",
      };

      mockUserCache.isUserSynced.mockReturnValue(false);
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockStreamClient.upsertUser.mockResolvedValue({ users: { [mockUser.id]: mockUser } });

      const { upsertUserToStream } = await import(
        "../../actions/stream/chat/user.action"
      );

      await upsertUserToStream("user-123");

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: "user-123" },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          role: true,
        },
      });

      expect(mockStreamClient.upsertUser).toHaveBeenCalledWith({
        id: "user-123",
        name: "Test User",
        email: "test@example.com",
        image: "https://example.com/avatar.jpg",
        role: "user",
      });

      expect(mockUserCache.markUserSynced).toHaveBeenCalledWith("user-123");
    });

    it("should skip upsert if user is recently synced", async () => {
      mockUserCache.isUserSynced.mockReturnValue(true);

      const { upsertUserToStream } = await import(
        "../../actions/stream/chat/user.action"
      );

      const result = await upsertUserToStream("user-123");

      expect(result).toBeNull();
      expect(mockStreamClient.upsertUser).not.toHaveBeenCalled();
    });

    it("should throw error for non-existent user", async () => {
      mockUserCache.isUserSynced.mockReturnValue(false);
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const { upsertUserToStream } = await import(
        "../../actions/stream/chat/user.action"
      );

      await expect(upsertUserToStream("nonexistent")).rejects.toThrow(
        "User not found: nonexistent"
      );
    });

    it("should use user ID as name fallback", async () => {
      const mockUser = {
        id: "user-456",
        name: null,
        email: "noname@example.com",
        image: null,
        role: "CONSULTEE",
      };

      mockUserCache.isUserSynced.mockReturnValue(false);
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockStreamClient.upsertUser.mockResolvedValue({ users: {} });

      const { upsertUserToStream } = await import(
        "../../actions/stream/chat/user.action"
      );

      await upsertUserToStream("user-456");

      expect(mockStreamClient.upsertUser).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "user-456",
          name: "user-456",
          image: undefined,
        })
      );
    });

    it("should reject empty user ID", async () => {
      const { upsertUserToStream } = await import(
        "../../actions/stream/chat/user.action"
      );

      await expect(upsertUserToStream("")).rejects.toThrow();
    });
  });

  describe("upsertUsersToStream", () => {
    it("should batch upsert multiple users", async () => {
      const mockUsers = [
        { id: "user-1", name: "User 1", email: "u1@test.com", image: null, role: "CONSULTANT" },
        { id: "user-2", name: "User 2", email: "u2@test.com", image: null, role: "CONSULTEE" },
      ];

      mockUserCache.isUserSynced.mockReturnValue(false);
      mockPrisma.user.findMany.mockResolvedValue(mockUsers);
      mockStreamClient.upsertUsers.mockResolvedValue({ users: {} });

      const { upsertUsersToStream } = await import(
        "../../actions/stream/chat/user.action"
      );

      await upsertUsersToStream(["user-1", "user-2"]);

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
        where: { id: { in: ["user-1", "user-2"] } },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          role: true,
        },
      });

      expect(mockStreamClient.upsertUsers).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: "user-1" }),
          expect.objectContaining({ id: "user-2" }),
        ])
      );

      expect(mockUserCache.markUserSynced).toHaveBeenCalledTimes(2);
    });

    it("should skip already synced users", async () => {
      mockUserCache.isUserSynced.mockReturnValue(true);

      const { upsertUsersToStream } = await import(
        "../../actions/stream/chat/user.action"
      );

      const result = await upsertUsersToStream(["user-1", "user-2"]);

      expect(result).toEqual({ users: {} });
      expect(mockStreamClient.upsertUsers).not.toHaveBeenCalled();
    });

    it("should reject empty users array", async () => {
      const { upsertUsersToStream } = await import(
        "../../actions/stream/chat/user.action"
      );

      await expect(upsertUsersToStream([])).rejects.toThrow();
    });
  });

  describe("searchUsers", () => {
    it("should search users by name or email", async () => {
      const mockResults = [
        { id: "user-1", name: "John Doe", email: "john@test.com", image: null, role: "CONSULTANT" },
        { id: "user-2", name: "Jane Doe", email: "jane@test.com", image: null, role: "CONSULTEE" },
      ];

      mockPrisma.user.findMany.mockResolvedValue(mockResults);

      const { searchUsers } = await import(
        "../../actions/stream/chat/user.action"
      );

      const results = await searchUsers("Doe");

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
        where: {
          AND: [
            {
              NOT: [
                { id: { startsWith: "recording-egress-" } },
                { id: { startsWith: "system-" } },
              ],
            },
            {
              OR: [
                { name: { contains: "Doe", mode: "insensitive" } },
                { email: { contains: "Doe", mode: "insensitive" } },
              ],
            },
          ],
        },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          role: true,
        },
        take: 10,
        orderBy: [{ name: "asc" }],
      });

      expect(results).toHaveLength(2);
    });

    it("should exclude system users from search", async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);

      const { searchUsers } = await import(
        "../../actions/stream/chat/user.action"
      );

      await searchUsers("test");

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              {
                NOT: [
                  { id: { startsWith: "recording-egress-" } },
                  { id: { startsWith: "system-" } },
                ],
              },
            ]),
          }),
        })
      );
    });

    it("should reject empty search term", async () => {
      const { searchUsers } = await import(
        "../../actions/stream/chat/user.action"
      );

      await expect(searchUsers("")).rejects.toThrow();
    });

    it("should reject too long search term", async () => {
      const { searchUsers } = await import(
        "../../actions/stream/chat/user.action"
      );

      const longTerm = "a".repeat(101);
      await expect(searchUsers(longTerm)).rejects.toThrow();
    });
  });

  describe("checkUserRelationship", () => {
    it("should return true if users share a consultation", async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({
          consultantProfileId: "consultant-profile-1",
          consulteeProfileId: null,
        })
        .mockResolvedValueOnce({
          consultantProfileId: null,
          consulteeProfileId: "consultee-profile-1",
        });

      mockPrisma.consultation.findFirst.mockResolvedValue({
        id: "consultation-1",
      });

      mockPrisma.subscription.findFirst.mockResolvedValue(null);
      mockPrisma.slotOfAppointment.findFirst.mockResolvedValue(null);

      const { checkUserRelationship } = await import(
        "../../actions/stream/chat/user.action"
      );

      const hasRelationship = await checkUserRelationship(
        "consultant-user",
        "consultee-user"
      );

      expect(hasRelationship).toBe(true);
    });

    it("should return false if no relationship exists", async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({
          consultantProfileId: "consultant-profile-1",
          consulteeProfileId: null,
        })
        .mockResolvedValueOnce({
          consultantProfileId: "consultant-profile-2",
          consulteeProfileId: null,
        });

      mockPrisma.consultation.findFirst.mockResolvedValue(null);
      mockPrisma.subscription.findFirst.mockResolvedValue(null);
      mockPrisma.slotOfAppointment.findFirst.mockResolvedValue(null);

      const { checkUserRelationship } = await import(
        "../../actions/stream/chat/user.action"
      );

      const hasRelationship = await checkUserRelationship(
        "consultant-1",
        "consultant-2"
      );

      expect(hasRelationship).toBe(false);
    });

    it("should return false if user not found", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const { checkUserRelationship } = await import(
        "../../actions/stream/chat/user.action"
      );

      const hasRelationship = await checkUserRelationship(
        "nonexistent-1",
        "nonexistent-2"
      );

      expect(hasRelationship).toBe(false);
    });

    it("should return true if users share appointment slot", async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({
          consultantProfileId: null,
          consulteeProfileId: "consultee-1",
        })
        .mockResolvedValueOnce({
          consultantProfileId: null,
          consulteeProfileId: "consultee-2",
        });

      mockPrisma.consultation.findFirst.mockResolvedValue(null);
      mockPrisma.subscription.findFirst.mockResolvedValue(null);
      mockPrisma.slotOfAppointment.findFirst.mockResolvedValue({
        id: "shared-slot-1",
      });

      const { checkUserRelationship } = await import(
        "../../actions/stream/chat/user.action"
      );

      const hasRelationship = await checkUserRelationship("user-a", "user-b");

      expect(hasRelationship).toBe(true);
    });
  });
});

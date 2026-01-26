/**
 * Tests for Stream Client initialization and token generation
 * Tests the stream-client.ts module for v9 SDK compatibility
 */

// Mock the Stream SDKs before importing
const mockStreamChatGetInstance = jest.fn();
const mockStreamClientConstructor = jest.fn();

jest.mock("stream-chat", () => ({
  StreamChat: {
    getInstance: mockStreamChatGetInstance,
  },
}));

jest.mock("@stream-io/node-sdk", () => ({
  StreamClient: mockStreamClientConstructor,
}));

describe("Stream Client Module", () => {
  const originalEnv = process.env;
  const mockApiKey = "test-api-key";
  const mockApiSecret = "test-api-secret";
  const mockUserId = "test-user-123";

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_STREAM_API_KEY: mockApiKey,
      STREAM_API_SECRET: mockApiSecret,
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  describe("validateStreamConfig", () => {
    it("should not throw when credentials are configured", async () => {
      const { validateStreamConfig } = await import("@/lib/stream-client");
      expect(() => validateStreamConfig()).not.toThrow();
    });

    it("should throw when API key is missing", async () => {
      delete process.env.NEXT_PUBLIC_STREAM_API_KEY;
      jest.resetModules();
      const { validateStreamConfig } = await import("@/lib/stream-client");
      expect(() => validateStreamConfig()).toThrow(
        "NEXT_PUBLIC_STREAM_API_KEY is not configured",
      );
    });

    it("should throw when API secret is missing", async () => {
      delete process.env.STREAM_API_SECRET;
      jest.resetModules();
      const { validateStreamConfig } = await import("@/lib/stream-client");
      expect(() => validateStreamConfig()).toThrow(
        "STREAM_API_SECRET is not configured",
      );
    });
  });

  describe("isStreamConfigured", () => {
    it("should return true when both credentials are set", async () => {
      const { isStreamConfigured } = await import("@/lib/stream-client");
      expect(isStreamConfigured()).toBe(true);
    });

    it("should return false when API key is missing", async () => {
      delete process.env.NEXT_PUBLIC_STREAM_API_KEY;
      jest.resetModules();
      const { isStreamConfigured } = await import("@/lib/stream-client");
      expect(isStreamConfigured()).toBe(false);
    });

    it("should return false when API secret is missing", async () => {
      delete process.env.STREAM_API_SECRET;
      jest.resetModules();
      const { isStreamConfigured } = await import("@/lib/stream-client");
      expect(isStreamConfigured()).toBe(false);
    });
  });

  describe("getStreamChatClient", () => {
    it("should create a singleton StreamChat instance", async () => {
      const mockInstance = {
        createToken: jest.fn().mockReturnValue("mock-token"),
      };
      mockStreamChatGetInstance.mockReturnValue(mockInstance);

      const { getStreamChatClient, resetClients } =
        await import("@/lib/stream-client");

      resetClients();
      const client1 = getStreamChatClient();
      const client2 = getStreamChatClient();

      // Should return same instance
      expect(client1).toBe(client2);

      // getInstance should only be called once for singleton
      expect(mockStreamChatGetInstance).toHaveBeenCalledTimes(1);
      expect(mockStreamChatGetInstance).toHaveBeenCalledWith(
        mockApiKey,
        mockApiSecret,
        { timeout: 30000 },
      );
    });
  });

  describe("getStreamVideoClient", () => {
    it("should create a singleton StreamClient instance", async () => {
      const mockVideoClient = {
        generateUserToken: jest.fn().mockReturnValue("mock-video-token"),
      };
      mockStreamClientConstructor.mockImplementation(() => mockVideoClient);

      const { getStreamVideoClient, resetClients } =
        await import("@/lib/stream-client");

      resetClients();
      const client1 = getStreamVideoClient();
      const client2 = getStreamVideoClient();

      // Should return same instance
      expect(client1).toBe(client2);

      // Constructor should only be called once for singleton
      expect(mockStreamClientConstructor).toHaveBeenCalledTimes(1);
      expect(mockStreamClientConstructor).toHaveBeenCalledWith(
        mockApiKey,
        mockApiSecret,
      );
    });
  });

  describe("generateChatToken", () => {
    it("should generate token without expiration", async () => {
      const mockToken = "chat-token-no-exp";
      const mockInstance = {
        createToken: jest.fn().mockReturnValue(mockToken),
      };
      mockStreamChatGetInstance.mockReturnValue(mockInstance);

      const { generateChatToken, resetClients } =
        await import("@/lib/stream-client");

      resetClients();
      const token = generateChatToken(mockUserId);

      expect(token).toBe(mockToken);
      expect(mockInstance.createToken).toHaveBeenCalledWith(mockUserId);
    });

    it("should generate token with custom expiration", async () => {
      const mockToken = "chat-token-with-exp";
      const expirationSeconds = 7200; // 2 hours
      const mockInstance = {
        createToken: jest.fn().mockReturnValue(mockToken),
      };
      mockStreamChatGetInstance.mockReturnValue(mockInstance);

      const { generateChatToken, resetClients } =
        await import("@/lib/stream-client");

      resetClients();
      const token = generateChatToken(mockUserId, expirationSeconds);

      expect(token).toBe(mockToken);
      expect(mockInstance.createToken).toHaveBeenCalledWith(
        mockUserId,
        expect.any(Number),
      );
    });
  });

  describe("generateVideoToken", () => {
    it("should generate video token with default expiration", async () => {
      const mockToken = "video-token";
      const mockVideoClient = {
        generateUserToken: jest.fn().mockReturnValue(mockToken),
      };
      mockStreamClientConstructor.mockImplementation(() => mockVideoClient);

      const { generateVideoToken, resetClients } =
        await import("@/lib/stream-client");

      resetClients();
      const token = generateVideoToken(mockUserId);

      expect(token).toBe(mockToken);
      expect(mockVideoClient.generateUserToken).toHaveBeenCalledWith({
        user_id: mockUserId,
        exp: expect.any(Number),
        iat: expect.any(Number),
      });
    });

    it("should generate video token with custom expiration", async () => {
      const mockToken = "video-token-custom";
      const customExpiration = 7200;
      const mockVideoClient = {
        generateUserToken: jest.fn().mockReturnValue(mockToken),
      };
      mockStreamClientConstructor.mockImplementation(() => mockVideoClient);

      const { generateVideoToken, resetClients } =
        await import("@/lib/stream-client");

      resetClients();
      const token = generateVideoToken(mockUserId, customExpiration);

      expect(token).toBe(mockToken);
      expect(mockVideoClient.generateUserToken).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: mockUserId,
        }),
      );
    });
  });

  describe("getStreamApiKey", () => {
    it("should return the API key", async () => {
      const { getStreamApiKey } = await import("@/lib/stream-client");
      expect(getStreamApiKey()).toBe(mockApiKey);
    });

    it("should throw when API key is missing", async () => {
      delete process.env.NEXT_PUBLIC_STREAM_API_KEY;
      jest.resetModules();
      const { getStreamApiKey } = await import("@/lib/stream-client");
      expect(() => getStreamApiKey()).toThrow(
        "NEXT_PUBLIC_STREAM_API_KEY is not configured",
      );
    });
  });

  describe("resetClients", () => {
    it("should reset client instances", async () => {
      const mockChatInstance = { createToken: jest.fn() };
      const mockVideoInstance = { generateUserToken: jest.fn() };

      mockStreamChatGetInstance.mockReturnValue(mockChatInstance);
      mockStreamClientConstructor.mockImplementation(() => mockVideoInstance);

      const {
        getStreamChatClient,
        getStreamVideoClient,
        resetClients,
        isClientInitialized,
      } = await import("@/lib/stream-client");

      // Initialize clients
      resetClients();
      getStreamChatClient();
      getStreamVideoClient();

      expect(isClientInitialized()).toBe(true);

      // Reset and check
      resetClients();
      expect(isClientInitialized()).toBe(false);
    });
  });
});

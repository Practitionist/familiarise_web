/**
 * @jest-environment node
 */

const mockGetSession = jest.fn();
const mockCheckConsent = jest.fn();
const mockRevokeUserToken = jest.fn();
const mockUpsertUser = jest.fn();
const mockUpsertUsers = jest.fn();
const mockQueryChannels = jest.fn();
const mockDeleteChannels = jest.fn();
const mockChannelRemoveMembers = jest.fn();

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  organization: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
  membership: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
  webinar: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
  class: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
  consultation: {
    findMany: jest.fn(),
  },
  subscription: {
    findMany: jest.fn(),
  },
  appointment: {
    findMany: jest.fn(),
  },
  meeting: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
  recording: {
    findMany: jest.fn(),
  },
  orgAuditLog: {
    findFirst: jest.fn(),
    create: jest.fn(),
  },
};

jest.mock("../../lib/auth-server", () => ({
  getSession: () => mockGetSession(),
}));

jest.mock("../../lib/auth-helpers", () => ({
  isPrivileged: (role?: string | null) => role === "ADMIN" || role === "STAFF",
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: mockPrisma,
}));

jest.mock("../../lib/compliance/dpdp", () => ({
  checkConsent: (...args: unknown[]) => mockCheckConsent(...args),
  requireConsent: jest.fn().mockResolvedValue(undefined),
  ConsentRequiredError: class ConsentRequiredError extends Error {},
}));

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => true,
  isStreamVideoConfigured: () => false,
  generateVideoToken: () => "video-token-123",
  generateChatToken: () => "chat-token-123",
  withStreamCircuitBreaker: <T>(fn: () => Promise<T>) => fn(),
  StreamUnavailableError: class StreamUnavailableError extends Error {},
  isExpectedStreamError: () => false,
  getStreamChatClient: () => ({
    upsertUser: (...args: unknown[]) => mockUpsertUser(...args),
    upsertUsers: (...args: unknown[]) => mockUpsertUsers(...args),
    queryChannels: (...args: unknown[]) => mockQueryChannels(...args),
    deleteChannels: (...args: unknown[]) => mockDeleteChannels(...args),
    revokeUserToken: (...args: unknown[]) => mockRevokeUserToken(...args),
    channel: (_type: string, id: string) => ({
      id,
      removeMembers: (...args: unknown[]) => mockChannelRemoveMembers(...args),
      updatePartial: jest.fn().mockResolvedValue({}),
      sendMessage: jest.fn().mockResolvedValue({}),
    }),
  }),
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _opts: unknown, fn: () => unknown) => fn(),
}));

describe("Stream security, consent gates, and organization boundaries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckConsent.mockResolvedValue(true);
    mockUpsertUser.mockResolvedValue({
      users: {
        "target-u1": {
          id: "target-u1",
          name: "Target User",
          email: "leak@example.com",
          role: "user",
        },
      },
    });
    mockUpsertUsers.mockResolvedValue({ users: {} });
    mockQueryChannels.mockResolvedValue([]);
    mockDeleteChannels.mockResolvedValue({});
    mockRevokeUserToken.mockResolvedValue(undefined);
    mockChannelRemoveMembers.mockResolvedValue({});
    mockPrisma.webinar.findFirst.mockResolvedValue(null);
    mockPrisma.webinar.findMany.mockResolvedValue([]);
    mockPrisma.class.findFirst.mockResolvedValue(null);
    mockPrisma.class.findMany.mockResolvedValue([]);
    mockPrisma.consultation.findMany.mockResolvedValue([]);
    mockPrisma.subscription.findMany.mockResolvedValue([]);
    mockPrisma.appointment.findMany.mockResolvedValue([]);
    mockPrisma.meeting.findMany.mockResolvedValue([]);
    mockPrisma.recording.findMany.mockResolvedValue([]);
    mockPrisma.membership.findMany.mockResolvedValue([]);
    mockPrisma.organization.findMany.mockResolvedValue([]);
    mockPrisma.orgAuditLog.findFirst.mockResolvedValue(null);
    mockPrisma.orgAuditLog.create.mockResolvedValue({});
  });

  describe("upsertUserToStream session guard and email stripping", () => {
    it("rejects unauthenticated upsertUserToStream calls when not serverTrusted", async () => {
      mockGetSession.mockResolvedValueOnce(null);

      const { upsertUserToStream } =
        await import("../../actions/stream/chat/user.action");

      await expect(upsertUserToStream("victim-id")).rejects.toThrow(
        "Unauthorized: sign in to sync Stream user",
      );
      expect(mockUpsertUser).not.toHaveBeenCalled();
    });

    it("rejects non-privileged direct callers attempting to sync another user", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "caller-1", role: "CONSULTEE" },
      });

      const { upsertUserToStream } =
        await import("../../actions/stream/chat/user.action");

      await expect(upsertUserToStream("victim-id")).rejects.toThrow(
        "Forbidden: cannot sync another user to Stream",
      );
      expect(mockUpsertUser).not.toHaveBeenCalled();
    });

    it("allows trusted server callers via STREAM_SERVER_TRUSTED and strips email from response", async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: "target-u1",
        name: "Target User",
        email: "secret@example.com",
        image: null,
        role: "CONSULTANT",
        deletedAt: null,
        deactivatedAt: null,
      });

      const { upsertUserToStream } =
        await import("../../actions/stream/chat/user.action");
      const { STREAM_SERVER_TRUSTED } =
        await import("../../lib/stream/event-channel-service");

      const response = await upsertUserToStream("target-u1", {
        serverTrusted: STREAM_SERVER_TRUSTED,
      });
      expect(mockUpsertUser).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "target-u1",
          name: "Target User",
        }),
      );
      const returnedUsers = (
        response as { users?: Record<string, Record<string, unknown>> }
      )?.users;
      expect("email" in (returnedUsers?.["target-u1"] ?? {})).toBe(false);
    });
  });

  describe("event-channel.action session authorization", () => {
    it("refuses unauthenticated addUserToEventChannel server action calls", async () => {
      mockGetSession.mockResolvedValueOnce(null);

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      const result = await addUserToEventChannel("webinar", "web-1", "u-1");
      expect(result.success).toBe(false);
      expect(result.refusal).toEqual(
        expect.objectContaining({
          code: "UNAUTHENTICATED",
        }),
      );
    });

    it("rejects self-join addUserToEventChannel when caller is not enrolled in the event", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "stranger-1", role: "CONSULTEE" },
      });
      mockPrisma.webinar.findFirst.mockResolvedValueOnce(null);

      const { addUserToEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(
        addUserToEventChannel("webinar", "web-1", "stranger-1"),
      ).rejects.toThrow("Forbidden: not a participant in this event");
    });

    it("rejects non-host/non-self removeUserFromEventChannel calls and allows event host", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "stranger-1", role: "CONSULTEE" },
      });
      mockPrisma.webinar.findUnique.mockResolvedValueOnce({
        webinarPlan: {
          title: "Security Webinar",
          consultantProfile: { user: { id: "host-1" } },
          collaborators: [],
        },
        appointment: { participants: [] },
      });

      const { removeUserFromEventChannel } =
        await import("../../actions/stream/chat/event-channel.action");

      await expect(
        removeUserFromEventChannel("webinar", "web-1", "victim-1"),
      ).rejects.toThrow("Forbidden");

      mockGetSession.mockResolvedValueOnce({
        user: { id: "host-1", role: "CONSULTANT" },
      });
      mockPrisma.webinar.findUnique.mockResolvedValueOnce({
        webinarPlan: {
          title: "Security Webinar",
          consultantProfile: { user: { id: "host-1" } },
          collaborators: [],
        },
        appointment: { participants: [] },
      });

      const hostResult = await removeUserFromEventChannel(
        "webinar",
        "web-1",
        "victim-1",
      );
      expect(hostResult.success).toBe(true);
      expect(mockChannelRemoveMembers).toHaveBeenCalledWith(["victim-1"]);
    });
  });

  describe("tokenProvider STREAM_DATA_PROCESSING consent check", () => {
    it("blocks token minting without firing unawaited write side effects when STREAM_DATA_PROCESSING consent is missing", async () => {
      mockGetSession.mockResolvedValueOnce({
        user: { id: "user-no-consent", role: "CONSULTEE" },
      });
      mockCheckConsent.mockResolvedValueOnce(false);

      const { tokenProvider } =
        await import("../../actions/stream/chat/stream.action");

      const result = await tokenProvider("user-no-consent");
      expect(result).toEqual(
        expect.objectContaining({
          ok: false,
          refusal: expect.objectContaining({ code: "CONSENT_REQUIRED" }),
        }),
      );
      expect(mockRevokeUserToken).not.toHaveBeenCalled();
    });
  });

  describe("Enterprise organization Stream revocation and wind-down", () => {
    it("revokes org-scoped channels on member removal without revoking global user token", async () => {
      mockPrisma.webinar.findMany.mockResolvedValueOnce([{ id: "web-org-1" }]);

      const { revokeMemberStreamAccess } =
        await import("../../lib/enterprise/member-removal");

      const res = await revokeMemberStreamAccess({
        orgId: "org123456789",
        userId: "u1",
      });
      expect(res.complete).toBe(true);
      expect(res.tokenRevoked).toBe(false);
      expect(res.channelsRemoved).toBe(1);
      expect(mockChannelRemoveMembers).toHaveBeenCalledWith(["u1"]);
      expect(mockRevokeUserToken).not.toHaveBeenCalled();
    });

    it("winds down deactivated organizations and freezes event channels without revoking member global tokens", async () => {
      mockPrisma.organization.findMany.mockResolvedValueOnce([
        {
          id: "org-winddown-1",
          deletedAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-01T00:00:00Z"),
          streamRecordingRetentionDays: 30,
        },
      ]);
      mockPrisma.webinar.findMany.mockResolvedValueOnce([{ id: "web-org-1" }]);
      mockPrisma.webinar.updateMany.mockResolvedValueOnce({ count: 1 });

      const { windDownDeactivatedOrgs } =
        await import("../../jobs/stream/wind-down-deactivated-orgs");

      const summary = await windDownDeactivatedOrgs();
      expect(summary.orgsScanned).toBe(1);
      expect(summary.eventChannelsFrozen).toBe(1);
      expect(mockRevokeUserToken).not.toHaveBeenCalled();
    });
  });

  describe("Rate-limit pacing constants", () => {
    it("enforces 10_000ms pacing on deleteChannels and deleteUsers batches", async () => {
      const { DELETE_CHANNELS_PACING_MS } =
        await import("../../jobs/stream/expire-event-channels");
      const { DELETE_USERS_PACING_MS } =
        await import("../../scripts/stream/stream-sync");

      expect(DELETE_CHANNELS_PACING_MS).toBe(10_000);
      expect(DELETE_USERS_PACING_MS).toBe(10_000);
    });
  });

  describe("Enterprise org scoping for chat search routes", () => {
    it("builds org-scoped and personal-scoped Prisma filters from searchParams", async () => {
      const { buildBookingOrgScopeWhere } =
        await import("../../lib/stream/event-channel-service");

      const orgParams = new URLSearchParams("q=test&scope=org:org-acme");
      expect(buildBookingOrgScopeWhere(orgParams, "consultationPlan")).toEqual({
        OR: [
          { appointment: { organizationId: "org-acme" } },
          { consultationPlan: { organizationId: "org-acme" } },
        ],
      });

      const personalParams = new URLSearchParams("q=test&scope=personal");
      expect(buildBookingOrgScopeWhere(personalParams, "webinarPlan")).toEqual({
        webinarPlan: { organizationId: null },
        OR: [
          { appointment: { is: null } },
          { appointment: { organizationId: null } },
        ],
      });

      const defaultParams = new URLSearchParams("q=test");
      expect(
        buildBookingOrgScopeWhere(defaultParams, "subscriptionPlan"),
      ).toBeUndefined();
    });
  });
});
